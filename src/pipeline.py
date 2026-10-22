"""Daily data pipeline: fetch → validate → forecast → backtest → score.

Each step is a plain function so it can be tested and run without Airflow.
The Airflow DAG (dags/crypto_pipeline.py) calls these same functions as
separate tasks. Without Airflow:

    python -m src.pipeline                 # run every step in order
    python -m src.pipeline --steps validate score

Every step is idempotent: running it twice for the same day upserts the same
rows, so retries and re-runs are safe.

Steps
  fetch      incremental CoinGecko download into `prices`
  validate   data-quality gate; raises (stops the run) on stale, missing or
             impossible data, so bad data never reaches the model
  forecast   stores a 30-day forecast per coin into `forecasts` (kept forever)
  backtest   rolling-origin backtest per coin → data/metrics + metrics_history
  score      compares stored forecasts whose day has arrived with real prices:
             live MAPE, naive MAPE, and how often the 80% band held the price
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

import pandas as pd

from src import config, db, models, train_predict, update_prices

log = logging.getLogger("pipeline")

FORECAST_DAYS = 30
MAX_DAILY_MOVE = 0.5  # a >50% day-over-day move is flagged as suspicious, not fatal


class DataQualityError(RuntimeError):
    """Raised by validate() when the data must not be used."""


@dataclass
class ValidationReport:
    checked: dict = field(default_factory=dict)  # coin -> rows checked
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def _today(today: date | None) -> date:
    return today or datetime.now(timezone.utc).date()


# ---- 1. fetch ---------------------------------------------------------------

def fetch(coins=None, *, db_path=config.DB_PATH) -> dict:
    """Incremental download. Raises if every coin failed (nothing to work with)."""
    results = update_prices.update(coins, db_path=db_path)
    failed = {c: r for c, r in results.items() if isinstance(r, str)}
    if failed and len(failed) == len(results):
        raise RuntimeError(f"fetch failed for every coin: {failed}")
    for coin, err in failed.items():
        log.warning("fetch failed for %s: %s", coin, err)
    return results


# ---- 2. validate ------------------------------------------------------------

def validate(coins=None, *, db_path=config.DB_PATH, today: date | None = None, max_staleness_days: int = 2) -> ValidationReport:
    """Check every coin's stored history before it is used.

    Errors (stop the pipeline):
      - fewer days than the model needs
      - newest day older than `max_staleness_days` (the fetch silently failed)
      - missing days inside the history
      - zero, negative or non-numeric prices
    Warnings (logged, run continues):
      - a day-over-day move larger than 50%, which is usually a data glitch
    """
    today = _today(today)
    report = ValidationReport()
    for coin in coins or config.COINS:
        df = db.load_prices(coin, db_path)
        report.checked[coin] = len(df)
        if len(df) < models.MIN_TRAIN_DAYS:
            report.errors.append(f"{coin}: only {len(df)} days stored, need {models.MIN_TRAIN_DAYS}")
            continue
        last = df["ds"].max().date()
        if (today - last).days > max_staleness_days:
            report.errors.append(f"{coin}: newest price is {last}, more than {max_staleness_days} days old")
        expected = pd.date_range(df["ds"].min(), df["ds"].max(), freq="D")
        missing = expected.difference(df["ds"])
        if len(missing):
            sample = ", ".join(d.strftime("%Y-%m-%d") for d in missing[:3])
            report.errors.append(f"{coin}: {len(missing)} missing day(s), e.g. {sample}")
        bad = df[~(pd.to_numeric(df["y"], errors="coerce") > 0)]
        if len(bad):
            report.errors.append(f"{coin}: {len(bad)} non-positive or invalid price(s)")
        moves = df["y"].pct_change().abs()
        jumps = df.loc[moves > MAX_DAILY_MOVE, "ds"]
        for d in jumps:
            report.warnings.append(f"{coin}: price moved more than {MAX_DAILY_MOVE:.0%} on {d.date()}")

    for w in report.warnings:
        log.warning("validate: %s", w)
    if not report.ok:
        raise DataQualityError("; ".join(report.errors))
    log.info("validate: %d coins passed", len(report.checked))
    return report


# ---- 3. forecast ------------------------------------------------------------

def record_forecasts(coins=None, *, db_path=config.DB_PATH, days: int = FORECAST_DAYS) -> dict:
    """Fit each coin on all stored data and save the next `days` days.

    The forecast is keyed on `as_of` (the last observed day), so running this
    again on the same data replaces it rather than adding a duplicate.
    """
    created = datetime.now(timezone.utc).isoformat(timespec="seconds")
    info = models.model_info()
    model_name = f"{info['name']} {info['version']}".strip() if info.get("version") else info["name"]
    written = {}
    for coin in coins or train_predict.available_coins(db_path):
        history = db.load_prices(coin, db_path)
        fc = models.fit_and_forecast(history, periods=days)
        as_of = history["ds"].max()
        last_price = float(history["y"].iloc[-1])
        rows = [
            {
                "coin_id": coin,
                "as_of": as_of.strftime("%Y-%m-%d"),
                "target_date": r.ds.strftime("%Y-%m-%d"),
                "horizon": int((r.ds - as_of).days),
                "yhat": float(r.yhat),
                "yhat_lower": float(r.yhat_lower),
                "yhat_upper": float(r.yhat_upper),
                "last_price": last_price,
                "model": model_name,
                "created_at": created,
            }
            for r in fc.frame.itertuples(index=False)
        ]
        with db.connect(db_path) as conn:
            written[coin] = db.upsert_forecasts(conn, rows)
        log.info("forecast: %-12s %d days stored (as of %s)", coin, written[coin], as_of.date())
    return written


# ---- 4. backtest ------------------------------------------------------------

def backtest(coins=None, *, db_path=config.DB_PATH) -> dict:
    out = {}
    for coin in coins or train_predict.available_coins(db_path):
        r = train_predict.evaluate(coin, db_path=db_path)
        out[coin] = {"mape": r["mape"], "naive_mape": r["baseline"]["mape"], "coverage": r["coverage"]}
        log.info("backtest: %-12s MAPE %.2f%% (naive %.2f%%), 80%% band held %.0f%%",
                 coin, r["mape"], r["baseline"]["mape"], r["coverage"] * 100)
    return out


# ---- 5. score ---------------------------------------------------------------

def live_metrics(rows: list[tuple]) -> dict:
    """Accuracy of real, previously stored forecasts. `rows` from db.matured_forecasts()."""
    if not rows:
        return {"n": 0, "mae": None, "rmse": None, "mape": None, "naive_mape": None, "coverage": None,
                "by_horizon": [], "first_target": None, "last_target": None}
    df = pd.DataFrame(rows, columns=["as_of", "target_date", "horizon", "yhat", "lo", "hi", "last_price", "actual"])
    m = models.error_metrics(df["actual"], df["yhat"])
    naive = models.error_metrics(df["actual"], df["last_price"])
    by_h = []
    for label, lo_h, hi_h in (("1 day", 1, 1), ("2–7 days", 2, 7), ("8–30 days", 8, 30)):
        part = df[(df["horizon"] >= lo_h) & (df["horizon"] <= hi_h)]
        if len(part):
            by_h.append({
                "label": label,
                "n": int(len(part)),
                "mape": models.error_metrics(part["actual"], part["yhat"])["mape"],
                "naive_mape": models.error_metrics(part["actual"], part["last_price"])["mape"],
                "coverage": models.interval_coverage(part["actual"], part["lo"], part["hi"]),
            })
    return {
        "n": int(len(df)),
        **m,
        "naive_mape": naive["mape"],
        "coverage": models.interval_coverage(df["actual"], df["lo"], df["hi"]),
        "by_horizon": by_h,
        "first_target": df["target_date"].min(),
        "last_target": df["target_date"].max(),
    }


def score(coins=None, *, db_path=config.DB_PATH, today: date | None = None) -> dict:
    """Score matured forecasts, log a 'live' metrics_history row, and add a
    `live` block to each coin's metrics JSON for the dashboard."""
    run_date = _today(today).isoformat()
    out = {}
    for coin in coins or train_predict.available_coins(db_path):
        with db.connect(db_path) as conn:
            live = live_metrics(db.matured_forecasts(conn, coin))
            db.upsert_metrics(conn, {
                "run_date": run_date, "coin_id": coin, "kind": "live", "n": live["n"], "mae": live["mae"],
                "rmse": live["rmse"], "mape": live["mape"], "naive_mape": live["naive_mape"], "coverage": live["coverage"],
            })
        metrics = train_predict.read_metrics(coin)
        if metrics is not None:
            metrics["live"] = {**live, "scored_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
            train_predict.write_metrics(coin, metrics)
        out[coin] = live
        if live["n"]:
            log.info("score: %-12s %d live predictions, MAPE %.2f%% (naive %.2f%%), band held %.0f%%",
                     coin, live["n"], live["mape"], live["naive_mape"], live["coverage"] * 100)
        else:
            log.info("score: %-12s no forecasts have matured yet", coin)
    return out


# ---- runner -----------------------------------------------------------------

STEPS = {
    "fetch": fetch,
    "validate": validate,
    "forecast": record_forecasts,
    "backtest": backtest,
    "score": score,
}


def run(steps=None) -> None:
    for name in steps or STEPS:
        log.info("── %s", name)
        STEPS[name]()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Run the crypto pipeline without Airflow")
    p.add_argument("--steps", nargs="+", choices=list(STEPS), help="steps to run, in order (default: all)")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        run(args.steps)
    except DataQualityError as exc:
        log.error("Stopped: data failed validation: %s", exc)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
