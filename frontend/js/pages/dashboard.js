import { getHistory } from "../api/market.js";
import { describeMarketError } from "../api/market.js";
import { formatDateTime, formatPct, formatRelative, formatUsd, formatNumber } from "../format.js";
import { summarizeTrend, toDailyCloses } from "../indicators.js";
import { coinMeta, currentPrediction, getState, isPredictable, marketHealth, marketRow, subscribe } from "../store.js";
import { mountForecastChart } from "../components/forecastChart.js";
import { mountPredictPanel } from "../components/predictPanel.js";
import { changeChip, directionBlock, esc, forecastDirection, notice, skel } from "../components/ui.js";

export function mountDashboard(view) {
  view.innerHTML = `
    <div class="page">
      <section class="hero" aria-labelledby="asset-name">
        <div class="asset" id="asset"></div>
        <dl class="readout" id="readout"></dl>
      </section>
      <section class="stage" aria-label="Forecast">
        <div id="chart"></div>
        <aside class="rail"><div id="predict"></div></aside>
      </section>
      <section class="insights" aria-label="Insights">
        <article class="insight" id="ins-forecast"></article>
        <article class="insight" id="ins-trend"></article>
        <article class="insight" id="ins-model"></article>
      </section>
    </div>`;

  const cleanups = [mountForecastChart(view.querySelector("#chart"), { height: 420 }), mountPredictPanel(view.querySelector("#predict"))];

  const assetEl = view.querySelector("#asset");
  const readoutEl = view.querySelector("#readout");
  const insF = view.querySelector("#ins-forecast");
  const insT = view.querySelector("#ins-trend");
  const insM = view.querySelector("#ins-model");

  function renderAsset() {
    const st = getState();
    const row = marketRow();
    const meta = coinMeta(st.coinId);
    if (!row) {
      assetEl.innerHTML =
        st.market.status === "error"
          ? `<div class="asset-line"><strong id="asset-name">${esc(meta.name)}</strong><span>${esc(meta.symbol)} / USD</span></div>
             ${notice("error", "Live price unavailable", `<p>${esc(describeMarketError(st.market.error))}</p>`)}`
          : `<div class="asset-line"><strong id="asset-name">${esc(meta.name)}</strong><span>${esc(meta.symbol)} / USD</span></div>
             ${skel("300px", 48)}${skel("220px", 14)}`;
      return;
    }
    assetEl.innerHTML = `
      <div class="asset-line">${row.image ? `<img src="${esc(row.image)}" alt="" />` : ""}<strong id="asset-name">${esc(row.name)}</strong><span>${esc(row.symbol)} / USD</span></div>
      <div class="price-row">
        <span class="price num">${esc(formatUsd(row.price))}</span>
        <span class="price-delta num ${row.changePct24h >= 0 ? "up" : "down"}">${esc(formatPct(row.changePct24h))}<small>24h</small></span>
      </div>
      <p class="tagline">Live market data with model forecasts and their measured accuracy.</p>`;
  }

  function renderReadout() {
    const st = getState();
    const row = marketRow();
    const pred = currentPrediction();
    const fc = pred?.data && (pred.data.coinId === null || pred.data.coinId === st.coinId) ? pred.data : null;
    const dir = fc ? forecastDirection(row?.price, fc) : null;
    const metrics = st.metrics[st.coinId]?.data;
    const online = st.model.status === "online";
    const modelled = isPredictable(st.coinId);
    const pendingNote = !online
      ? st.model.status === "checking" ? "Connecting" : "Model offline"
      : modelled ? "Run a forecast" : `${coinMeta(st.coinId).symbol} not modelled`;

    const cell = (label, value, note, pending) => `<div class="${pending ? "pending" : ""}"><dt>${label}</dt><dd class="num">${value}<small>${esc(note)}</small></dd></div>`;
    const health = marketHealth();
    readoutEl.innerHTML = [
      cell("24h change", row ? `<span class="${row.change24h >= 0 ? "up" : "down"}">${esc(formatUsd(row.change24h))}</span>` : "—", row ? `Range ${formatUsd(row.low24h, { compact: true })} – ${formatUsd(row.high24h, { compact: true })}` : "Loading", !row),
      fc ? cell(`Forecast, ${fc.horizonDays}d`, esc(formatUsd(fc.points.at(-1).v)), `by ${fc.model.name}`, false) : cell("Forecast", "—", pendingNote, true),
      dir ? cell("Expected change", `<span class="${dir.pct >= 0 ? "up" : "down"}">${esc(formatPct(dir.pct))}</span>`, "vs live price", false) : cell("Expected change", "—", pendingNote, true),
      metrics?.mape !== null && metrics?.mape !== undefined
        ? cell("Model error", `${esc(formatNumber(metrics.mape, 2))}%`, metrics.baseline ? `MAPE, naive ${formatNumber(metrics.baseline.mape, 2)}%` : "MAPE on backtest", false)
        : cell("Model error", "—", online && modelled ? (st.metrics[st.coinId]?.status === "loading" ? "Loading" : "Not reported") : pendingNote, true),
      cell(
        "Updated",
        st.market.fetchedAt ? esc(formatRelative(st.market.fetchedAt)) : "—",
        health === "live" ? "CoinGecko, live" : health === "stale" ? "CoinGecko, delayed" : health === "error" ? "CoinGecko unreachable" : "Connecting",
        !st.market.fetchedAt,
      ),
    ].join("");
  }

  function renderForecastInsight() {
    const st = getState();
    const pred = currentPrediction();
    const fc = pred?.data && (pred.data.coinId === null || pred.data.coinId === st.coinId) ? pred.data : null;
    const row = marketRow();
    if (!fc) {
      insF.innerHTML = `<h3>Forecast read</h3>
        <p>${st.model.status === "online" && !isPredictable(st.coinId) ? `The model doesn't cover ${esc(coinMeta(st.coinId).name)}. Switch to ${st.model.coins.map((c) => esc(c.symbol)).join(" or ")} to see a forecast read.` : st.model.status === "online" ? "Run a forecast to see the model's direction, expected move and uncertainty range for the selected coin." : "When the model service is online, this explains the latest forecast: direction, size of the expected move and how wide the uncertainty is."}</p>
        <span class="provenance">Source: model service</span>`;
      return;
    }
    const dir = forecastDirection(row?.price, fc);
    const end = fc.points.at(-1);
    const width = fc.hasInterval ? ((end.hi - end.lo) / end.v) * 100 : null;
    insF.innerHTML = `<h3>Forecast read</h3>
      ${directionBlock(dir, fc.horizonDays)}
      <p>${esc(fc.model.name)} projects ${esc(coinMeta(st.coinId).name)} at ${esc(formatUsd(end.v))} in ${fc.horizonDays} day${fc.horizonDays === 1 ? "" : "s"}${dir ? `, ${dir.pct >= 0 ? "up" : "down"} ${esc(formatPct(Math.abs(dir.pct), { signed: false }))} from the live price` : ""}.
      ${width !== null ? ` The ${fc.intervalWidth ? `${Math.round(fc.intervalWidth * 100)}% ` : ""}interval spans ${esc(formatNumber(width, 1))}% of the forecast price, so treat the direction as more reliable than the exact level.` : " The service didn't return an uncertainty interval for this run."}</p>
      <span class="provenance">Direction = forecast end vs live price, ±1% counts as neutral</span>`;
  }

  let trendSeq = 0;
  async function renderTrendInsight() {
    const st = getState();
    const seq = ++trendSeq;
    insT.innerHTML = `<h3>Market trend</h3>${skel("60%", 16)}${skel("100%", 12)}${skel("80%", 12)}`;
    try {
      const h = await getHistory(st.coinId, 365);
      if (seq !== trendSeq) return;
      const tr = summarizeTrend(toDailyCloses(h.prices));
      if (!tr) {
        insT.innerHTML = `<h3>Market trend</h3><p>Not enough daily history to compute trend indicators.</p>`;
        return;
      }
      const vs20 = ((tr.last - tr.sma20) / tr.sma20) * 100;
      insT.innerHTML = `<h3>Market trend</h3>
        <div class="metric-row num">
          <div class="metric"><span>Trend</span><b>${esc(tr.label)}</b></div>
          <div class="metric"><span>RSI 14</span><b>${esc(formatNumber(tr.rsi14, 1))}</b></div>
          <div class="metric"><span>30d volatility</span><b>${esc(formatNumber(tr.vol30, 0))}%</b></div>
        </div>
        <p>Price is ${esc(formatPct(vs20))} versus its 20-day average; the 20-day average is ${tr.sma20 >= tr.sma50 ? "above" : "below"} the 50-day. ${esc(tr.momentum)}.</p>
        <span class="provenance">Computed in the browser from CoinGecko daily closes. Not a model input.</span>`;
    } catch (err) {
      if (seq !== trendSeq) return;
      insT.innerHTML = `<h3>Market trend</h3><p>${esc(describeMarketError(err))}</p>`;
    }
  }

  function renderModelInsight() {
    const st = getState();
    const mt = st.metrics[st.coinId];
    if (st.model.status !== "online") {
      insM.innerHTML = `<h3>Model accuracy</h3>
        <p>Backtest error (MAE, RMSE, MAPE) is reported by the model service. Nothing is shown until it reports real numbers.</p>
        <span class="provenance">Source: model service, offline</span>`;
      return;
    }
    if (!isPredictable(st.coinId)) {
      insM.innerHTML = `<h3>Model accuracy</h3>
        <p>The model service doesn't forecast ${esc(coinMeta(st.coinId).name)}, so there's no backtest for it. It covers ${st.model.coins.map((c) => esc(c.symbol)).join(", ")}.</p>
        <span class="provenance">Source: model service</span>`;
      return;
    }
    if (!mt || mt.status === "loading") {
      insM.innerHTML = `<h3>Model accuracy</h3>${skel("100%", 36)}${skel("70%", 12)}`;
      return;
    }
    if (mt.status === "error") {
      insM.innerHTML = `<h3>Model accuracy</h3><p>${esc(mt.error)}</p>`;
      return;
    }
    const d = mt.data;
    const m = (label, v, unit) => `<div class="metric"><span>${label}</span><b>${v === null ? '<span class="faint">n/a</span>' : esc(unit === "%" ? `${formatNumber(v, 2)}%` : formatUsd(v, { digits: v >= 100 ? 0 : 2 }))}</b></div>`;
    insM.innerHTML = `<h3>Model accuracy</h3>
      <div class="metric-row num">${m("MAE", d.mae)}${m("MAPE", d.mape, "%")}${d.coverage != null ? `<div class="metric"><span>${Math.round(d.intervalWidth * 100)}% band hit rate</span><b>${esc(formatNumber(d.coverage * 100, 0))}%</b></div>` : m("RMSE", d.rmse)}</div>
      <p>${d.backtest.length ? `Measured on ${d.backtest.length} held-out days.` : "Backtest points weren't included in the response."}${d.baseline && d.mape !== null ? ` ${d.mape < d.baseline.mape ? "Beats" : "Doesn't beat"} the naive baseline (${esc(formatNumber(d.baseline.mape, 2))}% MAPE).` : ""} <a href="#/model">See actual vs predicted</a></p>
      <span class="provenance">${d.evaluatedAt ? `Evaluated ${esc(formatDateTime(d.evaluatedAt))}` : "Source: model service"}</span>`;
  }

  const all = () => {
    renderAsset();
    renderReadout();
    renderForecastInsight();
    renderModelInsight();
  };
  all();
  renderTrendInsight();

  cleanups.push(
    subscribe((_, change) => {
      if (change === "coin") {
        all();
        renderTrendInsight();
      } else if (change === "market" || change === "tick") {
        renderAsset();
        renderReadout();
      } else if (["prediction", "model", "metrics", "horizon"].includes(change)) {
        renderReadout();
        renderForecastInsight();
        renderModelInsight();
      }
    }),
  );
  return () => cleanups.forEach((fn) => fn());
}
