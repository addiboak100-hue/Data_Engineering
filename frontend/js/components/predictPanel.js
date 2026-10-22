// Prediction controls: coin, horizon, run. Options come from the model
// service's GET /api/coins, so the UI only offers what the backend supports.

import { modelApi } from "../api/model.js";
import { formatDate, formatDateTime, formatRelative, formatUsd } from "../format.js";
import {
  checkModel,
  coinMeta,
  currentPrediction,
  getState,
  isPredictable,
  marketRow,
  runPrediction,
  setCoin,
  setHorizon,
  subscribe,
} from "../store.js";
import { changeChip, directionBlock, esc, forecastDirection, icon, notice, offlineHelp, skel } from "./ui.js";

export function mountPredictPanel(el, { compact = false } = {}) {
  el.classList.add("panel", "predict");
  let timer = null;

  el.addEventListener("change", (e) => {
    if (e.target.id === "pp-coin") setCoin(e.target.value);
  });
  el.addEventListener("click", (e) => {
    const h = e.target.closest("button[data-h]");
    if (h) return setHorizon(Number(h.dataset.h));
    if (e.target.closest("[data-run]")) return runPrediction();
    if (e.target.closest("[data-retry-model]")) return checkModel();
    const sw = e.target.closest("button[data-switch]");
    if (sw) setCoin(sw.dataset.switch);
  });

  function render() {
    const st = getState();
    const m = st.model;
    clearInterval(timer);

    if (m.status === "checking" && !m.checkedAt) {
      el.innerHTML = `<h2>Run a forecast</h2>
        <div class="field">${skel("40%", 12)}${skel("100%", 36)}</div>
        <div class="field">${skel("40%", 12)}${skel("100%", 34)}</div>
        ${skel("100%", 40)}
        <p class="label">Connecting to the model service…</p>`;
      return;
    }

    if (m.status !== "online") {
      el.innerHTML = `<h2>Run a forecast</h2>
        ${notice("warn", "Model service offline", offlineHelp(modelApi.base))}
        <button class="btn btn-block" type="button" data-retry-model ${m.status === "checking" ? "disabled" : ""}>
          ${m.status === "checking" ? '<span class="spinner" style="border-top-color:var(--text)"></span>Checking' : `${icon("refresh")}Check again`}
        </button>
        <p class="label">Live prices keep working without it. Forecasts, accuracy metrics and backtests need the service.</p>`;
      return;
    }

    const supported = isPredictable(st.coinId);
    const pred = currentPrediction();
    const running = pred?.status === "running";
    const meta = coinMeta(st.coinId);

    const coinOptions = m.coins
      .map((c) => `<option value="${esc(c.id)}" ${c.id === st.coinId ? "selected" : ""}>${esc(c.name)} (${esc(c.symbol)})</option>`)
      .join("");

    let body = "";
    if (!supported) {
      body = notice(
        "",
        `No model for ${meta.name}`,
        `<p>The model service forecasts ${m.coins.map((c) => esc(c.symbol)).join(", ")}.</p>`,
        m.coins.map((c) => `<button class="btn" type="button" data-switch="${esc(c.id)}" style="margin-right:6px">${esc(c.symbol)}</button>`).join(""),
      );
    } else if (pred?.status === "error") {
      body = notice("error", "Forecast failed", `<p>${esc(pred.error)}</p>`);
    }

    let result = "";
    if (supported && pred?.data) {
      const d = pred.data;
      const live = marketRow(st.coinId)?.price;
      const dir = forecastDirection(live, d);
      const end = d.points.at(-1);
      result = `<div class="result ${pred.status === "ready" ? "fade-in" : ""}" aria-live="polite">
        <div>
          <span class="label">Forecast for ${esc(formatDate(end.t))}</span>
          <div class="result-price num">${esc(formatUsd(end.v))}</div>
          ${dir ? `<div style="margin-top:6px">${changeChip(dir.pct, { suffix: "vs now" })}</div>` : ""}
        </div>
        ${dir ? directionBlock(dir, d.horizonDays) : ""}
        <dl class="kv num">
          ${d.hasInterval ? `<dt>${d.intervalWidth ? `${Math.round(d.intervalWidth * 100)}% interval` : "Interval"}</dt><dd>${esc(formatUsd(end.lo))} – ${esc(formatUsd(end.hi))}</dd>` : `<dt>Interval</dt><dd class="faint">Not provided</dd>`}
          <dt>Model</dt><dd>${esc(d.model.name)}${d.model.version ? ` ${esc(d.model.version)}` : ""}</dd>
          ${d.model.trainedAt ? `<dt>Trained</dt><dd>${esc(formatDateTime(d.model.trainedAt))}</dd>` : ""}
          <dt>Generated</dt><dd>${esc(formatRelative(d.generatedAt))}</dd>
        </dl>
      </div>`;
    }

    el.innerHTML = `
      <h2>Run a forecast</h2>
      <div class="field">
        <label class="label" for="pp-coin">Cryptocurrency</label>
        <span class="select"><select id="pp-coin" ${running ? "disabled" : ""}>${supported ? "" : `<option selected disabled>${esc(meta.name)} (not modelled)</option>`}${coinOptions}</select><svg class="icon"><use href="#i-chevron"/></svg></span>
      </div>
      <div class="field">
        <span class="label" id="pp-h-label">Horizon</span>
        <div class="seg" role="group" aria-labelledby="pp-h-label">
          ${m.horizons.map((h) => `<button type="button" data-h="${h}" aria-pressed="${h === st.horizon}" ${running || !supported ? "disabled" : ""}>${h}d</button>`).join("")}
        </div>
      </div>
      <button class="btn btn-primary btn-block" type="button" data-run ${running || !supported ? "disabled" : ""}>
        ${running ? `<span class="spinner"></span><span id="pp-elapsed">Running forecast</span>` : `${icon("play")}${pred?.data ? "Run again" : "Run forecast"}`}
      </button>
      ${body}
      ${result}
      ${!compact && supported && !pred ? `<p class="label">Fits the model on the latest prices and forecasts ${st.horizon} day${st.horizon === 1 ? "" : "s"} ahead.</p>` : ""}`;

    if (running) {
      const out = el.querySelector("#pp-elapsed");
      const tick = () => {
        const s = Math.round((Date.now() - pred.startedAt) / 1000);
        if (out) out.textContent = s >= 3 ? `Running forecast (${s}s)` :"Running forecast";
      };
      tick();
      timer = setInterval(tick, 1000);
    }
  }

  const unsub = subscribe((_, change) => {
    // Background price refreshes shouldn't yank focus out of the controls.
    if (change === "market" && (!currentPrediction()?.data || el.contains(document.activeElement))) return;
    if (["model", "coin", "horizon", "prediction", "market"].includes(change)) render();
  });
  render();
  return () => {
    unsub();
    clearInterval(timer);
  };
}
