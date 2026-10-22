// Dependency-free SVG time-series chart.
//
// Supports line series (solid or dashed), an optional area fill, an optional
// uncertainty band, a "now" seam that separates history from forecast, bar
// series (volume), horizontal guides, right-axis price tags, a crosshair
// tooltip, and keyboard navigation (←/→, Home/End, Esc).

import { formatAxisNumber, formatDate, formatDateTime, formatUsd } from "../format.js";

const NS = "http://www.w3.org/2000/svg";
let uid = 0;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

function niceTicks(min, max, target) {
  if (min === max) {
    const pad = Math.abs(min) * 0.01 || 1;
    min -= pad;
    max += pad;
  }
  const step = niceStep(max - min, target);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toPrecision(12));
  return { ticks, step };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TIME_STEPS = [5 * MIN, 15 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY];

function timeTicks(t0, t1, target) {
  const span = t1 - t0;
  const raw = span / Math.max(1, target);
  if (raw > 20 * DAY) {
    // Month boundaries.
    const monthsPer = raw > 150 * DAY ? 6 : raw > 75 * DAY ? 3 : raw > 45 * DAY ? 2 : 1;
    const d = new Date(t0);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    const out = [];
    while (d.getTime() <= t1) {
      if (d.getTime() >= t0 && d.getMonth() % monthsPer === 0) out.push(d.getTime());
      d.setMonth(d.getMonth() + 1);
    }
    return { ticks: out, unit: "month" };
  }
  const step = TIME_STEPS.find((s) => s >= raw) || 14 * DAY;
  const offset = new Date(t0).getTimezoneOffset() * MIN;
  const start = Math.ceil((t0 - offset) / step) * step + offset;
  const out = [];
  for (let t = start; t <= t1; t += step) out.push(t);
  return { ticks: out, unit: step < DAY ? "time" : "day" };
}

function tickLabel(t, unit) {
  if (unit === "time") {
    const d = new Date(t);
    if (d.getHours() === 0 && d.getMinutes() === 0) return formatDate(t, { month: "short", day: "numeric" });
    return formatDate(t, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  if (unit === "month") {
    const d = new Date(t);
    return d.getMonth() === 0 ? String(d.getFullYear()) : formatDate(t, { month: "short" });
  }
  return formatDate(t, { month: "short", day: "numeric" });
}

/** Index of the point nearest to t (points sorted by t). */
function nearest(points, t) {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo].t - t) <= Math.abs(points[hi].t - t) ? lo : hi;
}

function linePath(points, x, y) {
  let d = "";
  for (let i = 0; i < points.length; i++) d += `${i ? "L" : "M"}${x(points[i].t).toFixed(1)},${y(points[i].v).toFixed(1)}`;
  return d;
}

/**
 * @param {HTMLElement} root
 * @param {object} opts { height, ariaLabel, valueFormat?, compact? }
 */
export function createTimeChart(root, opts = {}) {
  const id = `c${++uid}`;
  const height = opts.height || 360;
  const valueFormat = opts.valueFormat || ((v) => formatUsd(v));
  let data = null;
  let width = 0;
  let geom = null;
  let hoverIdx = -1;
  let drawnOnce = false;

  root.classList.add("tchart");
  root.innerHTML = `
    <div class="tchart-plot" tabindex="0" role="img" aria-label="${esc(opts.ariaLabel || "Chart")}">
      <svg class="tchart-svg" xmlns="${NS}" height="${height}" aria-hidden="true"></svg>
      <div class="tchart-tip" role="status" aria-live="polite" hidden></div>
    </div>`;
  const plot = root.querySelector(".tchart-plot");
  const svg = root.querySelector("svg");
  const tip = root.querySelector(".tchart-tip");

  function layout() {
    const compact = width < 520;
    return { top: 28, right: compact ? 58 : 76, bottom: 28, left: compact ? 4 : 8 };
  }

  function render() {
    if (!data || !width) return;
    const m = layout();
    const W = width;
    const H = height;
    const innerW = W - m.left - m.right;
    const innerH = H - m.top - m.bottom;

    const lineSeries = data.series.filter((s) => s.type !== "bars" && s.points.length);
    const barSeries = data.series.filter((s) => s.type === "bars" && s.points.length);
    const all = data.series.flatMap((s) => s.points);
    if (!all.length) return;

    let t0 = Math.min(...all.map((p) => p.t));
    let t1 = Math.max(...all.map((p) => p.t));
    if (data.band) t1 = Math.max(t1, ...data.band.points.map((p) => p.t));
    if (t0 === t1) t1 = t0 + HOUR;

    let vmin;
    let vmax;
    if (data.yDomain) [vmin, vmax] = data.yDomain;
    else {
      const vals = lineSeries.flatMap((s) => s.points.map((p) => p.v));
      if (data.band) data.band.points.forEach((p) => vals.push(p.lo, p.hi));
      if (barSeries.length) vals.push(0, ...barSeries.flatMap((s) => s.points.map((p) => p.v)));
      vmin = Math.min(...vals);
      vmax = Math.max(...vals);
      const pad = (vmax - vmin) * 0.08 || Math.abs(vmax) * 0.01 || 1;
      vmax += pad;
      vmin = barSeries.length ? 0 : vmin - pad;
    }

    const x = (t) => m.left + ((t - t0) / (t1 - t0)) * innerW;
    const y = (v) => m.top + (1 - (v - vmin) / (vmax - vmin)) * innerH;
    geom = { x, y, m, W, H, innerW, innerH, t0, t1 };

    const yt = niceTicks(vmin, vmax, Math.max(3, Math.round(innerH / 64)));
    const xt = timeTicks(t0, t1, Math.max(2, Math.round(innerW / 110)));
    const fmtAxis = data.axisFormat || ((v) => formatAxisNumber(v, yt.step));

    // Right-axis tags (current price, forecast end). Hide tick labels they'd collide with.
    const tags = (data.tags || []).filter((tg) => Number.isFinite(tg.v) && tg.v >= vmin && tg.v <= vmax);
    const tagYs = tags.map((tg) => y(tg.v));
    for (let i = 1; i < tagYs.length; i++) if (Math.abs(tagYs[i] - tagYs[i - 1]) < 20) tagYs[i] = tagYs[i - 1] + (tagYs[i] >= tagYs[i - 1] ? 20 : -20);

    let s = `<defs>
      <linearGradient id="${id}-area" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--series-history)" stop-opacity="0.22"/>
        <stop offset="1" stop-color="var(--series-history)" stop-opacity="0"/>
      </linearGradient>
      <pattern id="${id}-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="var(--series-forecast)" stroke-opacity="0.10" stroke-width="2"/>
      </pattern>
      <clipPath id="${id}-clip"><rect x="${m.left}" y="${m.top - 2}" width="${innerW}" height="${innerH + 4}"/></clipPath>
    </defs>`;

    // Forecast region: the seam is the one bold element on the page.
    if (Number.isFinite(data.now) && data.now < t1) {
      const nx = x(data.now);
      s += `<rect class="fc-region" x="${nx}" y="${m.top}" width="${m.left + innerW - nx}" height="${innerH}" fill="url(#${id}-hatch)"/>`;
    }

    // Grid + y labels.
    for (const v of yt.ticks) {
      if (v < vmin || v > vmax) continue;
      const yy = y(v);
      s += `<line class="grid" x1="${m.left}" x2="${m.left + innerW}" y1="${yy}" y2="${yy}"/>`;
      if (!tagYs.some((ty) => Math.abs(ty - yy) < 14)) s += `<text class="axis axis-y" x="${W - m.right + 10}" y="${yy}" dy="0.32em">${esc(fmtAxis(v))}</text>`;
    }
    // X labels.
    const minGap = 64;
    let lastX = -Infinity;
    for (const t of xt.ticks) {
      const xx = x(t);
      if (xx - lastX < minGap || xx < m.left + 16 || xx > m.left + innerW - 16) continue;
      lastX = xx;
      s += `<text class="axis axis-x" x="${xx}" y="${H - 8}" text-anchor="middle">${esc(tickLabel(t, xt.unit))}</text>`;
    }

    // Guides (e.g. RSI 30/70).
    for (const g of data.guides || []) {
      const yy = y(g.v);
      s += `<line class="guide" x1="${m.left}" x2="${m.left + innerW}" y1="${yy}" y2="${yy}"/>`;
      s += `<text class="axis guide-label" x="${m.left + 6}" y="${yy - 6}">${esc(g.label)}</text>`;
    }

    s += `<g clip-path="url(#${id}-clip)">`;
    // Bars.
    for (const bs of barSeries) {
      const n = bs.points.length;
      const bw = Math.max(1, Math.min(10, innerW / n - 2));
      for (const p of bs.points) {
        const yy = y(p.v);
        const h = Math.max(1, y(0) - yy);
        s += `<rect class="bar" x="${(x(p.t) - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(2, bw / 2)}" fill="${bs.color}"/>`;
      }
    }
    // Band.
    if (data.band?.points.length) {
      const bp = data.band.points;
      let d = "";
      bp.forEach((p, i) => (d += `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.hi).toFixed(1)}`));
      for (let i = bp.length - 1; i >= 0; i--) d += `L${x(bp[i].t).toFixed(1)},${y(bp[i].lo).toFixed(1)}`;
      s += `<path class="band" d="${d}Z"/>`;
    }
    // Lines.
    for (const ls of lineSeries) {
      const d = linePath(ls.points, x, y);
      if (ls.area) {
        const base = m.top + innerH;
        s += `<path d="${d}L${x(ls.points.at(-1).t).toFixed(1)},${base}L${x(ls.points[0].t).toFixed(1)},${base}Z" fill="url(#${id}-area)"/>`;
      }
      const cls = ["line", ls.dashed ? "dashed" : "", ls.animate && !drawnOnce ? "draw" : ""].join(" ");
      s += `<path class="${cls}" d="${d}" stroke="${ls.color}" stroke-width="${ls.width || 2}" pathLength="1000"/>`;
    }
    s += `</g>`;

    // Seam on top of everything plotted.
    if (Number.isFinite(data.now) && data.now < t1) {
      const nx = x(data.now);
      s += `<line class="seam" x1="${nx}" x2="${nx}" y1="${m.top - 10}" y2="${m.top + innerH}"/>`;
      const fcW = m.left + innerW - nx;
      s += `<text class="seam-label" x="${nx - 8}" y="${m.top - 12}" text-anchor="end">History</text>`;
      if (fcW > 70) s += `<text class="seam-label seam-label-fc" x="${nx + 8}" y="${m.top - 12}">${esc(data.forecastLabel || "Forecast")}</text>`;
    }

    // Endpoint dots for line series flagged `endDot`.
    for (const ls of lineSeries) {
      if (!ls.endDot) continue;
      const p = ls.points.at(-1);
      s += `<circle class="end-dot" cx="${x(p.t)}" cy="${y(p.v)}" r="4" fill="${ls.color}"/>`;
    }

    // Tags.
    tags.forEach((tg, i) => {
      const ty = tagYs[i];
      const tw = m.right - 8;
      s += `<g class="tag"><line x1="${m.left}" x2="${m.left + innerW}" y1="${y(tg.v)}" y2="${y(tg.v)}" stroke="${tg.color}" class="tag-rule"/>
        <rect x="${W - m.right + 4}" y="${ty - 10}" width="${tw}" height="20" rx="4" fill="${tg.color}"/>
        <text class="tag-text" x="${W - m.right + 4 + tw / 2}" y="${ty}" dy="0.34em" text-anchor="middle">${esc(fmtAxis(tg.v))}</text></g>`;
    });

    // Hover layer.
    s += `<g class="hover" visibility="hidden"><line class="xhair" y1="${m.top}" y2="${m.top + innerH}"/><g class="hover-dots"></g></g>`;

    svg.setAttribute("width", W);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = s;
    drawnOnce = true;
    buildIndex();
    if (hoverIdx >= 0) showHover(hoverIdx);
  }

  // Unique timestamps across all series for crosshair snapping.
  let index = [];
  function buildIndex() {
    const set = new Set();
    data.series.forEach((s) => s.points.forEach((p) => set.add(p.t)));
    index = [...set].sort((a, b) => a - b).map((t) => ({ t }));
    if (hoverIdx >= index.length) hoverIdx = index.length - 1;
  }

  function showHover(i) {
    if (!geom || !index.length) return;
    hoverIdx = Math.max(0, Math.min(index.length - 1, i));
    const t = index[hoverIdx].t;
    const { x, y } = geom;
    const g = svg.querySelector(".hover");
    const xx = x(t);
    g.querySelector(".xhair").setAttribute("x1", xx);
    g.querySelector(".xhair").setAttribute("x2", xx);
    let dots = "";
    const rows = [];
    for (const s of data.series) {
      if (!s.points.length || t < s.points[0].t || t > s.points.at(-1).t) continue;
      const p = s.points[nearest(s.points, t)];
      if (Math.abs(p.t - t) > (s.snapTolerance ?? Infinity)) continue;
      if (s.tooltipAfter !== undefined && p.t <= s.tooltipAfter) continue;
      if (s.type !== "bars") dots += `<circle cx="${x(p.t)}" cy="${y(p.v)}" r="4.5" fill="${s.color}" class="hover-dot"/>`;
      if (s.tooltip !== false) rows.push({ label: s.label, color: s.color, dashed: s.dashed, value: (s.format || valueFormat)(p.v), t: p.t });
    }
    if (data.band?.points.length) {
      const bp = data.band.points;
      if (t >= bp[0].t && t <= bp.at(-1).t) {
        const p = bp[nearest(bp, t)];
        if (!(Number.isFinite(data.now) && p.t <= data.now)) rows.push({ label: data.band.label, color: null, value: `${valueFormat(p.lo)} – ${valueFormat(p.hi)}` });
      }
    }
    g.querySelector(".hover-dots").innerHTML = dots;
    g.setAttribute("visibility", "visible");

    const spanMs = geom.t1 - geom.t0;
    const isFc = Number.isFinite(data.now) && t > data.now;
    tip.innerHTML = `<div class="tip-date">${esc(spanMs <= 3 * DAY ? formatDateTime(t) : formatDate(t, { weekday: "short", month: "short", day: "numeric", year: "numeric" }))}${isFc ? '<span class="tip-flag">Forecast</span>' : ""}</div>
      ${rows
        .map(
          (r) => `<div class="tip-row"><span class="tip-key">${r.color ? `<i class="swatch${r.dashed ? " swatch-dashed" : ""}" style="--c:${r.color}"></i>` : '<i class="swatch swatch-band"></i>'}${esc(r.label)}</span><span class="tip-val">${esc(r.value)}</span></div>`,
        )
        .join("")}`;
    tip.hidden = rows.length === 0;
    const tipW = tip.offsetWidth;
    const left = xx + 16 + tipW > geom.W - geom.m.right ? xx - 16 - tipW : xx + 16;
    tip.style.transform = `translate(${Math.max(4, left)}px, ${geom.m.top + 4}px)`;
  }

  function hideHover() {
    hoverIdx = -1;
    svg.querySelector(".hover")?.setAttribute("visibility", "hidden");
    tip.hidden = true;
  }

  function idxFromX(clientX) {
    const rect = svg.getBoundingClientRect();
    const px = clientX - rect.left;
    const t = geom.t0 + ((px - geom.m.left) / geom.innerW) * (geom.t1 - geom.t0);
    return nearest(index, t);
  }

  plot.addEventListener("pointermove", (e) => geom && index.length && showHover(idxFromX(e.clientX)));
  plot.addEventListener("pointerleave", (e) => e.pointerType !== "touch" && hideHover());
  plot.addEventListener("keydown", (e) => {
    if (!index.length) return;
    const step = e.shiftKey ? 10 : 1;
    const start = hoverIdx < 0 ? index.length - 1 : hoverIdx;
    if (e.key === "ArrowLeft") showHover(start - step);
    else if (e.key === "ArrowRight") showHover(hoverIdx < 0 ? start : start + step);
    else if (e.key === "Home") showHover(0);
    else if (e.key === "End") showHover(index.length - 1);
    else if (e.key === "Escape") hideHover();
    else return;
    e.preventDefault();
  });
  plot.addEventListener("blur", hideHover);

  const ro = new ResizeObserver((entries) => {
    const w = Math.floor(entries[0].contentRect.width);
    if (w && w !== width) {
      width = w;
      render();
    }
  });
  ro.observe(plot);

  return {
    update(next) {
      data = next;
      if (opts.ariaLabel && next.ariaLabel) plot.setAttribute("aria-label", next.ariaLabel);
      if (!width) width = Math.floor(plot.clientWidth);
      render();
    },
    destroy() {
      ro.disconnect();
      root.innerHTML = "";
    },
  };
}

/** Minimal sparkline (no axes, no interaction) for tables. */
export function sparklineSvg(values, { width = 120, height = 32, color } = {}) {
  if (!values || values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (i) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v) => (max === min ? height / 2 : 2 + (1 - (v - min) / (max - min)) * (height - 4));
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
