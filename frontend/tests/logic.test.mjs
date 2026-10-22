// Run with: node --test frontend/tests
import test from "node:test";
import assert from "node:assert/strict";

import { formatUsd, formatPct, formatAxisNumber, pctChange, priceDigits } from "../js/format.js";
import { sma, rsi, maxDrawdown, annualizedVolatility, toDailyCloses, summarizeTrend } from "../js/indicators.js";
import { parsePrediction, parseCoins, parseHealth, parseMetrics } from "../js/api/model.js";

test("currency formatting adapts precision to price size", () => {
  assert.equal(formatUsd(67412.2), "$67,412.20");
  assert.equal(formatUsd(0.5123), "$0.5123");
  assert.equal(priceDigits(0.00001234), 8);
  assert.equal(formatUsd(NaN), "—");
  assert.equal(formatUsd(undefined), "—");
});

test("percentages carry an explicit sign and a true minus", () => {
  assert.equal(formatPct(2.345), "+2.35%");
  assert.equal(formatPct(-1.2), "−1.20%");
  assert.equal(formatPct(null), "—");
  assert.equal(pctChange(100, 110), 10);
  assert.equal(pctChange(0, 5), null);
});

test("axis numbers use step-aware precision", () => {
  assert.equal(formatAxisNumber(65000, 1000), "65,000");
  assert.equal(formatAxisNumber(0.25, 0.05), "0.25");
});

test("sma aligns with input and waits for a full window", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
});

test("rsi is 100 for a strictly rising series and bounded otherwise", () => {
  const up = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.equal(rsi(up, 14).at(-1), 100);
  const zig = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 5);
  const last = rsi(zig, 14).at(-1);
  assert.ok(last > 0 && last < 100);
});

test("drawdown and volatility", () => {
  assert.equal(maxDrawdown([100, 120, 60, 90]), -50);
  assert.equal(annualizedVolatility([100, 100, 100, 100]), 0);
});

test("daily resampling keeps the last point of each day", () => {
  const day = 86_400_000;
  const pts = [{ t: 0, v: 1 }, { t: 1000, v: 2 }, { t: day + 5, v: 3 }];
  assert.deepEqual(toDailyCloses(pts).map((p) => p.v), [2, 3]);
});

test("trend summary needs 50 days and labels an uptrend", () => {
  const day = 86_400_000;
  assert.equal(summarizeTrend([{ t: 0, v: 1 }]), null);
  const rising = Array.from({ length: 80 }, (_, i) => ({ t: i * day, v: 100 + i }));
  assert.equal(summarizeTrend(rising).label, "Uptrend");
});

test("prediction parser accepts the documented contract", () => {
  const p = parsePrediction({
    coin_id: "bitcoin",
    horizon_days: 2,
    interval_width: 0.8,
    model: { name: "Prophet", version: "1.1.5" },
    forecast: [
      { date: "2026-10-24", yhat: 101, yhat_lower: 95, yhat_upper: 108 },
      { date: "2026-10-23", yhat: 100, yhat_lower: 96, yhat_upper: 104 },
    ],
  });
  assert.equal(p.points.length, 2);
  assert.ok(p.points[0].t < p.points[1].t, "sorted by date");
  assert.equal(p.hasInterval, true);
  assert.equal(p.intervalWidth, 0.8);
});

test("prediction parser drops an incoherent interval instead of drawing it", () => {
  const p = parsePrediction({ forecast: [{ date: "2026-10-23", yhat: 100, yhat_lower: 101, yhat_upper: 104 }] });
  assert.equal(p.hasInterval, false);
  assert.equal(p.points[0].lo, null);
});

test("prediction parser rejects malformed forecasts", () => {
  assert.throws(() => parsePrediction({ forecast: [] }));
  assert.throws(() => parsePrediction({ forecast: [{ date: "nope", yhat: 1 }] }));
  assert.throws(() => parsePrediction({ forecast: [{ date: "2026-10-23", yhat: "1" }] }));
  assert.throws(() => parsePrediction(null));
});

test("coins, health and metrics parsers", () => {
  const c = parseCoins({ coins: [{ id: "bitcoin", symbol: "btc", name: "Bitcoin" }], horizons: [30, 1, 7, 7, -2] });
  assert.deepEqual(c.horizons, [1, 7, 30]);
  assert.equal(c.coins[0].symbol, "BTC");
  assert.throws(() => parseCoins({ coins: [], horizons: [1] }));
  assert.throws(() => parseHealth({ status: "down" }));
  const m = parseMetrics({ mae: 812.4, mape: -1, backtest: [{ date: "2026-10-01", actual: 1, predicted: 2 }, { date: "x", actual: 1, predicted: 1 }] });
  assert.equal(m.mae, 812.4);
  assert.equal(m.mape, null, "negative metric rejected");
  assert.equal(m.rmse, null, "missing metric stays null");
  assert.equal(m.backtest.length, 1);
  assert.equal(m.baseline, null, "no baseline when absent");
  const b = parseMetrics({ mape: 5.6, baseline: { name: "Last price carried forward", mape: 2.6, mae: 10 } });
  assert.equal(b.baseline.mape, 2.6);
  assert.equal(b.live, null);
  const l = parseMetrics({ mape: 3, coverage: 0.74, live: { n: 12, mape: 3.1, naive_mape: 2.9, coverage: 0.83, by_horizon: [{ label: "1 day", n: 4, mape: 1.2 }, { label: "bad", n: 0 }] } });
  assert.equal(l.coverage, 0.74);
  assert.equal(l.live.n, 12);
  assert.equal(l.live.byHorizon.length, 1, "empty horizon buckets dropped");
  assert.equal(parseMetrics({ coverage: 1.4 }).coverage, null, "out-of-range coverage rejected");
});
