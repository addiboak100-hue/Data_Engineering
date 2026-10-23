import { modelApi } from "../api/model.js";
import { getState, subscribe } from "../store.js";

export function mountAbout(view) {
  view.innerHTML = `
    <div class="page">
      <header class="page-intro">
        <h1>About Sibyl</h1>
        <p>Sibyl forecasts crypto prices with a time-series model and shows those forecasts next to live market data, together with how accurate the model has been.</p>
      </header>

      <section aria-labelledby="pipe-title">
        <h2 class="section-title" id="pipe-title">How a forecast is made</h2>
        <ol class="pipeline">
          <li><h3>Collect prices</h3><p>Daily prices are pulled from CoinGecko and refreshed on a schedule by a GitHub Actions workflow.</p><span class="file">src/update_prices.py</span></li>
          <li><h3>Store history</h3><p>Price history is stored so training never depends on a live API call.</p><span class="file">src/db.py</span></li>
          <li><h3>Train and forecast</h3><p>A Prophet model is fit per coin and projects the next days with an uncertainty interval.</p><span class="file">src/train_predict.py, src/models.py</span></li>
          <li><h3>Serve</h3><p>A small HTTP API exposes forecasts, supported coins and backtest metrics.</p><span class="file" id="svc-status"></span></li>
          <li><h3>Explore</h3><p>This interface combines live CoinGecko prices with the model's output.</p><span class="file">frontend/</span></li>
        </ol>
      </section>

      <div class="two-col">
        <section class="prose">
          <h2>The model</h2>
          <p>The project uses <strong>Prophet</strong>, an additive time-series model. It splits a price series into a long-run trend that can bend at changepoints, plus repeating weekly and yearly patterns, and fits those parts to daily closes.</p>
          <p>For each future day it returns a central estimate and a lower and upper bound. The bounds come from simulating how the trend might shift, so they widen the further out you forecast. Prophet's default band covers 80% of simulated outcomes.</p>
          <h2>Limitations</h2>
          <ul>
            <li>It sees only past prices. News, regulation, liquidity and on-chain activity aren't inputs.</li>
            <li>Crypto has fat tails: real moves fall outside the interval more often than its stated coverage suggests.</li>
            <li>Weekly and yearly patterns in crypto are weak, so most of the signal is trend.</li>
            <li>Backtest accuracy is measured on past data and doesn't guarantee future accuracy.</li>
          </ul>
        </section>
        <section class="prose">
          <h2>Data and indicators</h2>
          <p>Prices, 24-hour change, market cap, volume and history come from the public CoinGecko API, requested directly by your browser. No API key is used in the frontend; keys in <code class="code">.env</code> stay on the backend.</p>
          <p>Moving averages, RSI, volatility and drawdown on the Market Analysis page are calculated in the browser from CoinGecko daily closes. They describe the market and aren't used by the model.</p>
          <h2>Stack</h2>
          <ul>
            <li><strong>Model and data:</strong> Python, pandas, Prophet</li>
            <li><strong>Interface:</strong> HTML, CSS and JavaScript modules with hand-built SVG charts, no build step</li>
            <li><strong>Contract:</strong> the API the interface expects is documented in <code class="code">docs/api-contract.md</code></li>
          </ul>
          <h2>Disclaimer</h2>
          <p>This is a portfolio project. Forecasts are statistical estimates and not financial advice.</p>
        </section>
      </div>
    </div>`;

  const svc = view.querySelector("#svc-status");
  const render = () => {
    const m = getState().model;
    if (modelApi.isStatic) {
      svc.textContent = m.status === "online" ? "Published daily as static files" : m.status === "checking" ? "Checking…" : "No published forecasts yet";
      return;
    }
    svc.textContent = m.status === "online" ? `Online at ${modelApi.base}` : m.status === "checking" ? "Checking service…" : `Offline, expected at ${modelApi.base}`;
  };
  render();
  return subscribe((_, c) => c === "model" && render());
}

