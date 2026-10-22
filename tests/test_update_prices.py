"""Tests for src/update_prices.py. No network: CoinGecko is replaced by a fake session.

Run with:  python -m unittest discover tests     (or: pytest)
"""

import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

from src import db, update_prices as up

DAY = 86_400_000
NOW = datetime(2026, 10, 22, 17, 30, tzinfo=timezone.utc)
TODAY_MS = int(datetime(2026, 10, 22, tzinfo=timezone.utc).timestamp() * 1000)


def payload(days_back: int, with_now_point: bool = True) -> dict:
    """Midnight snapshots for the last `days_back` days through today, plus an intraday 'now' point."""
    ts = [TODAY_MS - i * DAY for i in range(days_back, -1, -1)]
    if with_now_point:
        ts.append(int(NOW.timestamp() * 1000))
    return {
        "prices": [[t, 100.0 + i] for i, t in enumerate(ts)],
        "market_caps": [[t, 1e9 + i] for i, t in enumerate(ts)],
        "total_volumes": [[t, 5e7 + i] for i, t in enumerate(ts)],
    }


class FakeResponse:
    def __init__(self, status, body=None, headers=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.text = str(body)

    def json(self):
        return self._body


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, dict(params or {})))
        return self.responses.pop(0)


class ToDailyRows(unittest.TestCase):
    def test_keeps_completed_days_and_drops_today_and_now(self):
        rows = up.to_daily_rows("bitcoin", payload(3), NOW.date(), "x")
        self.assertEqual([r["date"] for r in rows], ["2026-10-19", "2026-10-20", "2026-10-21"])
        self.assertEqual(rows[0]["price"], 100.0)
        self.assertEqual(rows[0]["market_cap"], 1e9)

    def test_point_just_before_midnight_counts_for_next_day(self):
        p = {"prices": [[TODAY_MS - DAY - 1000, 50.0]]}
        rows = up.to_daily_rows("eth", p, NOW.date(), "x")
        self.assertEqual(rows[0]["date"], "2026-10-21")

    def test_ignores_bad_points(self):
        p = {"prices": [[TODAY_MS - DAY, None], "junk", [TODAY_MS - 2 * DAY, 0], [TODAY_MS - 3 * DAY, 10.0]]}
        rows = up.to_daily_rows("eth", p, NOW.date(), "x")
        self.assertEqual([r["date"] for r in rows], ["2026-10-19"])


class DaysToRequest(unittest.TestCase):
    def test_incremental_window(self):
        today = date(2026, 10, 22)
        self.assertEqual(up.days_to_request(None, today, False), 365)
        self.assertEqual(up.days_to_request("2026-10-21", today, False), 0)
        self.assertEqual(up.days_to_request("2026-10-18", today, False), 5)
        self.assertEqual(up.days_to_request("2026-10-21", today, True), 365)
        self.assertEqual(up.days_to_request("2020-01-01", today, False), 365)


class Update(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "prices.db"

    def tearDown(self):
        self.tmp.cleanup()

    def test_first_run_then_incremental(self):
        s = FakeSession([FakeResponse(200, payload(365))])
        res = up.update(["bitcoin"], session=s, db_path=self.db_path, now=NOW, pause=0)
        self.assertEqual(res["bitcoin"], 365)
        self.assertEqual(s.calls[0][1]["days"], 365)
        self.assertEqual(s.calls[0][1]["interval"], "daily")

        # Same day again: nothing to fetch.
        s2 = FakeSession([])
        res = up.update(["bitcoin"], session=s2, db_path=self.db_path, now=NOW, pause=0)
        self.assertEqual(res["bitcoin"], 0)
        self.assertEqual(s2.calls, [])

        with db.connect(self.db_path) as conn:
            (coin, n, first, last), = db.summary(conn)
        self.assertEqual((coin, n, last), ("bitcoin", 365, "2026-10-21"))

    def test_rerun_overwrites_instead_of_duplicating(self):
        for _ in range(2):
            s = FakeSession([FakeResponse(200, payload(5))])
            up.update(["eth"], full=True, session=s, db_path=self.db_path, now=NOW, pause=0)
        with db.connect(self.db_path) as conn:
            self.assertEqual(db.summary(conn)[0][1], 5)

    @mock.patch("src.update_prices.time.sleep")
    def test_retries_rate_limit_then_succeeds(self, sleep):
        s = FakeSession([FakeResponse(429, headers={"retry-after": "3"}), FakeResponse(200, payload(2))])
        res = up.update(["bitcoin"], session=s, db_path=self.db_path, now=NOW, pause=0)
        self.assertEqual(res["bitcoin"], 2)
        sleep.assert_called_with(3.0)

    @mock.patch("src.update_prices.time.sleep")
    def test_one_failing_coin_does_not_stop_the_rest(self, _sleep):
        s = FakeSession([FakeResponse(404, {"error": "coin not found"}), FakeResponse(200, payload(2))])
        res = up.update(["notacoin", "bitcoin"], session=s, db_path=self.db_path, now=NOW, pause=0)
        self.assertIn("unknown CoinGecko coin id", res["notacoin"])
        self.assertEqual(res["bitcoin"], 2)

    def test_load_prices_returns_prophet_columns(self):
        s = FakeSession([FakeResponse(200, payload(10))])
        up.update(["bitcoin"], session=s, db_path=self.db_path, now=NOW, pause=0)
        try:
            df = db.load_prices("bitcoin", self.db_path)
        except ImportError:
            self.skipTest("pandas not installed")
        self.assertEqual(list(df.columns[:2]), ["ds", "y"])
        self.assertEqual(len(df), 10)


class Session(unittest.TestCase):
    def test_key_goes_in_header_not_url(self):
        s = up.make_session("abc123")
        self.assertEqual(s.headers["x-cg-demo-api-key"], "abc123")
        self.assertNotIn("x-cg-demo-api-key", up.make_session("").headers)


if __name__ == "__main__":
    unittest.main()
