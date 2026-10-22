"""Project-wide settings. Secrets come from .env (never committed)."""

from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # python-dotenv is in requirements.txt; tolerate its absence
    load_dotenv = None

ROOT = Path(__file__).resolve().parent.parent
if load_dotenv:
    load_dotenv(ROOT / ".env")

DATA_DIR = ROOT / "data"
DB_PATH = Path(os.getenv("PRICES_DB", DATA_DIR / "prices.db"))

# Coins to track, by CoinGecko id. Must match frontend/js/config.js MARKET_COINS.
COINS = [
    "bitcoin",
    "ethereum",
    "solana",
    "binancecoin",
    "ripple",
    "cardano",
    "dogecoin",
]

VS_CURRENCY = "usd"

# CoinGecko Demo key (free, from coingecko.com/en/api/pricing). Optional:
# without it the public endpoint still works but with a tighter rate limit.
COINGECKO_KEY = os.getenv("COINGECKO_KEY", "").strip()
COINGECKO_BASE = "https://api.coingecko.com/api/v3"

# The free/Demo tier only serves the past 365 days of history.
MAX_HISTORY_DAYS = 365

# Seconds to wait between coins so a full run stays inside the rate limit.
REQUEST_PAUSE_S = 2.5 if COINGECKO_KEY else 6.0
