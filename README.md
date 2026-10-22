# Sibyl: crypto price forecasting

Daily crypto prices from CoinGecko, a Prophet time-series model with uncertainty
intervals and an out-of-sample backtest, served over a small HTTP API to a web
dashboard.

```
CoinGecko ──► src/update_prices.py ──► data/prices.db ──► src/models.py (Prophet)
                                                              │
                         frontend/ ◄── src/api.py ◄───────────┘
                                         ▲
                     src/train_predict.py (backtest → data/metrics/*.json)
```

## Quick start

Python 3.9–3.12 recommended (Prophet ships wheels for these).

```bash
pip install requests python-dotenv pandas prophet

# 1. Optional: a free CoinGecko Demo key raises the rate limit
#    Put COINGECKO_KEY=... in .env (see .env.example)

# 2. Download the last 365 days of prices (incremental on later runs)
python -m src.update_prices

# 3. Backtest the model for every coin (a minute or two)
python -m src.train_predict

# 4. Start the API on http://localhost:8000
python -m src.api

# 5. In a second terminal, serve the dashboard on http://localhost:5173
python -m http.server 5173 -d frontend
```

Print a forecast in the terminal without the UI:

```bash
python -m src.train_predict --forecast bitcoin --horizon 7
```

## Data pipeline

A daily pipeline keeps everything current and builds a real track record:

```
fetch_prices ─► validate_prices ─┬─► record_forecasts ─┬─► score_forecasts
                                 └─► run_backtest ─────┘
```

| Step | What it does | Writes |
|---|---|---|
| **fetch** | Incremental CoinGecko download (only missing days) | `prices` |
| **validate** | Stops the run on stale data, missing days or impossible prices; warns on >50% daily jumps | nothing (gate) |
| **forecast** | Stores a 30-day forecast per coin, kept forever | `forecasts` |
| **backtest** | Rolling-origin backtest: error, naive baseline, 80% band hit rate | `data/metrics/*.json`, `metrics_history` |
| **score** | Scores stored forecasts whose day has arrived against the real price | `live` block in metrics JSON, `metrics_history` |

Every write is an upsert keyed on coin and date, so re-running any step is safe.
The dashboard's **Model Insights** page shows the live track record once the first forecasts mature.

### Run it with Airflow (Docker)

```bash
docker compose -f docker-compose.airflow.yml up --build
```

Open <http://localhost:8080>. The `crypto_forecast_pipeline` DAG runs daily at 00:37 UTC (after CoinGecko publishes the previous day); use **Trigger** to run it now. The container mounts `src/`, `dags/` and `data/`, so it updates the same database the API reads. Login is disabled for local use, so don't expose port 8080.

### Run it without Airflow

```bash
python -m src.pipeline                      # all steps in order
python -m src.pipeline --steps fetch validate
```

## How the model works

- **Data:** one price per coin per day (CoinGecko's 00:00 UTC snapshot), the last 365 days, stored in SQLite.
- **Model:** [Prophet](https://facebook.github.io/prophet/) fit on log prices, so intervals stay positive and moves are treated proportionally. Weekly seasonality on; yearly off (one year of data can't support it); 80% uncertainty interval.
- **Anchoring:** Prophet's fitted trend can sit several percent from the actual last close, so forecasts are shifted to start from the real last price. Prophet then contributes the projected drift and the uncertainty band.
- **Forecasts:** made on demand for 1, 7 or 30 days after today, refit at most once per coin per day.
- **Evaluation:** rolling-origin backtest over the last 56 days. The test period is cut into 7-day blocks; before each block the model is refit on earlier data only, then forecasts the block. Reported as MAE, RMSE and MAPE, next to a naive "price stays the same" baseline scored the same way.

### Limitations

Prices alone don't capture news, regulation or liquidity shocks, and crypto moves fall outside an 80% interval more often than 20% of the time. Treat forecasts as a statistical estimate, not advice.

## Tests

```bash
python -m unittest discover tests          # backend: fetcher, model, API, pipeline, DAG (no network, no Prophet needed)
cd frontend && node --test tests/*.test.mjs  # frontend logic
```

## Project layout

| Path | What it is |
|---|---|
| `src/update_prices.py` | CoinGecko fetcher with retries and incremental updates |
| `src/db.py` | SQLite storage; `load_prices()` returns Prophet-ready `ds`/`y` frames |
| `src/models.py` | Prophet wrapper, backtest, error metrics |
| `src/train_predict.py` | Evaluation CLI and the forecast function the API uses |
| `src/api.py` | HTTP API, see `docs/api-contract.md` |
| `src/pipeline.py` | Pipeline steps: fetch, validate, forecast, backtest, score |
| `dags/crypto_pipeline.py` | Airflow DAG wrapping the pipeline steps |
| `docker-compose.airflow.yml`, `docker/airflow/` | Airflow 3 in Docker, with Prophet installed |
| `frontend/` | Dashboard (no build step), see `frontend/README.md` |
| `.github/workflows/update.yml` | Daily price refresh on GitHub Actions |
