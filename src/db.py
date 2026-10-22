"""SQLite storage.

Tables:
  prices           one row per coin per UTC day (from CoinGecko)
  forecasts        every forecast the pipeline made, kept forever, so it can
                   be scored against what actually happened
  metrics_history  one accuracy snapshot per pipeline run, per coin, per kind
                   ('backtest' or 'live'), so accuracy can be tracked over time

All writes are upserts keyed on natural keys, so re-running a step for the same
day replaces its rows instead of duplicating them.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable, Iterator

from src.config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS prices (
    coin_id    TEXT NOT NULL,
    date       TEXT NOT NULL,           -- YYYY-MM-DD, UTC
    price      REAL NOT NULL,           -- USD, CoinGecko snapshot at 00:00 UTC
    market_cap REAL,
    volume     REAL,                    -- 24h volume, USD
    fetched_at TEXT NOT NULL,           -- ISO timestamp of the fetch
    PRIMARY KEY (coin_id, date)
);

CREATE TABLE IF NOT EXISTS forecasts (
    coin_id     TEXT NOT NULL,
    as_of       TEXT NOT NULL,          -- last observed day the model was trained through
    target_date TEXT NOT NULL,          -- day being predicted
    horizon     INTEGER NOT NULL,       -- target_date - as_of, in days
    yhat        REAL NOT NULL,
    yhat_lower  REAL NOT NULL,
    yhat_upper  REAL NOT NULL,
    last_price  REAL NOT NULL,          -- close on as_of, for the naive comparison
    model       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (coin_id, as_of, target_date)
);

CREATE TABLE IF NOT EXISTS metrics_history (
    run_date   TEXT NOT NULL,
    coin_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,           -- 'backtest' or 'live'
    n          INTEGER NOT NULL,        -- predictions scored
    mae        REAL,
    rmse       REAL,
    mape       REAL,
    naive_mape REAL,
    coverage   REAL,                    -- share of actuals inside the 80% band
    PRIMARY KEY (run_date, coin_id, kind)
);
"""


@contextmanager
def connect(path: Path | str = DB_PATH) -> Iterator[sqlite3.Connection]:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # timeout: the API and the pipeline may touch the file at the same time.
    conn = sqlite3.connect(path, timeout=30)
    try:
        conn.executescript(SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def upsert_prices(conn: sqlite3.Connection, rows: Iterable[dict]) -> int:
    """Insert or replace rows; returns how many were written."""
    rows = list(rows)
    conn.executemany(
        """INSERT INTO prices (coin_id, date, price, market_cap, volume, fetched_at)
           VALUES (:coin_id, :date, :price, :market_cap, :volume, :fetched_at)
           ON CONFLICT(coin_id, date) DO UPDATE SET
             price = excluded.price,
             market_cap = excluded.market_cap,
             volume = excluded.volume,
             fetched_at = excluded.fetched_at""",
        rows,
    )
    return len(rows)


def last_date(conn: sqlite3.Connection, coin_id: str) -> str | None:
    row = conn.execute("SELECT MAX(date) FROM prices WHERE coin_id = ?", (coin_id,)).fetchone()
    return row[0] if row else None


def summary(conn: sqlite3.Connection) -> list[tuple]:
    """(coin_id, rows, first_date, last_date) for every stored coin."""
    return conn.execute(
        "SELECT coin_id, COUNT(*), MIN(date), MAX(date) FROM prices GROUP BY coin_id ORDER BY coin_id"
    ).fetchall()


def load_prices(coin_id: str, path: Path | str = DB_PATH):
    """Daily history as a pandas DataFrame with Prophet's column names (ds, y)."""
    import pandas as pd

    with connect(path) as conn:
        df = pd.read_sql_query(
            "SELECT date AS ds, price AS y, market_cap, volume FROM prices WHERE coin_id = ? ORDER BY date",
            conn,
            params=(coin_id,),
        )
    df["ds"] = pd.to_datetime(df["ds"])
    return df


def upsert_forecasts(conn: sqlite3.Connection, rows: Iterable[dict]) -> int:
    rows = list(rows)
    conn.executemany(
        """INSERT INTO forecasts (coin_id, as_of, target_date, horizon, yhat, yhat_lower, yhat_upper,
                                  last_price, model, created_at)
           VALUES (:coin_id, :as_of, :target_date, :horizon, :yhat, :yhat_lower, :yhat_upper,
                   :last_price, :model, :created_at)
           ON CONFLICT(coin_id, as_of, target_date) DO UPDATE SET
             horizon = excluded.horizon, yhat = excluded.yhat, yhat_lower = excluded.yhat_lower,
             yhat_upper = excluded.yhat_upper, last_price = excluded.last_price,
             model = excluded.model, created_at = excluded.created_at""",
        rows,
    )
    return len(rows)


def matured_forecasts(conn: sqlite3.Connection, coin_id: str) -> list[tuple]:
    """Forecasts whose target day now has a real price:
    (as_of, target_date, horizon, yhat, yhat_lower, yhat_upper, last_price, actual)."""
    return conn.execute(
        """SELECT f.as_of, f.target_date, f.horizon, f.yhat, f.yhat_lower, f.yhat_upper, f.last_price, p.price
           FROM forecasts f JOIN prices p ON p.coin_id = f.coin_id AND p.date = f.target_date
           WHERE f.coin_id = ? ORDER BY f.target_date, f.horizon""",
        (coin_id,),
    ).fetchall()


def upsert_metrics(conn: sqlite3.Connection, row: dict) -> None:
    conn.execute(
        """INSERT INTO metrics_history (run_date, coin_id, kind, n, mae, rmse, mape, naive_mape, coverage)
           VALUES (:run_date, :coin_id, :kind, :n, :mae, :rmse, :mape, :naive_mape, :coverage)
           ON CONFLICT(run_date, coin_id, kind) DO UPDATE SET
             n = excluded.n, mae = excluded.mae, rmse = excluded.rmse, mape = excluded.mape,
             naive_mape = excluded.naive_mape, coverage = excluded.coverage""",
        row,
    )
