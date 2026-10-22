// The centrepiece: live price history with the model's forecast to the right
// of the "now" seam. The forecast layer only appears when the model service
// returned a real forecast for this coin.

import { TIMEFRAMES } from "../config.js";
import { getHistory, describeMarketError } from "../api/market.js";
import { createTimeChart } from "../charts/timeChart.js";
import { formatRelative, formatUsd } from "../format.js";
import { coinMeta, currentPrediction, getState, marketRow, setTimeframe, subscribe } from "../store.js";
import { esc, icon, notice, skeletonChart } from "./ui.js";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function mountForecastChart(el, { height = 400, title = "Price and forecast" } = {}) {
  el.classList.add("panel", "chart-panel");
  el.innerHTML = `
    <div class="panel-head">
      <h2 id="fc-title">${esc(title)}</h2>
      <div class="legend" id="fc-legend"></div>
      <div class="spacer"></div>
      <div class="seg" role="group" aria-label="Chart range" id="fc-range">
        ${TIMEFRAMES.map((t) => `<button type="button" data-tf="${t.id}" aria-label="${t.long}">${t.label}</button>`).join("")}
      </div>
    </div>
    <div class="chart-wrap"><div id="fc-chart"></div><div id="fc-overlay"></div></div>
    <div class="chart-foot"><span id="fc-foot-left"></span><span id="fc-foot-right"></span></div>`;

  const chartEl = el.querySelector("#fc-chart");
  const overlay = el.querySelector("#fc-overlay");
  const legend = el.querySelector("#fc-legend");
  const footL = el.querySelector("#fc-foot-left");
  const footR = el.querySelector("#fc-foot-right");
  const chart = createTimeChart(chartEl, { height, ariaLabel: "Price chart. Use left and right arrow keys to read values." });

  let history = null;
  let histErr = null;
  let loadSeq = 0;

  el.querySelector("#fc-range").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tf]");
    if (b) setTimeframe(b.dataset.tf);
  });

  async function load() {
    const { coinId, timeframe } = getState();
    const tf = TIMEFRAMES.find((t) => t.id === timeframe);
    const seq = ++loadSeq;
    histErr = null;
    if (!history || history.coinId !== coinId || history.tf !== timeframe) {
      history = null;
      draw();
    }
    try {
      const res = await getHistory(coinId, tf.days);
      if (seq !== loadSeq) return;
      history = { ...res, coinId, tf: timeframe };
    } catch (err) {
      if (seq !== loadSeq) return;
      histErr = err;
    }
    draw();
  }

  function draw() {
    const st = getState();
    el.querySelectorAll("#fc-range button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tf === st.timeframe)));
    const meta = coinMeta(st.coinId);
    const tf = TIMEFRAMES.find((t) => t.id === st.timeframe);

    if (!history) {
      chartEl.style.visibility = "hidden";
      legend.innerHTML = "";
      footL.textContent = "";
      footR.textContent = "";
      overlay.innerHTML = histErr
        ? `<div class="empty fade-in" style="position:absolute;inset:0;justify-content:center">
             ${notice("error", "Price history unavailable", `<p>${esc(describeMarketError(histErr))}</p>`, `<button class="btn" type="button" data-retry>${icon("refresh")}Try again</button>`)}
           </div>`
        : skeletonChart();
      overlay.querySelector("[data-retry]")?.addEventListener("click", load);
      return;
    }
    overlay.innerHTML = "";
    chartEl.style.visibility = "visible";

    const prices = history.prices;
    const last = prices.at(-1);
    const live = marketRow(st.coinId)?.price;
    const pred = currentPrediction();
    const fc = pred?.data && pred.data.coinId !== null && pred.data.coinId !== st.coinId ? null : pred?.data;

    const series = [
      { id: "history", label: `${meta.symbol} price`, color: css("--series-history"), points: prices, area: true, animate: true },
    ];
    const tags = [{ v: Number.isFinite(live) ? live : last.v, color: css("--series-history") }];
    let band = null;
    let now = null;

    if (fc && fc.points.length && fc.points.at(-1).t > last.t) {
      const fpts = fc.points.filter((p) => p.t > last.t);
      now = last.t;
      series.push({
        id: "forecast",
        label: "Forecast",
        color: css("--series-forecast"),
        points: [{ t: last.t, v: last.v }, ...fpts],
        dashed: true,
        endDot: true,
        tooltipAfter: last.t, // the connector point is history, not forecast
        format: formatUsd,
      });
      if (fc.hasInterval) {
        band = {
          label: fc.intervalWidth ? `${Math.round(fc.intervalWidth * 100)}% interval` : "Uncertainty interval",
          points: [{ t: last.t, lo: last.v, hi: last.v }, ...fpts.map((p) => ({ t: p.t, lo: p.lo, hi: p.hi }))],
        };
      }
      tags.push({ v: fpts.at(-1).v, color: css("--series-forecast") });
    }

    chart.update({
      series,
      band,
      now,
      tags,
      forecastLabel: fc ? `${fc.horizonDays}-day forecast` : "",
      ariaLabel: `${meta.name} price over ${tf.long}${fc ? ` with a ${fc.horizonDays}-day model forecast` : ""}. Use arrow keys to read values.`,
    });

    legend.innerHTML =
      `<span><i class="swatch" style="--c:var(--series-history)"></i>${esc(meta.symbol)} price</span>` +
      (fc ? `<span><i class="swatch swatch-dashed" style="--c:var(--series-forecast)"></i>Forecast</span>` : "") +
      (band ? `<span><i class="swatch swatch-band"></i>${esc(band.label)}</span>` : "");

    footL.innerHTML = `${history.stale ? `${icon("alert")} Showing cached data. ` : ""}${esc(tf.long)} of CoinGecko data, updated ${esc(formatRelative(history.fetchedAt))}`;
    footR.textContent = fc
      ? `Forecast by ${fc.model.name}${fc.model.version ? ` ${fc.model.version}` : ""}, generated ${formatRelative(fc.generatedAt)}`
      : st.model.status === "online"
        ? "Run a forecast to overlay the model's prediction"
        : "Forecast layer appears when the model service is online";
  }

  const unsub = subscribe((_, change) => {
    if (change === "coin" || change === "timeframe") load();
    else if (["prediction", "model", "market", "tick"].includes(change)) draw();
  });
  load();
  return () => {
    unsub();
    chart.destroy();
  };
}
