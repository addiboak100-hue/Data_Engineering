"""Train, evaluate and forecast.

    python -m src.train_predict                    # backtest every coin, save metrics
    python -m src.train_predict --coins bitcoin    # just one coin
    python -m src.train_predict --forecast bitcoin --horizon 7   # print a forecast

Backtest results go to data/metrics/<coin>.json; the API serves them on
/api/metrics. Forecasts themselves are made on demand by the API (src/api.py),
always from the latest stored prices.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd

from src import config, db, models

log = logging.getLogger("train_predict")

METRICS_DIR = config.DATA_DIR / "metrics"
HORIZONS = [1, 7, 30]


def available_coins(db_path=config.DB_PATH) -> list[str]:
    """Coins with enough stored history to train on."""
    if not Path(db_path).exists():
        return []
    with db.connect(db_path) as conn:
        counts = {coin: n for coin, n, _first, _last in db.summary(conn)}
    return [c for c in config.COINS if counts.get(c, 0) >= models.MIN_TRAIN_DAYS]


# ---- forecasting -----------------------------------------------------------

_cache: dict[tuple, models.Forecast] = {}
_cache_lock = threading.Lock()
MAX_HORIZON = max(HORIZONS)


def forecast(coin: str, horizon: int, *, today: date | None = None, db_path=config.DB_PATH) -> dict:
    """Forecast `horizon` days after today. Returns the /api/predict response body."""
    if horizon not in HORIZONS:
        raise ValueError(f"horizon must be one of {HORIZONS}")
    today = today or datetime.now(timezone.utc).date()
    history = db.load_prices(coin, db_path)
    if len(history) < models.MIN_TRAIN_DAYS:
        raise LookupError(f"not enough stored history for {coin}; run python -m src.update_prices")
    last_ds = history["ds"].max()

    # The newest stored day is usually yesterday. Forecast through today, then
    # keep only days after today so every returned point is in the future.
    gap = max(0, (today - last_ds.date()).days)
    periods = gap + MAX_HORIZON

    # One fit per coin per data day serves all horizons.
    key = (str(db_path), coin, last_ds, today)
    with _cache_lock:
        fc = _cache.get(key)
        if fc is None:
            fc = models.fit_and_forecast(history, periods=periods)
            if len(_cache) > 64:
                _cache.clear()
            _cache[key] = fc

    future = fc.frame[fc.frame["ds"].dt.date > today].head(horizon)
    last = history.iloc[-1]
    return {
        "coin_id": coin,
        "horizon_days": horizon,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "interval_width": models.INTERVAL_WIDTH,
        "model": {**models.model_info(), "trained_at": fc.fitted_at},
        "data_through": fc.trained_through.strftime("%Y-%m-%d"),
        "last_observed": {"date": last["ds"].strftime("%Y-%m-%d"), "price": float(last["y"])},
        "forecast": [
            {
                "date": r.ds.strftime("%Y-%m-%d"),
                "yhat": round(float(r.yhat), 8),
                "yhat_lower": round(float(r.yhat_lower), 8),
                "yhat_upper": round(float(r.yhat_upper), 8),
            }
            for r in future.itertuples(index=False)
        ],
    }


# ---- evaluation ------------------------------------------------------------

def evaluate(coin: str, *, db_path=config.DB_PATH, out_dir: Path | None = None) -> dict:
    """Backtest one coin, write data/metrics/<coin>.json and log a metrics_history row."""
    out_dir = out_dir or METRICS_DIR
    history = db.load_prices(coin, db_path)
    bt = models.backtest(history)
    m = models.error_metrics(bt["actual"], bt["predicted"])
    naive = models.error_metrics(bt["actual"], bt["naive"])
    coverage = models.interval_coverage(bt["actual"], bt["lower"], bt["upper"])
    now = datetime.now(timezone.utc)
    result = {
        "coin_id": coin,
        **m,
        "coverage": coverage,
        "interval_width": models.INTERVAL_WIDTH,
        "baseline": {"name": "Last price carried forward", **naive},
        "evaluated_at": now.isoformat(timespec="seconds"),
        "method": "Rolling origin: 8 blocks of 7 days, model refit before each block on prior data only",
        "window": {"start": bt["ds"].min().strftime("%Y-%m-%d"), "end": bt["ds"].max().strftime("%Y-%m-%d")},
        "model": models.model_info(),
        "backtest": [
            {
                "date": r.ds.strftime("%Y-%m-%d"),
                "actual": r.actual,
                "predicted": r.predicted,
                "lower": r.lower,
                "upper": r.upper,
                "step_ahead": int(r.step_ahead),
            }
            for r in bt.itertuples(index=False)
        ],
    }
    # Keep the live track record (written by the pipeline) when re-running a backtest.
    previous = read_metrics(coin, out_dir)
    if previous and "live" in previous:
        result["live"] = previous["live"]
    write_metrics(coin, result, out_dir)

    with db.connect(db_path) as conn:
        db.upsert_metrics(conn, {
            "run_date": now.date().isoformat(), "coin_id": coin, "kind": "backtest", "n": len(bt),
            "mae": m["mae"], "rmse": m["rmse"], "mape": m["mape"], "naive_mape": naive["mape"], "coverage": coverage,
        })
    return result


def write_metrics(coin: str, payload: dict, out_dir: Path | None = None) -> None:
    """Write atomically, so the API never serves a half-written file."""
    out_dir = out_dir or METRICS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / f".{coin}.json.tmp"
    tmp.write_text(json.dumps(payload, indent=1))
    os.replace(tmp, out_dir / f"{coin}.json")


def read_metrics(coin: str, out_dir: Path | None = None) -> dict | None:
    if coin not in config.COINS:  # also blocks path tricks like "../x"
        return None
    path = (out_dir or METRICS_DIR) / f"{coin}.json"
    return json.loads(path.read_text()) if path.exists() else None


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Backtest the forecast model, or print a forecast")
    p.add_argument("--coins", nargs="+", help="coins to evaluate (default: all with enough data)")
    p.add_argument("--forecast", metavar="COIN", help="print a forecast for one coin instead of evaluating")
    p.add_argument("--horizon", type=int, default=7, choices=HORIZONS)
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.forecast:
        body = forecast(args.forecast, args.horizon)
        print(f"{args.forecast}: last close {body['last_observed']['price']:,.2f} on {body['last_observed']['date']}")
        for r in body["forecast"]:
            print(f"  {r['date']}  {r['yhat']:>14,.2f}   80%: {r['yhat_lower']:,.2f} – {r['yhat_upper']:,.2f}")
        return 0

    coins = args.coins or available_coins()
    if not coins:
        log.error("No stored prices yet. Run: python -m src.update_prices")
        return 1
    log.info("%-12s %10s %10s %8s %12s %10s", "coin", "MAE", "RMSE", "MAPE", "naive MAPE", "80% band")
    failed = []
    for coin in coins:
        try:
            r = evaluate(coin)
        except Exception as exc:  # keep going for the other coins
            log.error("%-12s failed: %s", coin, exc)
            failed.append(coin)
            continue
        log.info("%-12s %10.2f %10.2f %7.2f%% %11.2f%% %9.0f%%", coin, r["mae"], r["rmse"], r["mape"], r["baseline"]["mape"], r["coverage"] * 100)
    log.info("Metrics written to %s", METRICS_DIR)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
