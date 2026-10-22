import { MARKET_COINS } from "./config.js";
import { formatRelative } from "./format.js";
import { coinMeta, getState, marketHealth, setCoin, startPolling, subscribe } from "./store.js";
import { mountDashboard } from "./pages/dashboard.js";
import { mountPredictions } from "./pages/predictions.js";
import { mountMarket } from "./pages/market.js";
import { mountModel } from "./pages/model.js";
import { mountAbout } from "./pages/about.js";

const ROUTES = {
  dashboard: { mount: mountDashboard, title: "Dashboard" },
  predictions: { mount: mountPredictions, title: "Predictions" },
  market: { mount: mountMarket, title: "Market Analysis" },
  model: { mount: mountModel, title: "Model Insights" },
  about: { mount: mountAbout, title: "About" },
};

const view = document.getElementById("view");
const nav = document.getElementById("nav");
const menuBtn = document.getElementById("menu-btn");
const coinSelect = document.getElementById("coin-select");
const marketStatus = document.getElementById("market-status");
const modelStatus = document.getElementById("model-status");
const footerModel = document.getElementById("footer-model");

let cleanup = null;
let current = null;

function route() {
  const name = (location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "dashboard").toLowerCase();
  const r = ROUTES[name] ? name : "dashboard";
  if (!ROUTES[name] && location.hash) history.replaceState(null, "", "#/dashboard");
  const firstLoad = current === null;
  if (r === current) return;
  current = r;

  cleanup?.();
  view.innerHTML = "";
  cleanup = ROUTES[r].mount(view) || null;

  nav.querySelectorAll("a").forEach((a) => {
    if (a.dataset.route === r) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  closeMenu();
  updateTitle();
  if (!firstLoad) {
    window.scrollTo({ top: 0 });
    document.getElementById("main").focus({ preventScroll: true });
  }
}

function updateTitle() {
  const st = getState();
  const row = st.market.rows.find((r) => r.id === st.coinId);
  const meta = coinMeta(st.coinId);
  const price = row ? ` ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: row.price >= 1 ? 0 : 4 }).format(row.price)}` : "";
  document.title = `${meta.symbol}${price} · ${ROUTES[current]?.title ?? "Sibyl"} · Sibyl`;
}

function closeMenu() {
  nav.classList.remove("open");
  menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.setAttribute("aria-label", "Open menu");
  menuBtn.querySelector("use").setAttribute("href", "#i-menu");
}
menuBtn.addEventListener("click", () => {
  const open = !nav.classList.contains("open");
  nav.classList.toggle("open", open);
  menuBtn.setAttribute("aria-expanded", String(open));
  menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  menuBtn.querySelector("use").setAttribute("href", open ? "#i-close" : "#i-menu");
  if (open) nav.querySelector("a")?.focus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && nav.classList.contains("open")) {
    closeMenu();
    menuBtn.focus();
  }
});

function renderCoinSelect() {
  const st = getState();
  coinSelect.innerHTML = MARKET_COINS.map(
    (c) => `<option value="${c.id}" ${c.id === st.coinId ? "selected" : ""}>${c.symbol}</option>`,
  ).join("");
  coinSelect.title = `${coinMeta(st.coinId).name}`;
}
coinSelect.addEventListener("change", () => setCoin(coinSelect.value));

function renderStatuses() {
  const st = getState();
  const h = marketHealth();
  marketStatus.dataset.state = h;
  const mText = { live: "Live", stale: "Delayed", error: "Market data offline", loading: "Connecting" }[h];
  marketStatus.querySelector(".status-text").textContent = mText;
  marketStatus.title = st.market.fetchedAt ? `Market data from CoinGecko, updated ${formatRelative(st.market.fetchedAt)}` : "Market data from CoinGecko";
  marketStatus.setAttribute("aria-label", `Market data: ${mText}`);

  const m = st.model;
  modelStatus.dataset.state = m.status === "checking" && m.checkedAt ? "checking" : m.status;
  const t = { online: "Model online", offline: "Model offline", checking: "Checking model" }[m.status];
  modelStatus.querySelector(".status-text").textContent = t;
  modelStatus.title = m.status === "online" ? `${m.info.name}${m.info.version ? ` ${m.info.version}` : ""}` : (m.error ?? "Prediction service");
  modelStatus.setAttribute("aria-label", t);
  footerModel.textContent = m.status === "online" ? `Model service: online (${m.info.name})` : m.status === "offline" ? "Model service: offline" : "Model service: checking";
}

subscribe((_, change) => {
  if (change === "model" || change === "coin") renderCoinSelect();
  if (["market", "model", "tick"].includes(change)) renderStatuses();
  if (["market", "coin"].includes(change)) updateTitle();
});

renderCoinSelect();
renderStatuses();
window.addEventListener("hashchange", route);
route();
startPolling();
