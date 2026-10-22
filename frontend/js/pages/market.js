import { getHistory, describeMarketError } from "../api/market.js";
import { createTimeChart, sparklineSvg } from "../charts/timeChart.js";
import { formatNumber, formatPct, formatUsd } from "../format.js";
import { annualizedVolatility, maxDrawdown, rsi, sma, summarizeTrend, toDailyCloses } from "../indicators.js";
import { coinMeta, getState, setCoin, subscribe } from "../store.js";
import { changeChip, esc, icon, notice, skel, skeletonChart } from "../components/ui.js";

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const RANGES = [
  { id: "3M", days: 90 },
  { id: "6M", days: 180 },
  { id: "1Y", days: 365 },
];

export function mountMarket(view) {
  let range = "6M";
  view.innerHTML = `
    <div class="page">
      <header class="page-intro">
        <h1>Market Analysis</h1>
        <p>Trend, momentum and volatility for the selected coin, computed from CoinGecko daily closes. These describe the market; the forecast model doesn't use them as inputs.</p>
      </header>
      <dl class="stat-strip" id="stats"></dl>
      <section class="panel chart-panel">
        <div class="panel-head">
          <h2 id="ma-title">Price and moving averages</h2>
          <div class="legend">
            <span><i class="swatch" style="--c:var(--series-history)"></i>Price</span>
            <span><i class="swatch" style="--c:var(--series-sma20)"></i>20-day average</span>
            <span><i class="swatch" style="--c:var(--series-sma50)"></i>50-day average</span>
          </div>
          <div class="spacer"></div>
          <div class="seg" role="group" aria-label="Range" id="ma-range">${RANGES.map((r) => `<button type="button" data-r="${r.id}">${r.id}</button>`).join("")}</div>
        </div>
        <div class="chart-wrap"><div id="ma-chart"></div><div id="ma-ov"></div></div>
      </section>
      <div class="two-col">
        <section class="panel">
          <div class="panel-head"><h2>RSI (14 days)</h2><div class="spacer"></div><span class="label">Above 70 overbought, below 30 oversold</span></div>
          <div class="chart-wrap" style="min-height:200px"><div id="rsi-chart"></div></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Daily volume</h2><div class="spacer"></div><span class="label">USD traded per day</span></div>
          <div class="chart-wrap" style="min-height:200px"><div id="vol-chart"></div></div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Markets</h2><div class="spacer"></div><span class="label">Select a row to analyse that coin</span></div>
        <div id="mkts"></div>
      </section>
    </div>`;

  const maChart = createTimeChart(view.querySelector("#ma-chart"), { height: 380, ariaLabel: "Price with 20 and 50 day moving averages" });
  const rsiChart = createTimeChart(view.querySelector("#rsi-chart"), {
    height: 200,
    ariaLabel: "RSI 14",
    valueFormat: (v) => formatNumber(v, 1),
  });
  const volChart = createTimeChart(view.querySelector("#vol-chart"), {
    height: 200,
    ariaLabel: "Daily trading volume",
    valueFormat: (v) => formatUsd(v, { compact: true }),
  });
  const stats = view.querySelector("#stats");
  const ov = view.querySelector("#ma-ov");
  const mkts = view.querySelector("#mkts");
  let daily = null;
  let seq = 0;

  view.querySelector("#ma-range").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-r]");
    if (!b) return;
    range = b.dataset.r;
    drawCharts();
  });
  mkts.addEventListener("click", (e) => {
    const b = e.target.closest("[data-coin]");
    if (b) setCoin(b.dataset.coin);
  });

  async function load() {
    const s = ++seq;
    daily = null;
    ov.innerHTML = skeletonChart();
    stats.innerHTML = Array.from({ length: 4 }, () => `<div><dt>${skel("60%", 12)}</dt><dd>${skel("70%", 24)}</dd></div>`).join("");
    try {
      const h = await getHistory(getState().coinId, 365);
      if (s !== seq) return;
      const d = toDailyCloses(h.prices);
      const volByDay = new Map(toDailyCloses(h.volumes).map((p) => [Math.floor(p.t / 86_400_000), p.v]));
      daily = d.map((p) => ({ ...p, vol: volByDay.get(Math.floor(p.t / 86_400_000)) ?? null }));
      ov.innerHTML = "";
      drawStats();
      drawCharts();
    } catch (err) {
      if (s !== seq) return;
      ov.innerHTML = `<div class="empty">${notice("error", "History unavailable", `<p>${esc(describeMarketError(err))}</p>`, `<button class="btn" data-retry>${icon("refresh")}Try again</button>`)}</div>`;
      ov.querySelector("[data-retry]").addEventListener("click", load);
      stats.innerHTML = "";
    }
  }

  function drawStats() {
    const closes = daily.map((p) => p.v);
    const tr = summarizeTrend(daily);
    const ch7 = closes.length > 7 ? ((closes.at(-1) - closes.at(-8)) / closes.at(-8)) * 100 : null;
    const cell = (k, v, note) => `<div><dt>${k}</dt><dd class="num">${v}<small>${esc(note)}</small></dd></div>`;
    stats.innerHTML = [
      cell("7-day change", `<span class="${ch7 >= 0 ? "up" : "down"}">${esc(formatPct(ch7))}</span>`, "Daily closes"),
      cell("RSI 14", esc(formatNumber(tr?.rsi14, 1)), tr ? tr.momentum : "Needs 50 days"),
      cell("30-day volatility", `${esc(formatNumber(annualizedVolatility(closes.slice(-31)), 0))}%`, "Annualised"),
      cell("Max drawdown", `<span class="down">${esc(formatPct(maxDrawdown(closes), { digits: 1 }))}</span>`, "Peak to trough, 1 year"),
    ].join("");
  }

  function drawCharts() {
    view.querySelectorAll("#ma-range button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.r === range)));
    if (!daily) return;
    view.querySelector("#ma-title").textContent = `${coinMeta(getState().coinId).name} price and moving averages`;
    const closes = daily.map((p) => p.v);
    const s20 = sma(closes, 20);
    const s50 = sma(closes, 50);
    const r = rsi(closes, 14);
    const days = RANGES.find((x) => x.id === range).days;
    const from = daily.length - Math.min(days, daily.length);
    const slice = (arr) => daily.slice(from).map((p, i) => ({ t: p.t, v: arr[from + i] })).filter((p) => p.v !== null);

    maChart.update({
      series: [
        { label: "Price", color: css("--series-history"), points: slice(closes), area: true },
        { label: "20-day average", color: css("--series-sma20"), points: slice(s20), width: 1.5 },
        { label: "50-day average", color: css("--series-sma50"), points: slice(s50), width: 1.5 },
      ],
      tags: [{ v: closes.at(-1), color: css("--series-history") }],
    });
    rsiChart.update({
      series: [{ label: "RSI", color: css("--series-sma20"), points: slice(r), format: (v) => formatNumber(v, 1) }],
      yDomain: [0, 100],
      axisFormat: (v) => String(Math.round(v)),
      guides: [
        { v: 70, label: "70" },
        { v: 30, label: "30" },
      ],
    });
    volChart.update({
      series: [{ type: "bars", label: "Volume", color: css("--series-history"), points: slice(daily.map((p) => p.vol)), format: (v) => formatUsd(v, { compact: true }) }],
      axisFormat: (v) => formatUsd(v, { compact: true }).replace("$", ""),
    });
  }

  function drawMarkets() {
    const st = getState();
    if (!st.market.rows.length) {
      mkts.innerHTML =
        st.market.status === "error"
          ? `<div class="panel-body">${notice("error", "Market data unavailable", `<p>${esc(describeMarketError(st.market.error))}</p>`)}</div>`
          : `<div class="panel-body">${Array.from({ length: 5 }, () => skel("100%", 20, "margin:14px 0")).join("")}</div>`;
      return;
    }
    mkts.innerHTML = `<div class="table-wrap"><table class="data num">
      <thead><tr><th scope="col">Coin</th><th scope="col">Price</th><th scope="col">24h</th><th scope="col">7d</th><th scope="col">Market cap</th><th scope="col">Volume, 24h</th><th scope="col">Last 7 days</th></tr></thead>
      <tbody>${st.market.rows
        .map((r) => {
          const up = (r.changePct7d ?? 0) >= 0;
          return `<tr class="${r.id === st.coinId ? "is-selected" : ""}">
            <td><button class="row-btn coin-cell" type="button" data-coin="${esc(r.id)}" aria-pressed="${r.id === st.coinId}">${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy" />` : ""}<b>${esc(r.name)}</b><span class="faint">${esc(r.symbol)}</span></button></td>
            <td>${esc(formatUsd(r.price))}</td>
            <td>${changeChip(r.changePct24h)}</td>
            <td class="${up ? "up" : "down"}">${esc(formatPct(r.changePct7d))}</td>
            <td>${esc(formatUsd(r.marketCap, { compact: true }))}</td>
            <td>${esc(formatUsd(r.volume24h, { compact: true }))}</td>
            <td>${sparklineSvg(r.sparkline, { color: up ? css("--up") : css("--down") })}</td>
          </tr>`;
        })
        .join("")}</tbody></table></div>`;
  }

  load();
  drawMarkets();
  const unsub = subscribe((_, c) => {
    if (c === "coin") {
      load();
      drawMarkets();
    } else if (c === "market") drawMarkets();
  });
  return () => {
    unsub();
    maChart.destroy();
    rsiChart.destroy();
    volChart.destroy();
  };
}
