"""Forecasting model: Prophet on log prices, plus an honest backtest.

Prophet is fit on log(price) so forecasts and intervals stay positive and
percentage moves are treated alike at any price level. Outputs are converted
back to USD.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

import numpy as np
import pandas as pd

INTERVAL_WIDTH = 0.8  # Prophet's default; the UI labels the band "80% interval"
MIN_TRAIN_DAYS = 120  # below this a fit isn't meaningful


def make_prophet():
    """Default model factory. Imported lazily so the rest of the project works without Prophet."""
    from prophet import Prophet

    logging.getLogger("cmdstanpy").setLevel(logging.WARNING)
    logging.getLogger("prophet").setLevel(logging.WARNING)
    return Prophet(
        interval_width=INTERVAL_WIDTH,
        daily_seasonality=False,  # one observation per day: nothing to learn intraday
        weekly_seasonality=True,
        yearly_seasonality=False,  # needs more than the ~1 year the free API provides
        changepoint_prior_scale=0.05,
    )


def model_info() -> dict:
    try:
        import prophet

        return {"name": "Prophet", "version": getattr(prophet, "__version__", None)}
    except ImportError:
        return {"name": "Prophet", "version": None}


# Tests replace this with a lightweight stand-in that has the same interface.
MODEL_FACTORY: Callable = make_prophet


@dataclass
class Forecast:
    frame: pd.DataFrame  # ds, yhat, yhat_lower, yhat_upper (USD)
    trained_through: pd.Timestamp
    fitted_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds"))


def fit_and_forecast(history: pd.DataFrame, periods: int, factory: Callable | None = None) -> Forecast:
    """Fit on `history` (columns ds, y in USD) and forecast `periods` days after its last date."""
    if len(history) < MIN_TRAIN_DAYS:
        raise ValueError(f"need at least {MIN_TRAIN_DAYS} days of history, have {len(history)}")
    if periods < 1:
        raise ValueError("periods must be positive")

    train = history[["ds", "y"]].copy()
    train = train[train["y"] > 0]
    train["y"] = np.log(train["y"])

    model = (factory or MODEL_FACTORY)()
    model.fit(train)
    future = model.make_future_dataframe(periods=periods, freq="D", include_history=False)
    out = model.predict(future)[["ds", "yhat", "yhat_lower", "yhat_upper"]].copy()

    # Anchor to the last observed price. Prophet's fitted value on the last
    # training day is a smoothed trend level, which can sit several percent
    # away from the actual close; left alone, every forecast inherits that gap.
    # Shifting by (actual - fitted) keeps Prophet's projected drift and
    # interval width but starts the path from today's real price.
    last_ds = train["ds"].max()
    fitted_last = float(model.predict(pd.DataFrame({"ds": [last_ds]}))["yhat"].iloc[0])
    offset = float(train["y"].iloc[-1]) - fitted_last
    for col in ("yhat", "yhat_lower", "yhat_upper"):
        out[col] = np.exp(out[col] + offset)
    out["ds"] = pd.to_datetime(out["ds"])
    return Forecast(frame=out.reset_index(drop=True), trained_through=last_ds)


def backtest(
    history: pd.DataFrame,
    test_days: int = 56,
    step: int = 7,
    factory: Callable | None = None,
) -> pd.DataFrame:
    """Rolling-origin evaluation on the last `test_days` days.

    The test period is split into blocks of `step` days. For each block the
    model is fit only on data *before* the block, then forecasts the whole
    block (1 to `step` days ahead). Nothing from the block leaks into training.

    Returns rows: ds, actual, predicted, lower, upper, naive (last training
    price), step_ahead (days after the last training day).
    """
    history = history.sort_values("ds").reset_index(drop=True)
    n = len(history)
    if n - test_days < MIN_TRAIN_DAYS:
        raise ValueError(f"need at least {MIN_TRAIN_DAYS + test_days} days for a backtest, have {n}")

    rows = []
    for start in range(n - test_days, n, step):
        train = history.iloc[:start]
        test = history.iloc[start : start + step]
        fc = fit_and_forecast(train, periods=len(test), factory=factory).frame
        merged = test[["ds", "y"]].merge(fc[["ds", "yhat", "yhat_lower", "yhat_upper"]], on="ds", how="inner")
        last_price = float(train["y"].iloc[-1])
        last_ds = train["ds"].iloc[-1]
        for r in merged.itertuples(index=False):
            rows.append({
                "ds": r.ds,
                "actual": float(r.y),
                "predicted": float(r.yhat),
                "lower": float(r.yhat_lower),
                "upper": float(r.yhat_upper),
                "naive": last_price,
                "step_ahead": int((r.ds - last_ds).days),
            })
    return pd.DataFrame(rows)


def error_metrics(actual, predicted) -> dict:
    a = np.asarray(actual, dtype=float)
    p = np.asarray(predicted, dtype=float)
    if a.size == 0:
        return {"mae": None, "rmse": None, "mape": None}
    err = p - a
    return {
        "mae": float(np.mean(np.abs(err))),
        "rmse": float(math.sqrt(np.mean(err**2))),
        "mape": float(np.mean(np.abs(err) / np.abs(a)) * 100),
    }


def interval_coverage(actual, lower, upper) -> float | None:
    """Share (0-1) of actual values that fell inside [lower, upper].

    For a well-calibrated 80% interval this should be close to 0.8. Much lower
    means the model is overconfident; much higher means the band is too wide
    to be useful.
    """
    a = np.asarray(actual, dtype=float)
    if a.size == 0:
        return None
    lo = np.asarray(lower, dtype=float)
    hi = np.asarray(upper, dtype=float)
    return float(np.mean((a >= lo) & (a <= hi)))
