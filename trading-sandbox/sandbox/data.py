"""Price data: a small OHLC candle type plus loaders.

Three ways to get candles:

- ``synthetic_candles`` — generated locally, no network. Used by the tests and
  by anyone exploring the framework offline.
- ``load_csv`` — read candles you have saved to disk.
- ``fetch_coinbase`` / ``fetch_binance`` — pull real historical candles from a
  public exchange API. These need outbound internet and will not work in a
  locked-down environment; run them on your own machine.

Every candle is a plain tuple-like object with fields: time, open, high, low,
close, volume. Times are unix seconds (UTC).
"""

from __future__ import annotations

import csv
import json
import math
import random
import urllib.request
from dataclasses import dataclass
from typing import List, Sequence


@dataclass(frozen=True)
class Candle:
    time: int  # unix seconds, UTC
    open: float
    high: float
    low: float
    close: float
    volume: float


# --------------------------------------------------------------------------- #
# Offline sources
# --------------------------------------------------------------------------- #
def synthetic_candles(
    n: int = 500,
    start_price: float = 100.0,
    drift: float = 0.0004,
    volatility: float = 0.02,
    seed: int | None = 42,
    start_time: int = 1_600_000_000,
    interval: int = 86_400,
) -> List[Candle]:
    """Generate ``n`` candles from a geometric-random-walk price path.

    This is *not* real market data. It is deterministic given ``seed`` so tests
    and demos are reproducible. ``drift`` is the mean per-candle log return and
    ``volatility`` its standard deviation.
    """
    rng = random.Random(seed)
    candles: List[Candle] = []
    price = start_price
    t = start_time
    for _ in range(n):
        # A log-return random walk keeps prices positive.
        ret = rng.gauss(drift, volatility)
        new_price = max(0.01, price * math.exp(ret))
        o = price
        c = new_price
        hi = max(o, c) * (1 + abs(rng.gauss(0, volatility / 2)))
        lo = min(o, c) * (1 - abs(rng.gauss(0, volatility / 2)))
        vol = abs(rng.gauss(1000, 200))
        candles.append(Candle(t, o, hi, lo, c, vol))
        price = new_price
        t += interval
    return candles


def load_csv(path: str) -> List[Candle]:
    """Load candles from a CSV with a header row.

    Recognised columns (case-insensitive): time, open, high, low, close,
    volume. ``time`` may be unix seconds or an ISO-8601 date string.
    """
    out: List[Candle] = []
    with open(path, newline="") as fh:
        reader = csv.DictReader(fh)
        norm = {name.lower(): name for name in (reader.fieldnames or [])}
        for row in reader:
            raw_time = row[norm["time"]]
            try:
                t = int(float(raw_time))
            except ValueError:
                from datetime import datetime, timezone

                t = int(
                    datetime.fromisoformat(raw_time)
                    .replace(tzinfo=timezone.utc)
                    .timestamp()
                )
            out.append(
                Candle(
                    time=t,
                    open=float(row[norm["open"]]),
                    high=float(row[norm["high"]]),
                    low=float(row[norm["low"]]),
                    close=float(row[norm["close"]]),
                    volume=float(row.get(norm.get("volume", ""), 0) or 0),
                )
            )
    out.sort(key=lambda c: c.time)
    return out


def save_csv(candles: Sequence[Candle], path: str) -> None:
    with open(path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["time", "open", "high", "low", "close", "volume"])
        for c in candles:
            writer.writerow([c.time, c.open, c.high, c.low, c.close, c.volume])


# --------------------------------------------------------------------------- #
# Online sources (need internet; run on your own machine)
# --------------------------------------------------------------------------- #
def _http_get_json(url: str, timeout: int = 30):
    req = urllib.request.Request(url, headers={"User-Agent": "trading-sandbox/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def fetch_coinbase(
    product: str = "BTC-USD", granularity: int = 86_400
) -> List[Candle]:
    """Fetch recent candles from Coinbase's public API (no API key needed).

    ``granularity`` is in seconds: 60, 300, 900, 3600, 21600 or 86400.
    Coinbase returns up to ~300 candles per call as
    ``[time, low, high, open, close, volume]``.
    """
    url = (
        f"https://api.exchange.coinbase.com/products/{product}"
        f"/candles?granularity={granularity}"
    )
    rows = _http_get_json(url)
    candles = [
        Candle(int(r[0]), float(r[3]), float(r[2]), float(r[1]), float(r[4]), float(r[5]))
        for r in rows
    ]
    candles.sort(key=lambda c: c.time)
    return candles


def fetch_binance(
    symbol: str = "BTCUSDT", interval: str = "1d", limit: int = 500
) -> List[Candle]:
    """Fetch candles from Binance's public API (no API key needed).

    ``interval`` examples: '1m', '5m', '1h', '4h', '1d'. Binance returns rows as
    ``[openTime(ms), open, high, low, close, volume, ...]``.
    """
    url = (
        f"https://api.binance.com/api/v3/klines?symbol={symbol}"
        f"&interval={interval}&limit={limit}"
    )
    rows = _http_get_json(url)
    candles = [
        Candle(
            int(r[0]) // 1000,
            float(r[1]),
            float(r[2]),
            float(r[3]),
            float(r[4]),
            float(r[5]),
        )
        for r in rows
    ]
    candles.sort(key=lambda c: c.time)
    return candles
