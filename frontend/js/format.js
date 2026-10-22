// Number, currency, percentage and date formatting used everywhere in the UI.
// All formatters return "—" for missing or non-finite input so a gap never
// renders as "NaN" or "$0.00".

const DASH = "—";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Fraction digits that keep ~4 significant figures for small prices. */
export function priceDigits(value) {
  const abs = Math.abs(value);
  if (abs >= 1000) return 2;
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  if (abs === 0) return 2;
  return Math.min(8, Math.max(4, 3 - Math.floor(Math.log10(abs))));
}

export function formatUsd(value, { compact = false, digits } = {}) {
  if (!isNum(value)) return DASH;
  if (compact) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(value);
  }
  const d = digits ?? priceDigits(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }).format(value);
}

/** Plain number for axis labels: 67,400 / 67.4K / 0.1234 */
export function formatAxisNumber(value, step) {
  if (!isNum(value)) return DASH;
  const abs = Math.abs(value);
  if (abs >= 100_000) {
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }
  const s = isNum(step) && step > 0 ? step : abs || 1;
  const d = s >= 1 ? 0 : Math.min(8, Math.ceil(-Math.log10(s)));
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(value);
}

export function formatPct(value, { signed = true, digits = 2 } = {}) {
  if (!isNum(value)) return DASH;
  const sign = signed && value > 0 ? "+" : "";
  // U+2212 minus sign aligns with "+" in tabular figures.
  const body = Math.abs(value).toFixed(digits);
  return value < 0 ? `−${body}%` : `${sign}${body}%`;
}

export function formatSignedUsd(value) {
  if (!isNum(value)) return DASH;
  const body = formatUsd(Math.abs(value));
  return value < 0 ? `−${body}` : `+${body}`;
}

export function formatNumber(value, digits = 2) {
  if (!isNum(value)) return DASH;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

const toDate = (v) => (v instanceof Date ? v : new Date(v));

export function formatDate(value, opts = { month: "short", day: "numeric", year: "numeric" }) {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return new Intl.DateTimeFormat("en-US", opts).format(d);
}

export function formatDateTime(value) {
  return formatDate(value, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatTime(value) {
  return formatDate(value, { hour: "2-digit", minute: "2-digit" });
}

/** "just now", "4 min ago", "3 h ago", or a date. */
export function formatRelative(value, now = Date.now()) {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return DASH;
  const sec = Math.round((now - d.getTime()) / 1000);
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)} h ago`;
  return formatDate(d);
}

export function pctChange(from, to) {
  if (!isNum(from) || !isNum(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}
