"""Publish the API's responses as static JSON files, for hosting without a server.

    python -m src.export_static            # writes data/published/

Produces exactly what the API would answer, so the dashboard reads the same
shapes either way:

    data/published/health.json             GET  /api/health
    data/published/coins.json              GET  /api/coins
    data/published/predict/<coin>-<h>.json POST /api/predict  (every coin × horizon)
    data/published/metrics/<coin>.json     GET  /api/metrics?coin_id=<coin>

The GitHub workflow runs this after the daily pipeline and deploys
frontend/ + data/published/ to GitHub Pages.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from src import api, config, train_predict

log = logging.getLogger("export_static")

OUT_DIR = config.DATA_DIR / "published"


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")))
    os.replace(tmp, path)


def export(out_dir: Path | None = None, *, db_path=config.DB_PATH) -> dict:
    """Write every endpoint's response. Returns a summary of what was written."""
    out_dir = Path(out_dir or OUT_DIR)
    call = lambda method, path, query=None, body=None: api.handle(method, path, query or {}, body, db_path)  # noqa: E731

    health = call("GET", "/api/health")
    coins = call("GET", "/api/coins")
    written = {"predict": 0, "metrics": 0}

    for coin in (c["id"] for c in coins["coins"]):
        for h in coins["horizons"]:
            body = call("POST", "/api/predict", body={"coin_id": coin, "horizon_days": h})
            _write(out_dir / "predict" / f"{coin}-{h}.json", body)
            written["predict"] += 1
        try:
            _write(out_dir / "metrics" / f"{coin}.json", call("GET", "/api/metrics", {"coin_id": [coin]}))
            written["metrics"] += 1
        except api.ApiError:
            log.warning("no backtest for %s yet; run the backtest step first", coin)

    # health.json last: the dashboard treats it as "a complete export exists".
    _write(out_dir / "coins.json", coins)
    _write(out_dir / "health.json", {**health, "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    log.info("published %d forecasts and %d metrics files to %s", written["predict"], written["metrics"], out_dir)
    return {"coins": len(coins["coins"]), **written}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Write the API's responses as static JSON for hosting")
    p.add_argument("--out", type=Path, help=f"output folder (default: {OUT_DIR})")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        export(args.out)
    except api.ApiError as exc:
        log.error("Export failed: %s", exc.detail)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
