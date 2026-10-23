// Small rendering helpers shared by every page.

import { NEUTRAL_BAND_PCT } from "../config.js";
import { formatPct, pctChange } from "../format.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const icon = (name, cls = "") => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/** +2.31% chip with arrow; colour is never the only signal. */
export function changeChip(pct, { suffix = "" } = {}) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return `<span class="chip">—</span>`;
  const cls = pct > 0 ? "chip-up" : pct < 0 ? "chip-down" : "";
  const ic = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  return `<span class="chip ${cls} num">${icon(ic)}${formatPct(pct)}${suffix ? ` <span class="faint">${esc(suffix)}</span>` : ""}</span>`;
}

export function notice(kind, title, body = "", action = "") {
  const ic = kind === "error" ? "alert" : kind === "warn" ? "plug" : "info";
  return `<div class="notice ${kind ? `notice-${kind}` : ""}" role="${kind === "error" ? "alert" : "status"}">${icon(ic)}<div><strong>${esc(title)}</strong>${body}${action ? `<div style="margin-top:8px">${action}</div>` : ""}</div></div>`;
}

export function skeletonChart(bars = 28) {
  const hs = Array.from({ length: bars }, (_, i) => 30 + 40 * Math.abs(Math.sin(i * 0.55)) + (i % 5) * 4);
  return `<div class="skel-chart" aria-hidden="true">${hs.map((h) => `<span class="skel" style="height:${h}%"></span>`).join("")}</div>`;
}

export const skel = (w, h = 14, extra = "") => `<span class="skel" style="width:${w};height:${h}px;${extra}"></span>`;

/**
 * Forecast direction from the model's final forecast value vs the current price.
 * This is arithmetic on model output, not a separate signal.
 */
export function forecastDirection(currentPrice, prediction) {
  if (!prediction?.points?.length || !Number.isFinite(currentPrice)) return null;
  const end = prediction.points.at(-1);
  const pct = pctChange(currentPrice, end.v);
  const dir = pct > NEUTRAL_BAND_PCT ? "bullish" : pct < -NEUTRAL_BAND_PCT ? "bearish" : "neutral";
  return { dir, pct, end };
}

export function directionBlock(d, horizon) {
  if (!d) return "";
  const names = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" };
  const ic = d.dir === "bullish" ? "up" : d.dir === "bearish" ? "down" : "flat";
  return `<div class="direction" data-dir="${d.dir}">
    <span class="direction-badge">${icon(ic)}</span>
    <div><strong>${names[d.dir]}</strong><span class="label num">${formatPct(d.pct)} over ${horizon} day${horizon === 1 ? "" : "s"}</span></div>
  </div>`;
}

export const offlineHelp = (base, isStatic = false) =>
  isStatic
    ? `<p style="margin-top:4px">Forecasts are published once a day by the data pipeline, and none are available right now. Live prices and market analysis still work.</p>`
    : `<p style="margin-top:4px">Start the prediction service at <code>${esc(base)}</code> and this panel connects automatically. The expected endpoints are in <code>docs/api-contract.md</code>.</p>`;

/** Heading used when forecasts aren't available, in either mode. */
export const offlineTitle = (isStatic) => (isStatic ? "Forecasts unavailable" : "Model service offline");
