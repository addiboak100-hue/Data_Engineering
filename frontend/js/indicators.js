// Technical indicators computed in the browser from CoinGecko price history.
// These describe the market; they are NOT inputs to the forecast model and the
// UI labels them that way.

/** Simple moving average. Returns an array aligned with `values` (null until enough data). */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Relative Strength Index with Wilder smoothing. */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Annualised volatility (%) from daily closes. Crypto trades every day, so 365. */
export function annualizedVolatility(dailyCloses) {
  if (dailyCloses.length < 3) return null;
  const rets = [];
  for (let i = 1; i < dailyCloses.length; i++) rets.push(Math.log(dailyCloses[i] / dailyCloses[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

/** Largest peak-to-trough fall (%), returned as a negative number. */
export function maxDrawdown(values) {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < worst) worst = dd;
  }
  return values.length ? worst * 100 : null;
}

/** Collapse intraday points into one close per UTC day (last value of the day). */
export function toDailyCloses(points) {
  const byDay = new Map();
  for (const p of points) byDay.set(Math.floor(p.t / 86_400_000), p);
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

/**
 * Plain-language trend read from daily closes. Every field is a computed fact;
 * `label` is a rule-based description, not a prediction.
 */
export function summarizeTrend(daily) {
  const closes = daily.map((p) => p.v);
  const n = closes.length;
  if (n < 50) return null;
  const s20 = sma(closes, 20)[n - 1];
  const s50 = sma(closes, 50)[n - 1];
  const r = rsi(closes, 14)[n - 1];
  const last = closes[n - 1];
  const vol30 = annualizedVolatility(closes.slice(-31));

  let label = "Range-bound";
  if (last > s20 && s20 > s50) label = "Uptrend";
  else if (last < s20 && s20 < s50) label = "Downtrend";

  let momentum = "Neutral momentum";
  if (r >= 70) momentum = "Overbought (RSI ≥ 70)";
  else if (r <= 30) momentum = "Oversold (RSI ≤ 30)";

  return { last, sma20: s20, sma50: s50, rsi14: r, vol30, label, momentum };
}
