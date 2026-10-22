"""HTTP API for the frontend, implementing docs/api-contract.md.

    python -m src.api                 # serves on http://localhost:8000
    python -m src.api --port 9000

Uses only the Python standard library, so there is nothing extra to install.
"""

from __future__ import annotations

import argparse
import json
import logging
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from src import config, models, train_predict

log = logging.getLogger("api")

# Origins allowed to call the API from a browser (the frontend dev server).
ALLOWED_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}

COIN_NAMES = {
    "bitcoin": ("BTC", "Bitcoin"),
    "ethereum": ("ETH", "Ethereum"),
    "solana": ("SOL", "Solana"),
    "binancecoin": ("BNB", "BNB"),
    "ripple": ("XRP", "XRP"),
    "cardano": ("ADA", "Cardano"),
    "dogecoin": ("DOGE", "Dogecoin"),
}


class ApiError(Exception):
    def __init__(self, status: HTTPStatus, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def model_ready() -> None:
    try:
        import prophet  # noqa: F401
    except ImportError:
        if models.MODEL_FACTORY is models.make_prophet:
            raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "Prophet isn't installed. Run: pip install prophet")


def handle(method: str, path: str, query: dict, body: dict | None, db_path=config.DB_PATH) -> dict:
    """Route a request to a response body. Raises ApiError for failures."""
    if method == "GET" and path == "/api/health":
        model_ready()
        coins = train_predict.available_coins(db_path)
        if not coins:
            raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "No price history stored yet. Run: python -m src.update_prices")
        evaluated = [m["evaluated_at"] for c in coins if (m := train_predict.read_metrics(c))]
        return {"status": "ok", "model": {**models.model_info(), "trained_at": max(evaluated) if evaluated else None}}

    if method == "GET" and path == "/api/coins":
        coins = train_predict.available_coins(db_path)
        return {
            "coins": [{"id": c, "symbol": COIN_NAMES.get(c, (c, c))[0], "name": COIN_NAMES.get(c, (c, c))[1]} for c in coins],
            "horizons": train_predict.HORIZONS,
        }

    if method == "POST" and path == "/api/predict":
        model_ready()
        if not isinstance(body, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Send JSON like {\"coin_id\": \"bitcoin\", \"horizon_days\": 7}.")
        coin, horizon = body.get("coin_id"), body.get("horizon_days")
        if coin not in train_predict.available_coins(db_path):
            raise ApiError(HTTPStatus.NOT_FOUND, f"No model data for '{coin}'.")
        if horizon not in train_predict.HORIZONS:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"horizon_days must be one of {train_predict.HORIZONS}.")
        try:
            return train_predict.forecast(coin, horizon, db_path=db_path)
        except (LookupError, ValueError) as exc:
            raise ApiError(HTTPStatus.UNPROCESSABLE_ENTITY, str(exc)) from exc

    if method == "GET" and path == "/api/metrics":
        coin = (query.get("coin_id") or [None])[0]
        metrics = train_predict.read_metrics(coin) if coin else None
        if not metrics:
            raise ApiError(HTTPStatus.NOT_FOUND, f"No backtest for '{coin}' yet. Run: python -m src.train_predict")
        return metrics

    raise ApiError(HTTPStatus.NOT_FOUND, f"No route for {method} {path}")


def make_handler(db_path=config.DB_PATH):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SibylAPI/1.0"

        def _cors(self):
            origin = self.headers.get("Origin")
            if origin in ALLOWED_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _send(self, status: int, payload: dict):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        def _dispatch(self, method: str):
            url = urlparse(self.path)
            body = None
            if method == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                if length > 10_000:
                    return self._send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"detail": "Request body too large."})
                try:
                    body = json.loads(self.rfile.read(length) or b"null")
                except json.JSONDecodeError:
                    return self._send(HTTPStatus.BAD_REQUEST, {"detail": "Request body isn't valid JSON."})
            try:
                self._send(HTTPStatus.OK, handle(method, url.path, parse_qs(url.query), body, db_path))
            except ApiError as exc:
                self._send(exc.status, {"detail": exc.detail})
            except Exception:  # never leak a traceback to the client
                log.exception("Unhandled error on %s %s", method, url.path)
                self._send(HTTPStatus.INTERNAL_SERVER_ERROR, {"detail": "The model service hit an internal error."})

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_OPTIONS(self):
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors()
            self.end_headers()

        def log_message(self, fmt, *args):
            log.info("%s %s", self.address_string(), fmt % args)

    return Handler


def serve(host: str = "127.0.0.1", port: int = 8000, db_path=config.DB_PATH) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), make_handler(db_path))


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Serve forecasts for the Sibyl frontend")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    server = serve(args.host, args.port)
    coins = train_predict.available_coins()
    log.info("Sibyl API on http://%s:%d  (coins: %s)", args.host, args.port, ", ".join(coins) or "none yet")
    if not coins:
        log.warning("No price history yet. Run: python -m src.update_prices")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
