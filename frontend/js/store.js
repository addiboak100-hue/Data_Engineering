// App state and the actions that change it. Components subscribe and re-render
// the parts they own; nothing else mutates state.

import { DEFAULT_COIN, DEFAULT_TIMEFRAME, MARKET_COINS, PRICE_REFRESH_MS, STALE_AFTER_MS, TIMEFRAMES } from "./config.js";
import { getMarkets } from "./api/market.js";
import { describeModelError, modelApi } from "./api/model.js";

function readPref(key, fallback, allowed) {
  try {
    const v = localStorage.getItem(`sibyl.${key}`);
    return v && (!allowed || allowed.includes(v)) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(`sibyl.${key}`, value);
  } catch {
    /* ignore */
  }
}

const state = {
  coinId: readPref("coin", DEFAULT_COIN, MARKET_COINS.map((c) => c.id)),
  timeframe: readPref("timeframe", DEFAULT_TIMEFRAME, TIMEFRAMES.map((t) => t.id)),
  horizon: null,
  market: { status: "loading", rows: [], fetchedAt: null, stale: false, error: null },
  model: { status: "checking", info: null, coins: [], horizons: [], error: null, checkedAt: null },
  predictions: {}, // key `${coin}:${horizon}` → { status, data, error }
  metrics: {}, // key coin → { status, data, error }
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(change) {
  for (const fn of listeners) fn(state, change);
}
export const getState = () => state;

export const coinMeta = (id) =>
  state.model.coins.find((c) => c.id === id) || MARKET_COINS.find((c) => c.id === id) || { id, symbol: id.toUpperCase(), name: id };
export const marketRow = (id = state.coinId) => state.market.rows.find((r) => r.id === id) || null;
export const isPredictable = (id = state.coinId) => state.model.status === "online" && state.model.coins.some((c) => c.id === id);
export const predictionKey = (coin = state.coinId, h = state.horizon) => `${coin}:${h}`;
export const currentPrediction = () => state.predictions[predictionKey()] || null;

/** "live" | "stale" | "error" | "loading" for the header indicator. */
export function marketHealth() {
  const m = state.market;
  if (m.status === "loading" && !m.fetchedAt) return "loading";
  if (!m.fetchedAt) return "error";
  if (m.stale || Date.now() - m.fetchedAt > STALE_AFTER_MS) return "stale";
  return "live";
}

export function setCoin(id) {
  if (id === state.coinId) return;
  state.coinId = id;
  writePref("coin", id);
  emit("coin");
  loadMetrics();
}

export function setTimeframe(id) {
  if (id === state.timeframe) return;
  state.timeframe = id;
  writePref("timeframe", id);
  emit("timeframe");
}

export function setHorizon(h) {
  if (h === state.horizon) return;
  state.horizon = h;
  writePref("horizon", String(h));
  emit("horizon");
}

export async function refreshMarket({ force = false } = {}) {
  const ids = MARKET_COINS.map((c) => c.id);
  if (!state.market.fetchedAt) state.market.status = "loading";
  emit("market");
  try {
    const res = await getMarkets(ids, { force });
    state.market = { status: "ready", rows: res.rows, fetchedAt: res.fetchedAt, stale: !!res.stale, error: res.error || null };
  } catch (err) {
    state.market = { ...state.market, status: "error", error: err };
  }
  emit("market");
}

let modelCtl = null;
export async function checkModel() {
  modelCtl?.abort();
  modelCtl = new AbortController();
  state.model = { ...state.model, status: "checking", error: null };
  emit("model");
  try {
    const health = await modelApi.health(modelCtl.signal);
    const { coins, horizons } = await modelApi.coins(modelCtl.signal);
    const saved = Number(readPref("horizon", "", null));
    state.horizon = horizons.includes(saved) ? saved : horizons.includes(7) ? 7 : horizons[0];
    state.model = { status: "online", info: health.model, coins, horizons, error: null, checkedAt: Date.now() };
    emit("model");
    loadMetrics();
  } catch (err) {
    if (err?.name === "AbortError") return;
    state.model = { status: "offline", info: null, coins: [], horizons: [], error: describeModelError(err), checkedAt: Date.now() };
    emit("model");
  }
}

const predictCtl = new Map();
export async function runPrediction(coin = state.coinId, horizon = state.horizon) {
  if (!isPredictable(coin) || !state.model.horizons.includes(horizon)) return;
  const key = predictionKey(coin, horizon);
  predictCtl.get(key)?.abort();
  const ctl = new AbortController();
  predictCtl.set(key, ctl);
  state.predictions[key] = { status: "running", data: state.predictions[key]?.data || null, error: null, startedAt: Date.now() };
  emit("prediction");
  try {
    const data = await modelApi.predict(coin, horizon, ctl.signal);
    state.predictions[key] = { status: "ready", data, error: null };
  } catch (err) {
    if (err?.name === "AbortError") return;
    state.predictions[key] = { status: "error", data: state.predictions[key]?.data || null, error: describeModelError(err) };
  }
  emit("prediction");
}

export async function loadMetrics(coin = state.coinId) {
  if (!isPredictable(coin)) return;
  const existing = state.metrics[coin];
  if (existing && (existing.status === "loading" || existing.status === "ready")) return;
  state.metrics[coin] = { status: "loading", data: null, error: null };
  emit("metrics");
  try {
    state.metrics[coin] = { status: "ready", data: await modelApi.metrics(coin), error: null };
  } catch (err) {
    state.metrics[coin] = { status: "error", data: null, error: describeModelError(err) };
  }
  emit("metrics");
}

export function startPolling() {
  refreshMarket();
  checkModel();
  setInterval(() => {
    if (document.visibilityState === "visible") refreshMarket();
  }, PRICE_REFRESH_MS);
  // Re-check an offline model occasionally so starting the backend "just works".
  setInterval(() => {
    if (state.model.status === "offline" && document.visibilityState === "visible") checkModel();
  }, 30_000);
  // Keep relative timestamps fresh.
  setInterval(() => emit("tick"), 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && marketHealth() !== "live") refreshMarket();
  });
}
