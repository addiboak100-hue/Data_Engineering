"""Airflow DAG for the crypto forecasting pipeline.

    fetch_prices ─► validate_prices ─┬─► record_forecasts ─┬─► score_forecasts
                                     └─► run_backtest ─────┘

Runs daily at 00:37 UTC, after CoinGecko publishes the previous day's close
(about 00:10 UTC). The work lives in src/pipeline.py; each task is a thin call
into it, so the same steps can be run without Airflow:
    python -m src.pipeline

Every task is idempotent (upserts keyed on coin and date), so retries and
manual re-runs are safe. validate_prices fails the run on stale, missing or
impossible data, which stops the model from training on it.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from airflow.sdk import dag, task

default_args = {
    "owner": "crypto-predictor",
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
}


@dag(
    dag_id="crypto_forecast_pipeline",
    description="Fetch CoinGecko prices, validate, forecast, backtest and score live forecasts",
    schedule="37 0 * * *",
    start_date=datetime(2026, 10, 1),
    catchup=False,  # CoinGecko only serves current data, so past runs can't be replayed
    max_active_runs=1,  # one writer at a time for the SQLite database
    default_args=default_args,
    tags=["crypto", "forecasting"],
    doc_md=__doc__,
)
def crypto_forecast_pipeline():
    @task
    def fetch_prices() -> dict:
        from src import pipeline

        results = pipeline.fetch()
        return {coin: (r if isinstance(r, int) else f"error: {r}") for coin, r in results.items()}

    @task
    def validate_prices() -> dict:
        from src import pipeline

        report = pipeline.validate()
        return {"checked": report.checked, "warnings": report.warnings}

    @task
    def record_forecasts() -> dict:
        from src import pipeline

        return pipeline.record_forecasts()

    @task(execution_timeout=timedelta(minutes=30))
    def run_backtest() -> dict:
        from src import pipeline

        return pipeline.backtest()

    @task
    def score_forecasts() -> dict:
        from src import pipeline

        live = pipeline.score()
        return {coin: {"n": m["n"], "mape": m["mape"], "coverage": m["coverage"]} for coin, m in live.items()}

    validated = fetch_prices() >> validate_prices()
    forecasts = record_forecasts()
    backtests = run_backtest()
    validated >> [forecasts, backtests]
    [forecasts, backtests] >> score_forecasts()


crypto_forecast_pipeline()
