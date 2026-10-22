// Live market data from the public CoinGecko API.
// Responses are cached in memory (and sessionStorage, so a reload doesn't
// burn the free rate limit) and validated before the UI sees them.

import { COINGECKO_BASE } from "../config.js";
import { ApiError, fetchJson } from "./http.js";

const memory = new Map();
const inflight = new Map();

function readSession(key) {
  try {
    const raw = sessionStorage.getItem(`sibyl.cg.${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSession(key, entry) {
  try {
    sessionStorage.setItem(`sibyl.cg.${key}`, JSON.stringify(entry));
  } catch {
    /* storage full or blocked: memory cache still works */
  }
}

/**
 * Cached GET. Returns { data, fetchedAt, fromCache }.
 * If the network fails but a stale copy exists, the stale copy is returned with
 * `stale: true` so the UI can keep showing real (older) data and say so.
 */
async function cachedGet(key, url, ttlMs, { force = false } = {}) {
  const now = Date.now();
  const hit = memory.get(key) || readSession(key);
  if (hit && !force && now - hit.fetchedAt < ttlMs) {
    memory.set(key, hit);
    return { ...hit, fromCache: true, stale: false };
  }
  if (inflight.has(key)) return inflight.get(key);

  const p = fetchJson(url)
    .then((data) => {
      const entry = { data, fetchedAt: Date.now() };
      memory.set(key, entry);
      writeSession(key, entry);
      return { ...entry, fromCache: false, stale: false };
    })
    .catch((err) => {
      if (hit) return { ...hit, fromCache: true, stale: true, error: err };
      throw err;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Snapshot for a set of coins: price, 24h change, market cap, volume, 7d sparkline. */
export async function getMarkets(ids, opts) {
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids.join(","))}&sparkline=true&price_change_percentage=24h,7d`;
  const res = await cachedGet(`markets:${ids.join(",")}`, url, 55_000, opts);
  if (!Array.isArray(res.data)) throw new ApiError("Market data came back in an unexpected format.", { kind: "invalid" });

  const rows = res.data
    .map((c) => ({
      id: String(c.id),
      symbol: String(c.symbol || "").toUpperCase(),
      name: String(c.name || c.id),
      image: typeof c.image === "string" ? c.image : null,
      price: num(c.current_price),
      change24h: num(c.price_change_24h),
      changePct24h: num(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
      changePct7d: num(c.price_change_percentage_7d_in_currency),
      high24h: num(c.high_24h),
      low24h: num(c.low_24h),
      marketCap: num(c.market_cap),
      volume24h: num(c.total_volume),
      rank: num(c.market_cap_rank),
      sparkline: Array.isArray(c.sparkline_in_7d?.price) ? c.sparkline_in_7d.price.filter((v) => num(v) !== null) : [],
      lastUpdated: c.last_updated || null,
    }))
    .filter((r) => r.price !== null);

  return { rows, fetchedAt: res.fetchedAt, stale: res.stale, error: res.error };
}

/** Price + volume history. Points are { t: ms, v: number }. */
export async function getHistory(coinId, days, opts) {
  const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}`;
  const ttl = days <= 1 ? 60_000 : days <= 7 ? 5 * 60_000 : 15 * 60_000;
  const res = await cachedGet(`chart:${coinId}:${days}`, url, ttl, opts);
  const d = res.data;
  if (!d || !Array.isArray(d.prices)) throw new ApiError("Price history came back in an unexpected format.", { kind: "invalid" });

  const clean = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .filter((p) => Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null)
      .map(([t, v]) => ({ t, v }))
      .sort((a, b) => a.t - b.t);

  const prices = clean(d.prices);
  if (prices.length < 2) throw new ApiError("Not enough price history for this range.", { kind: "invalid" });
  return { prices, volumes: clean(d.total_volumes), fetchedAt: res.fetchedAt, stale: res.stale, error: res.error };
}

/** Short, user-facing description of a market data failure. */
export function describeMarketError(err) {
  if (!(err instanceof ApiError)) return "Market data couldn't be loaded.";
  switch (err.kind) {
    case "rate_limit":
      return `CoinGecko's free rate limit was reached. Data will retry in about ${err.retryAfter ?? 60} seconds.`;
    case "network":
      return "CoinGecko couldn't be reached. Check your connection; the page retries automatically.";
    case "timeout":
      return "CoinGecko took too long to respond. The page retries automatically.";
    default:
      return err.message;
  }
}
