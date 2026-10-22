"""Fetch daily prices from CoinGecko and store them in data/prices.db.

Usage (from the project root):
    python -m src.update_prices                 # all coins, only the missing days
    python -m src.update_prices --full          # re-download the full 365 days
    python -m src.update_prices --coins bitcoin ethereum

Runs are incremental: each coin only requests the days since its last stored
date. Only completed UTC days are stored; today's still-moving price is skipped.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import date, datetime, timedelta, timezone

import requests

from src import config, db

log = logging.getLogger("update_prices")

DAY_MS = 86_400_000
# A daily point counts as the 00:00 UTC snapshot if it's within this of midnight.
MIDNIGHT_TOLERANCE_MS = 60 * 60 * 1000


class CoinGeckoError(RuntimeError):
    pass


def make_session(api_key: str = config.COINGECKO_KEY) -> requests.Session:
    s = requests.Session()
    s.headers["Accept"] = "application/json"
    s.headers["User-Agent"] = "crypto-predictor/1.0"
    if api_key:
        s.headers["x-cg-demo-api-key"] = api_key
    return s


def fetch_market_chart(session: requests.Session, coin_id: str, days: int, *, retries: int = 4) -> dict:
    """GET /coins/{id}/market_chart with daily interval, retrying rate limits and server errors."""
    url = f"{config.COINGECKO_BASE}/coins/{coin_id}/market_chart"
    params = {"vs_currency": config.VS_CURRENCY, "days": days, "interval": "daily"}
    delay = 5.0
    for attempt in range(1, retries + 1):
        try:
            resp = session.get(url, params=params, timeout=30)
        except requests.RequestException as exc:
            if attempt == retries:
                raise CoinGeckoError(f"{coin_id}: network error: {exc}") from exc
            log.warning("%s: network error, retrying in %.0fs (%s)", coin_id, delay, exc)
            time.sleep(delay)
            delay *= 2
            continue

        if resp.status_code == 200:
            data = resp.json()
            if not isinstance(data, dict) or not isinstance(data.get("prices"), list):
                raise CoinGeckoError(f"{coin_id}: unexpected response shape")
            return data
        if resp.status_code == 429 or resp.status_code >= 500:
            wait = min(float(resp.headers.get("retry-after") or delay), 90.0)
            if attempt == retries:
                raise CoinGeckoError(f"{coin_id}: HTTP {resp.status_code} after {retries} attempts")
            log.warning("%s: HTTP %s, retrying in %.0fs", coin_id, resp.status_code, wait)
            time.sleep(wait)
            delay *= 2
            continue
        if resp.status_code == 401:
            raise CoinGeckoError("CoinGecko rejected the API key (401). Check COINGECKO_KEY in .env.")
        if resp.status_code == 404:
            raise CoinGeckoError(f"{coin_id}: unknown CoinGecko coin id (404)")
        raise CoinGeckoError(f"{coin_id}: HTTP {resp.status_code}: {resp.text[:200]}")
    raise CoinGeckoError(f"{coin_id}: request failed")


def to_daily_rows(coin_id: str, payload: dict, today: date, fetched_at: str) -> list[dict]:
    """Turn a market_chart payload into one row per completed UTC day.

    CoinGecko's daily series is a 00:00 UTC snapshot per day, sometimes with an
    extra point for "now" at the end. We keep the midnight snapshot for each
    date before today and drop anything else.
    """

    def by_ts(series):
        out = {}
        for point in series or []:
            if isinstance(point, (list, tuple)) and len(point) == 2 and point[1] is not None:
                out[int(point[0])] = float(point[1])
        return out

    prices = by_ts(payload.get("prices"))
    caps = by_ts(payload.get("market_caps"))
    vols = by_ts(payload.get("total_volumes"))

    rows: dict[str, dict] = {}
    for ts in sorted(prices):
        day_start = ts - ts % DAY_MS
        offset = ts - day_start
        # Accept points just after midnight, or just before it (rounding to the next day).
        if offset <= MIDNIGHT_TOLERANCE_MS:
            d = datetime.fromtimestamp(day_start / 1000, tz=timezone.utc).date()
        elif DAY_MS - offset <= MIDNIGHT_TOLERANCE_MS:
            d = datetime.fromtimestamp((day_start + DAY_MS) / 1000, tz=timezone.utc).date()
        else:
            continue  # intraday "now" point
        if d >= today or prices[ts] <= 0:
            continue
        key = d.isoformat()
        if key in rows:
            continue  # keep the first snapshot for the day
        rows[key] = {
            "coin_id": coin_id,
            "date": key,
            "price": prices[ts],
            "market_cap": caps.get(ts),
            "volume": vols.get(ts),
            "fetched_at": fetched_at,
        }
    return list(rows.values())


def days_to_request(last: str | None, today: date, full: bool) -> int:
    """How many days of history to ask for. 0 means already up to date."""
    if full or not last:
        return config.MAX_HISTORY_DAYS
    gap = (today - date.fromisoformat(last)).days
    if gap <= 1:
        return 0  # yesterday is stored; today isn't complete yet
    # +1 so the window safely covers the day after `last`.
    return min(gap + 1, config.MAX_HISTORY_DAYS)


def update(coins=None, *, full: bool = False, session=None, db_path=config.DB_PATH, now=None, pause=None) -> dict:
    """Update every coin. Returns {coin_id: rows_written or error string}."""
    coins = coins or config.COINS
    session = session or make_session()
    now = now or datetime.now(timezone.utc)
    today = now.date()
    pause = config.REQUEST_PAUSE_S if pause is None else pause
    fetched_at = now.isoformat(timespec="seconds")
    results: dict[str, object] = {}

    with db.connect(db_path) as conn:
        for i, coin in enumerate(coins):
            days = days_to_request(db.last_date(conn, coin), today, full)
            if days == 0:
                log.info("%-12s up to date", coin)
                results[coin] = 0
                continue
            if i and pause:
                time.sleep(pause)
            try:
                payload = fetch_market_chart(session, coin, days)
            except CoinGeckoError as exc:
                log.error("%s", exc)
                results[coin] = str(exc)
                continue
            rows = to_daily_rows(coin, payload, today, fetched_at)
            written = db.upsert_prices(conn, rows)
            conn.commit()
            log.info("%-12s %3d days stored (requested %d)", coin, written, days)
            results[coin] = written
    return results


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Fetch daily crypto prices from CoinGecko into data/prices.db")
    parser.add_argument("--coins", nargs="+", help="CoinGecko ids (default: all in src/config.py)")
    parser.add_argument("--full", action="store_true", help="re-download the full 365-day history")
    parser.add_argument("-q", "--quiet", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING if args.quiet else logging.INFO, format="%(message)s")

    if not config.COINGECKO_KEY:
        log.info("No COINGECKO_KEY in .env, using the public endpoint (slower rate limit).")
    results = update(args.coins, full=args.full)

    with db.connect() as conn:
        log.info("\n%-12s %6s  %-10s  %-10s", "coin", "days", "from", "to")
        for coin, n, first, last in db.summary(conn):
            log.info("%-12s %6d  %s  %s", coin, n, first, last)
    log.info("Database: %s", config.DB_PATH)

    failed = [c for c, r in results.items() if isinstance(r, str)]
    if failed:
        log.error("Failed: %s", ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
