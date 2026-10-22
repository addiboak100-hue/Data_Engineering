# Sibyl model service: API contract

The frontend (`frontend/`) talks to the prediction service over four JSON endpoints.
They are implemented in `src/api.py` (standard library only; start it with
`python -m src.api`). If the service isn't running, the UI shows a clear
"Model offline" state and never draws a forecast.

- Default base URL: `http://localhost:8000` (change in `frontend/js/config.js`, or open the app with `?api=http://host:port`).
- All responses are JSON. Errors should use a non-2xx status and `{"detail": "human readable message"}` (FastAPI's default shape); the message is shown to the user.
- **CORS:** the frontend runs on a different port, so the service must allow its origin (e.g. `http://localhost:5173`) for `GET`, `POST` and the `Content-Type` header.
- Dates are ISO 8601 (`"2026-10-23"` or full timestamps). Prices are USD numbers.

The frontend validates every response. A malformed forecast is rejected and reported as an error rather than drawn.

---

## `GET /api/health`

Liveness and model identity. Polled every 30 s while the service is offline.

```json
{
  "status": "ok",
  "model": { "name": "Prophet", "version": "1.1.5", "trained_at": "2026-10-22T06:00:00Z" }
}
```

`status` must be `"ok"`. `version` and `trained_at` are optional.

## `GET /api/coins`

What the model can forecast. The UI only offers these coins and horizons in the prediction panel.

```json
{
  "coins": [
    { "id": "bitcoin", "symbol": "btc", "name": "Bitcoin" },
    { "id": "ethereum", "symbol": "eth", "name": "Ethereum" }
  ],
  "horizons": [1, 7, 30]
}
```

`id` must be the **CoinGecko coin id** so forecasts line up with the live market data.
`horizons` are whole days.

## `POST /api/predict`

Request:

```json
{ "coin_id": "bitcoin", "horizon_days": 7 }
```

Response:

```json
{
  "coin_id": "bitcoin",
  "horizon_days": 7,
  "generated_at": "2026-10-22T17:40:00Z",
  "interval_width": 0.8,
  "model": { "name": "Prophet", "version": "1.1.5", "trained_at": "2026-10-22T06:00:00Z" },
  "last_observed": { "date": "2026-10-22", "price": 67400.12 },
  "forecast": [
    { "date": "2026-10-23", "yhat": 67702.4, "yhat_lower": 66110.0, "yhat_upper": 69290.8 },
    { "date": "2026-10-24", "yhat": 67980.1, "yhat_lower": 65850.3, "yhat_upper": 70120.5 }
  ]
}
```

- `forecast` holds only **future** days, one per day up to `horizon_days`. Required per point: `date`, `yhat`.
- `yhat_lower` / `yhat_upper` are optional. The uncertainty band is drawn only if **every** point has both and `yhat_lower ≤ yhat ≤ yhat_upper`. With Prophet these map directly to the columns of `model.predict(future)`.
- `interval_width` (0–1) labels the band, e.g. "80% interval". Prophet's default is `0.8`.
- `last_observed`, `data_through` and `model.*` beyond `name` are optional.
- The shipped service forecasts the `horizon_days` days **after today (UTC)**, from data through the last completed day.
- The first call may be slow while the model fits; the frontend waits up to 120 s and shows elapsed time.

## `GET /api/metrics?coin_id=bitcoin`

Out-of-sample accuracy for the Model Insights page and dashboard readout.

```json
{
  "coin_id": "bitcoin",
  "mae": 1184.2,
  "rmse": 1592.7,
  "mape": 2.31,
  "evaluated_at": "2026-10-22T06:00:00Z",
  "window": { "start": "2026-08-24", "end": "2026-10-22" },
  "backtest": [
    { "date": "2026-08-24", "actual": 57120.5, "predicted": 57480.2 }
  ]
}
```

- `mae` and `rmse` are in USD; `mape` is a **percentage** (2.31 means 2.31%).
- Any metric you don't compute can be omitted; the UI shows "not reported" instead of inventing it.
- The shipped service also returns `coverage` (share of backtest actuals inside the interval, 0–1) and, once the pipeline has run, a `live` block scoring real stored forecasts: `n`, `mape`, `naive_mape`, `coverage`, `first_target`, `last_target` and `by_horizon` (list of `label`, `n`, `mape`, `naive_mape`, `coverage`).
- The shipped service also returns `baseline` (a "last price carried forward" forecast scored the same way) and `method`, so the model's error can be judged against doing nothing.
- `backtest` must be predictions for days **held out of training** (e.g. a rolling-origin or last-N-days split), otherwise the accuracy shown is misleading.

---

## Porting to FastAPI (optional)

The shipped server needs no extra packages. If you later prefer FastAPI, this is the equivalent shape:

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

class PredictIn(BaseModel):
    coin_id: str
    horizon_days: int

@app.get("/api/health")
def health(): ...

@app.get("/api/coins")
def coins(): ...

@app.post("/api/predict")
def predict(body: PredictIn): ...

@app.get("/api/metrics")
def metrics(coin_id: str): ...
```
