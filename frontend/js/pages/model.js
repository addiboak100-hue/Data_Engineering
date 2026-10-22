import { modelApi } from "../api/model.js";
import { createTimeChart } from "../charts/timeChart.js";
import { formatDate, formatDateTime, formatNumber, formatPct, formatUsd } from "../format.js";
import { checkModel, coinMeta, getState, isPredictable, loadMetrics, subscribe } from "../store.js";
import { esc, icon, notice, offlineHelp, skel } from "../components/ui.js";

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export function mountModel(view) {
  view.innerHTML = `
    <div class="page">
      <header class="page-intro">
        <h1>Model Insights</h1>
        <p>How well the forecast model has done on days it didn't see during training. Every number here comes from the model service's backtest.</p>
      </header>
      <div id="status"></div>
      <dl class="stat-strip" id="metrics"></dl>
      <section class="panel" id="live" hidden>
        <div class="panel-head"><h2>Live track record</h2><div class="spacer"></div><span class="label" id="live-meta"></span></div>
        <div id="live-body"></div>
      </section>
      <section class="panel chart-panel">
        <div class="panel-head">
          <h2 id="bt-title">Actual vs predicted</h2>
          <div class="legend">
            <span><i class="swatch" style="--c:var(--series-history)"></i>Actual close</span>
            <span><i class="swatch swatch-dashed" style="--c:var(--series-forecast)"></i>Model prediction</span>
          </div>
        </div>
        <div class="chart-wrap" style="min-height:340px"><div id="bt-chart"></div><div id="bt-ov"></div></div>
      </section>
      <div class="two-col">
        <section class="panel">
          <div class="panel-head"><h2>Largest misses</h2><div class="spacer"></div><span class="label">Backtest days with the biggest error</span></div>
          <div id="misses"></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Reading the metrics</h2></div>
          <div class="panel-body prose">
            <p><strong>MAE</strong> is the average absolute miss in dollars. <strong>RMSE</strong> weights large misses more heavily, so a big gap between RMSE and MAE means occasional large errors. <strong>MAPE</strong> is the average miss as a percentage of price, which makes coins comparable.</p>
            <p><strong>Naive baseline</strong> predicts that the price stays at the last close. It's scored on the same days, so a model only adds value where its error is lower. Beating it on daily crypto prices is genuinely hard.</p>
            <p>Backtest results describe the past. Crypto regimes change quickly, so a model that tracked last quarter well can still miss sharply on news-driven moves.</p>
          </div>
        </section>
      </div>
    </div>`;

  const chart = createTimeChart(view.querySelector("#bt-chart"), { height: 340, ariaLabel: "Backtest: actual versus predicted price" });
  const statusEl = view.querySelector("#status");
  const metricsEl = view.querySelector("#metrics");
  const ov = view.querySelector("#bt-ov");
  const misses = view.querySelector("#misses");
  const chartEl = view.querySelector("#bt-chart");

  statusEl.addEventListener("click", (e) => e.target.closest("[data-retry-model]") && checkModel());
  ov.addEventListener("click", (e) => e.target.closest("[data-retry-metrics]") && (delete getState().metrics[getState().coinId], loadMetrics()));

  function render() {
    const st = getState();
    const meta = coinMeta(st.coinId);
    view.querySelector("#bt-title").textContent = `${meta.name}: actual vs predicted`;
    const m = st.model;

    // Service status line.
    if (m.status === "online") {
      statusEl.innerHTML = `<dl class="meta-line num">
        <div><dt>Model</dt><dd>${esc(m.info.name)}${m.info.version ? ` ${esc(m.info.version)}` : ""}</dd></div>
        ${m.info.trainedAt ? `<div><dt>Last trained</dt><dd>${esc(formatDateTime(m.info.trainedAt))}</dd></div>` : ""}
        <div><dt>Coins</dt><dd>${m.coins.map((c) => esc(c.symbol)).join(", ")}</dd></div>
        <div><dt>Horizons</dt><dd>${m.horizons.map((h) => `${h}d`).join(", ")}</dd></div>
        <div><dt>Service</dt><dd>${esc(modelApi.base)}</dd></div>
      </dl>`;
    } else if (m.status === "checking" && !m.checkedAt) {
      statusEl.innerHTML = skel("320px", 16);
    } else {
      statusEl.innerHTML = notice("warn", "Model service offline", offlineHelp(modelApi.base), `<button class="btn" data-retry-model>${icon("refresh")}Check again</button>`);
    }

    const mt = st.metrics[st.coinId];
    const d = mt?.status === "ready" ? mt.data : null;
    const cell = (k, v, note) => `<div><dt>${k}</dt><dd class="num">${v}<small>${esc(note)}</small></dd></div>`;
    const na = '<span class="faint">—</span>';

    if (m.status === "online" && isPredictable(st.coinId) && (!mt || mt.status === "loading")) {
      metricsEl.innerHTML = Array.from({ length: 4 }, () => `<div><dt>${skel("50%", 12)}</dt><dd>${skel("70%", 24)}</dd></div>`).join("");
    } else {
      const reason = m.status !== "online" ? "Model offline" : !isPredictable(st.coinId) ? `${meta.symbol} not modelled` : "Not reported";
      metricsEl.innerHTML = [
        cell("MAE", d?.mae != null ? esc(formatUsd(d.mae, { digits: d.mae >= 100 ? 0 : 2 })) : na,
          d?.mae != null ? (d.rmse != null ? `RMSE ${formatUsd(d.rmse, { digits: d.rmse >= 100 ? 0 : 2 })}` : "Mean absolute error") : reason),
        cell("MAPE", d?.mape != null ? `${esc(formatNumber(d.mape, 2))}%` : na, d?.mape != null ? (d.baseline ? `Naive baseline: ${formatNumber(d.baseline.mape, 2)}%` : "Mean absolute % error") : reason),
        cell(`${Math.round((d?.intervalWidth ?? 0.8) * 100)}% band hit rate`, d?.coverage != null ? `${esc(formatNumber(d.coverage * 100, 0))}%` : na,
          d?.coverage != null ? `Target ${Math.round(d.intervalWidth * 100)}%` : d ? "Not reported" : reason),
        cell(
          "Backtest window",
          d?.window?.start && d?.window?.end ? esc(`${formatDate(d.window.start, { month: "short", day: "numeric" })} – ${formatDate(d.window.end, { month: "short", day: "numeric" })}`) : d?.backtest.length ? `${d.backtest.length} days` : na,
          d?.backtest.length ? `${d.backtest.length} held-out days` : reason,
        ),
      ].join("");
    }

    renderLive(d);

    // Chart + misses.
    if (d?.backtest.length >= 2) {
      ov.innerHTML = "";
      chartEl.style.visibility = "visible";
      chart.update({
        series: [
          { label: "Actual", color: css("--series-history"), points: d.backtest.map((r) => ({ t: r.t, v: r.actual })) },
          { label: "Predicted", color: css("--series-forecast"), dashed: true, points: d.backtest.map((r) => ({ t: r.t, v: r.predicted })) },
        ],
      });
      const worst = [...d.backtest]
        .map((r) => ({ ...r, err: ((r.predicted - r.actual) / r.actual) * 100 }))
        .sort((a, b) => Math.abs(b.err) - Math.abs(a.err))
        .slice(0, 6);
      misses.innerHTML = `<div class="table-wrap"><table class="data num"><thead><tr><th scope="col">Date</th><th scope="col">Actual</th><th scope="col">Predicted</th><th scope="col">Error</th></tr></thead>
        <tbody>${worst.map((r) => `<tr><td>${esc(formatDate(r.t))}</td><td>${esc(formatUsd(r.actual))}</td><td>${esc(formatUsd(r.predicted))}</td><td class="${r.err >= 0 ? "up" : "down"}">${esc(formatPct(r.err))}</td></tr>`).join("")}</tbody></table></div>`;
      return;
    }

    chartEl.style.visibility = "hidden";
    let msg;
    if (m.status !== "online") msg = ["No backtest to show", "Actual-vs-predicted history appears once the model service is running and reports a backtest."];
    else if (!isPredictable(st.coinId)) msg = [`${meta.name} isn't modelled`, `Pick one of ${m.coins.map((c) => c.symbol).join(", ")} in the coin selector.`];
    else if (mt?.status === "error") msg = ["Metrics couldn't be loaded", mt.error];
    else if (mt?.status === "loading" || !mt) msg = null;
    else msg = ["No backtest points", "The service reported metrics without the daily backtest series."];

    ov.innerHTML = msg
      ? `<div class="empty empty-center" style="position:absolute;inset:0;justify-content:center"><h3>${esc(msg[0])}</h3><p>${esc(msg[1])}</p>${mt?.status === "error" ? `<button class="btn" data-retry-metrics>${icon("refresh")}Try again</button>` : ""}</div>`
      : `<div style="padding:16px">${skel("100%", 300)}</div>`;
    misses.innerHTML = `<div class="empty"><p>${msg ? "Nothing to rank yet." : "Loading…"}</p></div>`;
  }

  function renderLive(d) {
    const box = view.querySelector("#live");
    const body = view.querySelector("#live-body");
    const meta = view.querySelector("#live-meta");
    const live = d?.live;
    box.hidden = !live;
    if (!live) return;
    if (live.n === 0) {
      meta.textContent = "";
      body.innerHTML = `<div class="empty"><h3>Recording has started</h3><p>The pipeline stores a 30-day forecast every day. Each one is scored against the real price once its day arrives, so the first results appear tomorrow and grow from there.</p></div>`;
      return;
    }
    meta.textContent = `${live.n} predictions scored${live.lastTarget ? `, through ${formatDate(live.lastTarget, { month: "short", day: "numeric" })}` : ""}`;
    const pct = (v) => (v == null ? "—" : `${v.toFixed(2)}%`);
    const hit = (v) => (v == null ? "—" : `${formatNumber(v * 100, 0)}%`);
    const rows = [...live.byHorizon, { label: "All", n: live.n, mape: live.mape, naiveMape: live.naiveMape, coverage: live.coverage }];
    body.innerHTML = `<div class="table-wrap"><table class="data num">
      <thead><tr><th scope="col">Days ahead</th><th scope="col">Predictions</th><th scope="col">MAPE</th><th scope="col">Naive MAPE</th><th scope="col">${Math.round(d.intervalWidth * 100)}% band hit rate</th></tr></thead>
      <tbody>${rows
        .map((r) => {
          const better = r.mape != null && r.naiveMape != null ? r.mape < r.naiveMape : null;
          return `<tr${r.label === "All" ? ' style="font-weight:500"' : ""}><td>${esc(r.label)}</td><td>${r.n}</td><td class="${better === null ? "" : better ? "up" : "down"}">${pct(r.mape)}</td><td class="muted">${pct(r.naiveMape)}</td><td>${hit(r.coverage)}</td></tr>`;
        })
        .join("")}</tbody></table></div>
      <p class="label" style="padding:12px var(--s5) var(--s5)">Real forecasts the pipeline stored before the outcome was known, so unlike the backtest nothing here is simulated. Green means the model beat the naive baseline for that horizon.</p>`;
  }

  render();
  loadMetrics();
  const unsub = subscribe((_, c) => ["model", "metrics", "coin"].includes(c) && render());
  return () => {
    unsub();
    chart.destroy();
  };
}
