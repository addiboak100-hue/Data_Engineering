"""The static export must match what the live API returns."""

import json
import math
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from src import api, db, export_static, models, train_predict
from test_model_api import FakeProphet

START = date.today() - timedelta(days=200)


class Export(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.db_path = root / "prices.db"
        self.out = root / "published"
        rows = [{"coin_id": c, "date": (START + timedelta(days=i)).isoformat(), "price": base * math.exp(0.001 * i),
                 "market_cap": None, "volume": None, "fetched_at": "x"}
                for c, base in (("bitcoin", 60000.0), ("ethereum", 3000.0)) for i in range(200)]
        with db.connect(self.db_path) as conn:
            db.upsert_prices(conn, rows)
        self.patches = [
            mock.patch.object(models, "MODEL_FACTORY", FakeProphet),
            mock.patch.object(train_predict, "METRICS_DIR", root / "metrics"),
            mock.patch.dict(sys.modules, {"prophet": mock.MagicMock(__version__="test")}),
        ]
        for p in self.patches:
            p.start()
        train_predict._cache.clear()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_writes_every_endpoint_in_api_shape(self):
        train_predict.evaluate("bitcoin", db_path=self.db_path)  # ethereum deliberately has no backtest
        summary = export_static.export(self.out, db_path=self.db_path)
        self.assertEqual(summary, {"coins": 2, "predict": 6, "metrics": 1})

        health = json.loads((self.out / "health.json").read_text())
        self.assertEqual(health["status"], "ok")
        self.assertIn("published_at", health)

        coins = json.loads((self.out / "coins.json").read_text())
        self.assertEqual([c["id"] for c in coins["coins"]], ["bitcoin", "ethereum"])

        fc = json.loads((self.out / "predict" / "bitcoin-7.json").read_text())
        live = api.handle("POST", "/api/predict", {}, {"coin_id": "bitcoin", "horizon_days": 7}, self.db_path)
        self.assertEqual(fc["forecast"], live["forecast"], "static file matches the API response")
        self.assertEqual(len(fc["forecast"]), 7)
        self.assertGreater(fc["forecast"][0]["date"], date.today().isoformat(), "only future days")

        self.assertTrue((self.out / "metrics" / "bitcoin.json").exists())
        self.assertFalse((self.out / "metrics" / "ethereum.json").exists())
        self.assertEqual(list(self.out.rglob(".*.tmp")), [], "no temp files left behind")


if __name__ == "__main__":
    unittest.main()
