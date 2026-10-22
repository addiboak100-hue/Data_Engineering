// Client for the Sibyl prediction service. The contract is documented in
// docs/api-contract.md. Every response is validated here; anything malformed
// is rejected rather than drawn, so the UI never shows a made-up forecast.

import { MODEL_API_BASE } from "../config.js";
import { ApiError, fetchJson } from "./http.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const toMs = (v) => {
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

function invalid(what) {
  return new ApiError(`The model service returned an invalid ${what}.`, { kind: "invalid" });
}

/** GET /api/health → { status, model: { name, version?, trained_at? } } */
export function parseHealth(raw) {
  if (!raw || raw.status !== "ok") throw invalid("health response");
  const m = raw.model && typeof raw.model === "object" ? raw.model : {};
  return {
    model: {
      name: isStr(m.name) ? m.name : "Forecast model",
      version: isStr(m.version) ? m.version : null,
      trainedAt: toMs(m.trained_at),
    },
  };
}

/** GET /api/coins → { coins: [{ id, symbol, name }], horizons: [days] } */
export function parseCoins(raw) {
  if (!raw || !Array.isArray(raw.coins) || !Array.isArray(raw.horizons)) throw invalid("coin list");
  const coins = raw.coins
    .filter((c) => c && isStr(c.id))
    .map((c) => ({ id: c.id, symbol: isStr(c.symbol) ? c.symbol.toUpperCase() : c.id, name: isStr(c.name) ? c.name : c.id }));
  const horizons = [...new Set(raw.horizons.filter((h) => Number.isInteger(h) && h > 0))].sort((a, b) => a - b);
  if (!coins.length || !horizons.length) throw invalid("coin list");
  return { coins, horizons };
}

/**
 * POST /api/predict → {
 *   coin_id, horizon_days, generated_at, interval_width?,
 *   model: { name, version?, trained_at? },
 *   last_observed?: { date, price },
 *   forecast: [{ date, yhat, yhat_lower?, yhat_upper? }]
 * }
 */
export function parsePrediction(raw) {
  if (!raw || !Array.isArray(raw.forecast) || raw.forecast.length === 0) throw invalid("forecast");
  const points = raw.forecast.map((p) => ({
    t: toMs(p?.date),
    v: isNum(p?.yhat) ? p.yhat : null,
    lo: isNum(p?.yhat_lower) ? p.yhat_lower : null,
    hi: isNum(p?.yhat_upper) ? p.yhat_upper : null,
  }));
  if (points.some((p) => p.t === null || p.v === null)) throw invalid("forecast");
  points.sort((a, b) => a.t - b.t);

  // Only claim an interval if every point carries a coherent one.
  const hasInterval = points.every((p) => p.lo !== null && p.hi !== null && p.lo <= p.v && p.v <= p.hi);
  if (!hasInterval) points.forEach((p) => { p.lo = null; p.hi = null; });

  const m = raw.model && typeof raw.model === "object" ? raw.model : {};
  const last = raw.last_observed;
  return {
    coinId: isStr(raw.coin_id) ? raw.coin_id : null,
    horizonDays: Number.isInteger(raw.horizon_days) ? raw.horizon_days : points.length,
    generatedAt: toMs(raw.generated_at) ?? Date.now(),
    intervalWidth: hasInterval && isNum(raw.interval_width) && raw.interval_width > 0 && raw.interval_width < 1 ? raw.interval_width : null,
    hasInterval,
    model: {
      name: isStr(m.name) ? m.name : "Forecast model",
      version: isStr(m.version) ? m.version : null,
      trainedAt: toMs(m.trained_at),
    },
    lastObserved: last && isNum(last.price) && toMs(last.date) !== null ? { t: toMs(last.date), v: last.price } : null,
    points,
  };
}

/**
 * GET /api/metrics?coin_id= → {
 *   coin_id, mae?, rmse?, mape?, evaluated_at?, window?: { start, end, points? },
 *   backtest?: [{ date, actual, predicted }]
 * }
 * Metrics absent from the response stay null and are shown as "not reported".
 */
export function parseMetrics(raw) {
  if (!raw || typeof raw !== "object") throw invalid("metrics response");
  const metric = (v) => (isNum(v) && v >= 0 ? v : null);
  const backtest = Array.isArray(raw.backtest)
    ? raw.backtest
        .map((r) => ({ t: toMs(r?.date), actual: isNum(r?.actual) ? r.actual : null, predicted: isNum(r?.predicted) ? r.predicted : null }))
        .filter((r) => r.t !== null && r.actual !== null && r.predicted !== null)
        .sort((a, b) => a.t - b.t)
    : [];
  const w = raw.window && typeof raw.window === "object" ? raw.window : null;
  return {
    mae: metric(raw.mae),
    rmse: metric(raw.rmse),
    mape: metric(raw.mape),
    evaluatedAt: toMs(raw.evaluated_at),
    window: w ? { start: toMs(w.start), end: toMs(w.end) } : null,
    // Optional naive baseline scored on the same days, for context.
    baseline:
      raw.baseline && typeof raw.baseline === "object" && metric(raw.baseline.mape) !== null
        ? { name: isStr(raw.baseline.name) ? raw.baseline.name : "Naive baseline", mape: metric(raw.baseline.mape), mae: metric(raw.baseline.mae) }
        : null,
    // Share (0-1) of backtest actuals inside the forecast interval.
    coverage: isNum(raw.coverage) && raw.coverage >= 0 && raw.coverage <= 1 ? raw.coverage : null,
    intervalWidth: isNum(raw.interval_width) && raw.interval_width > 0 && raw.interval_width < 1 ? raw.interval_width : 0.8,
    live: parseLive(raw.live, metric),
    backtest,
  };
}

/** Track record of real stored forecasts, scored by the pipeline. */
function parseLive(raw, metric) {
  if (!raw || typeof raw !== "object" || !Number.isInteger(raw.n) || raw.n < 0) return null;
  const share = (v) => (isNum(v) && v >= 0 && v <= 1 ? v : null);
  return {
    n: raw.n,
    mape: metric(raw.mape),
    naiveMape: metric(raw.naive_mape),
    coverage: share(raw.coverage),
    firstTarget: toMs(raw.first_target),
    lastTarget: toMs(raw.last_target),
    scoredAt: toMs(raw.scored_at),
    byHorizon: Array.isArray(raw.by_horizon)
      ? raw.by_horizon
          .filter((h) => h && isStr(h.label) && Number.isInteger(h.n) && h.n > 0)
          .map((h) => ({ label: h.label, n: h.n, mape: metric(h.mape), naiveMape: metric(h.naive_mape), coverage: share(h.coverage) }))
      : [],
  };
}

const url = (path) => `${MODEL_API_BASE}${path}`;

export const modelApi = {
  base: MODEL_API_BASE,
  async health(signal) {
    return parseHealth(await fetchJson(url("/api/health"), { timeoutMs: 4000, signal }));
  },
  async coins(signal) {
    return parseCoins(await fetchJson(url("/api/coins"), { timeoutMs: 6000, signal }));
  },
  async predict(coinId, horizonDays, signal) {
    return parsePrediction(
      await fetchJson(url("/api/predict"), {
        method: "POST",
        body: { coin_id: coinId, horizon_days: horizonDays },
        timeoutMs: 120_000, // Prophet fits can take a while on first run.
        signal,
      }),
    );
  },
  async metrics(coinId, signal) {
    return parseMetrics(await fetchJson(url(`/api/metrics?coin_id=${encodeURIComponent(coinId)}`), { timeoutMs: 15_000, signal }));
  },
};

export function describeModelError(err) {
  if (!(err instanceof ApiError)) return "The forecast couldn't be completed.";
  if (err.kind === "network") return `The model service at ${MODEL_API_BASE} isn't responding.`;
  if (err.kind === "timeout") return "The model took too long to respond. Try a shorter horizon or run it again.";
  if (err.status === 404) return "The model service doesn't support this request yet.";
  return err.message;
}
