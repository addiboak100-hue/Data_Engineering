# Sibyl frontend

The web interface for the crypto price predictor: live market data from CoinGecko,
model forecasts with uncertainty bands, backtested accuracy and market indicators.

No build step and no npm dependencies. It's plain HTML, CSS and JavaScript modules with
hand-built SVG charts, so it runs anywhere Python does.

## Run it

From the project root:

```bash
python -m http.server 5173 -d frontend
```

Open <http://localhost:5173>. (Opening `index.html` directly from disk won't work, because
browsers block JavaScript modules on `file://`.)

Live prices, history, the markets table and all indicators work immediately.
Forecasts, accuracy metrics and backtests appear once the model service is running at
`http://localhost:8000` and implements [`docs/api-contract.md`](../docs/api-contract.md).
To point at a different address, open `http://localhost:5173/?api=http://host:port`
(remembered in the browser) or edit `js/config.js`.

## Tests

```bash
cd frontend && node --test tests/*.test.mjs
```

Covers formatting, indicator maths and validation of every model-service response.

## What's where

```
frontend/
  index.html                 shell: header, navigation, footer, icon sprite
  styles/app.css             design tokens and all styles
  js/
    config.js                API base URL, coin list, chart ranges
    store.js                 app state, polling, actions
    format.js                currency, percentage, date formatting
    indicators.js            SMA, RSI, volatility, drawdown
    api/http.js              fetch with timeouts and typed errors
    api/market.js            CoinGecko client with caching
    api/model.js             model-service client + response validation
    charts/timeChart.js      SVG time-series chart (crosshair, keyboard, bands, seam)
    components/              forecast chart panel, prediction panel, shared UI
    pages/                   dashboard, predictions, market, model, about
  tests/logic.test.mjs
```

## Honesty rules the code enforces

- A forecast is drawn only from a validated `/api/predict` response. There's no sample or placeholder forecast anywhere.
- The uncertainty band appears only if every forecast point carries a coherent lower and upper bound.
- Metrics the service doesn't report show as "not reported".
- Indicators are labelled as computed in the browser from CoinGecko, not as model inputs.
- No API keys ship to the browser; CoinGecko's public endpoints are used.

## Design notes

- Type: IBM Plex Sans with tabular figures. Background deep navy (`#070a12`).
- Chart colours were checked with a colour-vision-deficiency validator against the panel surface.
  Price history is blue and the forecast violet; that pair is close for protanopes, so the forecast is
  always also dashed, sits in its own hatched region after the "now" seam, and is labelled directly.
- Responsive from phone width up, keyboard navigable (charts read out values with ←/→), and
  respects reduced-motion settings.
