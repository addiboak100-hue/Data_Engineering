import { formatDate, formatPct, formatUsd, pctChange } from "../format.js";
import { coinMeta, currentPrediction, getState, marketRow, subscribe } from "../store.js";
import { mountForecastChart } from "../components/forecastChart.js";
import { mountPredictPanel } from "../components/predictPanel.js";
import { esc } from "../components/ui.js";

export function mountPredictions(view) {
  view.innerHTML = `
    <div class="page">
      <header class="page-intro">
        <h1>Predictions</h1>
        <p>Pick a coin and horizon, run the model, and inspect every forecast day with its uncertainty range.</p>
      </header>
      <section class="stage">
        <div id="chart"></div>
        <aside class="rail"><div id="predict"></div></aside>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Forecast by day</h2><div class="spacer"></div><span class="label" id="tbl-meta"></span></div>
        <div id="tbl"></div>
      </section>
    </div>`;

  const cleanups = [
    mountForecastChart(view.querySelector("#chart"), { height: 460, title: "Forecast detail" }),
    mountPredictPanel(view.querySelector("#predict"), { compact: true }),
  ];
  const tbl = view.querySelector("#tbl");
  const meta = view.querySelector("#tbl-meta");

  function render() {
    const st = getState();
    const pred = currentPrediction();
    const fc = pred?.data && (pred.data.coinId === null || pred.data.coinId === st.coinId) ? pred.data : null;
    if (!fc) {
      meta.textContent = "";
      tbl.innerHTML = `<div class="empty">
        <h3>No forecast yet</h3>
        <p>${st.model.status === "online" ? `Run a forecast for ${esc(coinMeta(st.coinId).name)} and each forecast day appears here.` : "Daily forecast values appear here once the model service is running and a forecast has been made."}</p>
      </div>`;
      return;
    }
    const live = marketRow()?.price;
    meta.textContent = `${fc.points.length} days, ${fc.model.name}`;
    tbl.innerHTML = `<div class="table-wrap"><table class="data num">
      <thead><tr><th scope="col">Date</th><th scope="col">Forecast</th>${fc.hasInterval ? '<th scope="col">Low</th><th scope="col">High</th>' : ""}<th scope="col">vs live price</th></tr></thead>
      <tbody>${fc.points
        .map((p) => {
          const ch = pctChange(live, p.v);
          return `<tr><td>${esc(formatDate(p.t, { weekday: "short", month: "short", day: "numeric" }))}</td><td>${esc(formatUsd(p.v))}</td>${fc.hasInterval ? `<td class="muted">${esc(formatUsd(p.lo))}</td><td class="muted">${esc(formatUsd(p.hi))}</td>` : ""}<td class="${ch === null ? "" : ch >= 0 ? "up" : "down"}">${esc(formatPct(ch))}</td></tr>`;
        })
        .join("")}</tbody></table></div>`;
  }

  render();
  cleanups.push(subscribe((_, c) => ["prediction", "coin", "horizon", "model", "market"].includes(c) && render()));
  return () => cleanups.forEach((f) => f());
}
