"""Tests for src/pipeline.py: validation gate, forecast history, live scoring,
idempotency. Uses the same Prophet stand-in as test_model_api.py.

Run with:  python -m unittest discover tests
"""

import math
import sqlite3
from contextlib import closing
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from src import db, models, pipeline, train_predict
from test_model_api import FakeProphet

START = date(2025, 10, 1)


def price(i: int) -> float:
    return 100.0 * math.exp(0.002 * i)


def seed(path, coin="bitcoin", days=200, start=0, skip=()):
    rows = [
        {"coin_id": coin, "date": (START + timedelta(days=i)).isoformat(), "price": price(i),
         "market_cap": None, "volume": None, "fetched_at": "x"}
        for i in range(start, start + days) if i not in skip
    ]
    with db.connect(path) as conn:
        db.upsert_prices(conn, rows)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.db_path = root / "prices.db"
        self.patches = [
            mock.patch.object(models, "MODEL_FACTORY", FakeProphet),
            mock.patch.object(train_predict, "METRICS_DIR", root / "metrics"),
        ]
        for p in self.patches:
            p.start()
        FakeProphet.fits.clear()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def count(self, table):
        with closing(sqlite3.connect(self.db_path)) as c:
            return c.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


class Validate(Base):
    TODAY = START + timedelta(days=200)  # data ends the day before

    def test_clean_data_passes(self):
        seed(self.db_path)
        report = pipeline.validate(["bitcoin"], db_path=self.db_path, today=self.TODAY)
        self.assertTrue(report.ok)
        self.assertEqual(report.checked["bitcoin"], 200)

    def test_stale_data_stops_the_run(self):
        seed(self.db_path)
        with self.assertRaisesRegex(pipeline.DataQualityError, "days old"):
            pipeline.validate(["bitcoin"], db_path=self.db_path, today=self.TODAY + timedelta(days=5))

    def test_gap_in_history_stops_the_run(self):
        seed(self.db_path, skip={50, 51})
        with self.assertRaisesRegex(pipeline.DataQualityError, "2 missing day"):
            pipeline.validate(["bitcoin"], db_path=self.db_path, today=self.TODAY)

    def test_too_little_history_stops_the_run(self):
        seed(self.db_path, days=30, start=170)
        with self.assertRaisesRegex(pipeline.DataQualityError, "only 30 days"):
            pipeline.validate(["bitcoin"], db_path=self.db_path, today=self.TODAY)

    def test_big_jump_is_a_warning_not_an_error(self):
        seed(self.db_path)
        with db.connect(self.db_path) as conn:
            conn.execute("UPDATE prices SET price = price * 3 WHERE date = ?", ((START + timedelta(days=100)).isoformat(),))
        report = pipeline.validate(["bitcoin"], db_path=self.db_path, today=self.TODAY)
        self.assertTrue(report.ok)
        self.assertEqual(len(report.warnings), 2)  # the spike up and the drop back


class ForecastHistoryAndScoring(Base):
    def test_forecasts_are_kept_and_scored_once_their_day_arrives(self):
        seed(self.db_path, days=200)  # through day 199
        pipeline.record_forecasts(["bitcoin"], db_path=self.db_path, days=30)
        self.assertEqual(self.count("forecasts"), 30)

        # Re-running on the same data replaces, never duplicates.
        pipeline.record_forecasts(["bitcoin"], db_path=self.db_path, days=30)
        self.assertEqual(self.count("forecasts"), 30)

        train_predict.evaluate("bitcoin", db_path=self.db_path)  # creates the metrics JSON
        live = pipeline.score(["bitcoin"], db_path=self.db_path, today=START + timedelta(days=200))["bitcoin"]
        self.assertEqual(live["n"], 0, "nothing has matured yet")

        # Ten more days of real prices arrive: ten forecasts can now be scored.
        seed(self.db_path, days=10, start=200)
        live = pipeline.score(["bitcoin"], db_path=self.db_path, today=START + timedelta(days=210))["bitcoin"]
        self.assertEqual(live["n"], 10)
        self.assertIsNotNone(live["mape"])
        self.assertTrue(0 <= live["coverage"] <= 1)
        self.assertEqual([h["label"] for h in live["by_horizon"]], ["1 day", "2–7 days", "8–30 days"])

        saved = train_predict.read_metrics("bitcoin")
        self.assertEqual(saved["live"]["n"], 10)
        self.assertEqual(self.count("metrics_history"), 3)  # backtest + two live snapshots

        # A later backtest must not wipe the live record.
        train_predict.evaluate("bitcoin", db_path=self.db_path)
        self.assertEqual(train_predict.read_metrics("bitcoin")["live"]["n"], 10)

    def test_horizon_is_days_after_last_observation(self):
        seed(self.db_path, days=200)
        pipeline.record_forecasts(["bitcoin"], db_path=self.db_path, days=3)
        with closing(sqlite3.connect(self.db_path)) as c:
            rows = c.execute("SELECT as_of, target_date, horizon FROM forecasts ORDER BY horizon").fetchall()
        last = (START + timedelta(days=199)).isoformat()
        self.assertEqual(rows[0], (last, (START + timedelta(days=200)).isoformat(), 1))
        self.assertEqual(rows[-1][2], 3)


class LiveMetrics(unittest.TestCase):
    def test_known_values(self):
        rows = [
            ("2026-01-01", "2026-01-02", 1, 110.0, 100.0, 120.0, 100.0, 100.0),  # 10% miss, inside band, naive exact
            ("2026-01-01", "2026-01-03", 2, 90.0, 85.0, 95.0, 100.0, 100.0),     # 10% miss, outside band
        ]
        m = pipeline.live_metrics(rows)
        self.assertEqual(m["n"], 2)
        self.assertAlmostEqual(m["mape"], 10.0)
        self.assertAlmostEqual(m["naive_mape"], 0.0)
        self.assertAlmostEqual(m["coverage"], 0.5)

    def test_empty(self):
        self.assertEqual(pipeline.live_metrics([])["n"], 0)


class Coverage(unittest.TestCase):
    def test_interval_coverage(self):
        self.assertAlmostEqual(models.interval_coverage([1, 5, 10], [0, 0, 0], [2, 6, 8]), 2 / 3)
        self.assertIsNone(models.interval_coverage([], [], []))


if __name__ == "__main__":
    unittest.main()
