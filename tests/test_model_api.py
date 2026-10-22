"""Tests for src/models.py, src/train_predict.py and src/api.py.

Prophet is swapped for a tiny stand-in with the same interface, so these run
without Prophet installed and finish in a second. They check the plumbing
(no data leakage, future-only dates, metric maths, the API contract), not
Prophet's forecasting quality.

Run with:  python -m unittest discover tests
"""

import json
import math
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

from src import api, db, models, train_predict

START = date(2025, 10, 1)
N_DAYS = 200  # 2025-10-01 .. 2026-04-18


class FakeProphet:
    """Mimics Prophet's fit / make_future_dataframe / predict on log prices."""

    fits = []

    def fit(self, df):
        self.last_ds = pd.to_datetime(df["ds"]).max()
        self.last_y = float(df["y"].iloc[-1])
        FakeProphet.fits.append(self.last_ds)
        return self

    def make_future_dataframe(self, periods, freq="D", include_history=False):
        return pd.DataFrame({"ds": pd.date_range(self.last_ds + pd.Timedelta(days=1), periods=periods, freq="D")})

    level_error = 0.0  # simulate Prophet's smoothed level sitting off the last close

    def predict(self, future):
        days = (pd.to_datetime(future["ds"]) - self.last_ds).dt.days.to_numpy()
        yhat = self.last_y + self.level_error + 0.001 * days
        return pd.DataFrame({"ds": future["ds"], "yhat": yhat, "yhat_lower": yhat - 0.05, "yhat_upper": yhat + 0.05})


def seed_db(path: Path, coin="bitcoin", days=N_DAYS):
    rows = [
        {"coin_id": coin, "date": (START + timedelta(days=i)).isoformat(), "price": 100.0 * math.exp(0.002 * i),
         "market_cap": None, "volume": None, "fetched_at": "x"}
        for i in range(days)
    ]
    with db.connect(path) as conn:
        db.upsert_prices(conn, rows)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.db_path = root / "prices.db"
        seed_db(self.db_path)
        self.patches = [
            mock.patch.object(models, "MODEL_FACTORY", FakeProphet),
            mock.patch.object(train_predict, "METRICS_DIR", root / "metrics"),
        ]
        for p in self.patches:
            p.start()
        train_predict._cache.clear()
        FakeProphet.fits.clear()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()


class Metrics(unittest.TestCase):
    def test_known_values(self):
        m = models.error_metrics([100, 200], [110, 180])
        self.assertAlmostEqual(m["mae"], 15.0)
        self.assertAlmostEqual(m["rmse"], math.sqrt((100 + 400) / 2))
        self.assertAlmostEqual(m["mape"], 10.0)

    def test_empty(self):
        self.assertEqual(models.error_metrics([], [])["mae"], None)


class Backtest(Base):
    def test_never_trains_on_the_days_it_is_tested_on(self):
        history = db.load_prices("bitcoin", self.db_path)
        bt = models.backtest(history)
        self.assertEqual(len(bt), 56)
        self.assertEqual(len(FakeProphet.fits), 8)
        # Each block's first test day is the day after that fit's last training day.
        firsts = bt[bt["step_ahead"] == 1]["ds"].tolist()
        for fit_end, first_test in zip(FakeProphet.fits, firsts):
            self.assertEqual(first_test - fit_end, pd.Timedelta(days=1))

    def test_too_little_data(self):
        short = db.load_prices("bitcoin", self.db_path).head(100)
        with self.assertRaises(ValueError):
            models.backtest(short)

    def test_evaluate_writes_contract_shaped_json(self):
        r = train_predict.evaluate("bitcoin", db_path=self.db_path)
        saved = json.loads((train_predict.METRICS_DIR / "bitcoin.json").read_text())
        self.assertEqual(saved["coin_id"], "bitcoin")
        for k in ("mae", "rmse", "mape"):
            self.assertGreaterEqual(saved[k], 0)
        self.assertEqual(len(saved["backtest"]), 56)
        self.assertIn("baseline", saved)
        self.assertEqual(r["window"]["end"], "2026-04-18")


class Anchoring(Base):
    def test_forecast_starts_from_last_close_not_the_smoothed_level(self):
        history = db.load_prices("bitcoin", self.db_path)
        last_close = float(history["y"].iloc[-1])
        with mock.patch.object(FakeProphet, "level_error", -0.10):  # fitted level ~10% below the close
            fc = models.fit_and_forecast(history, periods=3).frame
        # Day 1 = last close moved by one day of drift, not 10% lower.
        self.assertAlmostEqual(fc["yhat"].iloc[0], last_close * math.exp(0.001), places=6)
        self.assertLess(fc["yhat_lower"].iloc[0], fc["yhat"].iloc[0])
        self.assertGreater(fc["yhat_upper"].iloc[0], fc["yhat"].iloc[0])


class ForecastTests(Base):
    def test_only_future_days_and_exact_horizon(self):
        today = date(2026, 4, 25)  # data ends 2026-04-18, a week stale
        body = train_predict.forecast("bitcoin", 7, today=today, db_path=self.db_path)
        dates = [r["date"] for r in body["forecast"]]
        self.assertEqual(dates[0], "2026-04-26")
        self.assertEqual(len(dates), 7)
        for r in body["forecast"]:
            self.assertLessEqual(r["yhat_lower"], r["yhat"])
            self.assertLessEqual(r["yhat"], r["yhat_upper"])
        self.assertEqual(body["last_observed"]["date"], "2026-04-18")
        self.assertEqual(body["interval_width"], 0.8)

    def test_one_fit_serves_all_horizons(self):
        today = date(2026, 4, 19)
        for h in (1, 7, 30):
            body = train_predict.forecast("bitcoin", h, today=today, db_path=self.db_path)
            self.assertEqual(len(body["forecast"]), h)
        self.assertEqual(len(FakeProphet.fits), 1)

    def test_rejects_unknown_horizon(self):
        with self.assertRaises(ValueError):
            train_predict.forecast("bitcoin", 5, db_path=self.db_path)


class ApiTests(Base):
    def setUp(self):
        super().setUp()
        self.server = api.serve("127.0.0.1", 0, db_path=self.db_path)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def call(self, path, body=None, origin="http://localhost:5173"):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method="POST" if body is not None else "GET")
        req.add_header("Origin", origin)
        if body is not None:
            req.add_header("Content-Type", "application/json")
            req.data = json.dumps(body).encode()
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read()), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read()), dict(e.headers)

    def test_health_coins_predict_metrics(self):
        with mock.patch.dict("sys.modules", {"prophet": mock.MagicMock(__version__="test")}):
            s, b, h = self.call("/api/health")
            self.assertEqual((s, b["status"]), (200, "ok"))
            self.assertEqual(h.get("Access-Control-Allow-Origin"), "http://localhost:5173")

            s, b, _ = self.call("/api/coins")
            self.assertEqual(b, {"coins": [{"id": "bitcoin", "symbol": "BTC", "name": "Bitcoin"}], "horizons": [1, 7, 30]})

            s, b, _ = self.call("/api/predict", {"coin_id": "bitcoin", "horizon_days": 7})
            self.assertEqual(s, 200)
            self.assertEqual(len(b["forecast"]), 7)

            s, b, _ = self.call("/api/metrics?coin_id=bitcoin")
            self.assertEqual(s, 404)
            self.assertIn("python -m src.train_predict", b["detail"])

            train_predict.evaluate("bitcoin", db_path=self.db_path)
            s, b, _ = self.call("/api/metrics?coin_id=bitcoin")
            self.assertEqual(s, 200)
            self.assertEqual(len(b["backtest"]), 56)

    def test_errors_are_json_with_detail(self):
        with mock.patch.dict("sys.modules", {"prophet": mock.MagicMock()}):
            s, b, _ = self.call("/api/predict", {"coin_id": "solana", "horizon_days": 7})
            self.assertEqual(s, 404)
            s, b, _ = self.call("/api/predict", {"coin_id": "bitcoin", "horizon_days": 5})
            self.assertEqual(s, 400)
            s, b, _ = self.call("/api/metrics?coin_id=../../src/config")
            self.assertEqual(s, 404)
            s, b, _ = self.call("/api/nope")
            self.assertEqual(s, 404)
            self.assertIn("detail", b)

    def test_unknown_origin_gets_no_cors_header(self):
        _, _, h = self.call("/api/coins", origin="https://evil.example")
        self.assertNotIn("Access-Control-Allow-Origin", h)


if __name__ == "__main__":
    unittest.main()
