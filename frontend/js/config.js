// Sibyl frontend configuration.
//
// MODEL_API_BASE points at the prediction service (src/ in this repo, once built).
// Override without editing code by opening the app with ?api=http://host:port
// or by setting localStorage key "sibyl.api".

const DEFAULT_MODEL_API_BASE = "http://localhost:8000";

function readOverride() {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("api");
    if (fromQuery) {
      localStorage.setItem("sibyl.api", fromQuery);
      return fromQuery;
    }
    return localStorage.getItem("sibyl.api");
  } catch {
    return null;
  }
}

const apiOverride = readOverride();
export const MODEL_API_BASE = (apiOverride || DEFAULT_MODEL_API_BASE).replace(/\/+$/, "");

// Where forecasts come from:
//   "api"    the live Python service (src/api.py), used when running locally
//   "static" JSON files published daily by the pipeline (data/), used when the
//            site is hosted, e.g. on GitHub Pages, where no server runs
// ?source=api or ?source=static forces one for testing.
function pickSource() {
  try {
    const forced = new URLSearchParams(window.location.search).get("source");
    if (forced === "api" || forced === "static") return forced;
  } catch {
    /* ignore */
  }
  if (apiOverride) return "api";
  const host = typeof window === "undefined" ? "" : window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "" ? "api" : "static";
}

export const MODEL_SOURCE = pickSource();
export const STATIC_DATA_BASE = "data"; // relative, so it works under any sub-path

// Public CoinGecko API: no key required, so nothing secret ships to the browser.
// Keep COINGECKO_KEY / CMC_API_KEY in .env for the Python backend only.
export const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

// Coins Sibyl can show market data for. Which of these the model can forecast
// is decided by the backend's GET /api/coins response, never by this list.
export const MARKET_COINS = [
  { id: "bitcoin", symbol: "BTC", name: "Bitcoin" },
  { id: "ethereum", symbol: "ETH", name: "Ethereum" },
  { id: "solana", symbol: "SOL", name: "Solana" },
  { id: "binancecoin", symbol: "BNB", name: "BNB" },
  { id: "ripple", symbol: "XRP", name: "XRP" },
  { id: "cardano", symbol: "ADA", name: "Cardano" },
  { id: "dogecoin", symbol: "DOGE", name: "Dogecoin" },
];

// Chart ranges, mapped to CoinGecko's market_chart `days` parameter.
// CoinGecko returns ~5-minute points for 1 day, hourly up to 90 days, daily beyond.
export const TIMEFRAMES = [
  { id: "1D", label: "1D", days: 1, long: "24 hours" },
  { id: "7D", label: "7D", days: 7, long: "7 days" },
  { id: "1M", label: "1M", days: 30, long: "30 days" },
  { id: "3M", label: "3M", days: 90, long: "90 days" },
  { id: "1Y", label: "1Y", days: 365, long: "1 year" },
];

export const DEFAULT_COIN = "bitcoin";
export const DEFAULT_TIMEFRAME = "1M";

// How often the header price refreshes, and when data counts as stale.
export const PRICE_REFRESH_MS = 60_000;
export const STALE_AFTER_MS = 3 * 60_000;

// A forecast within ±this % of the current price is labelled neutral.
export const NEUTRAL_BAND_PCT = 1;
