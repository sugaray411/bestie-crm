"""Market data acquisition.

Two sources of candles:

* Real exchange REST endpoints (Binance, Bybit, Coinbase). These need outbound
  network access to the exchange, which many sandboxes block.
* A synthetic generator that reproduces the statistical texture of real BTC
  candles (volatility clustering, intraday seasonality, fat tails) so the whole
  pipeline can be exercised and tested offline.

Every candle in this project is a *closed* candle. The partially formed candle
at the right edge of the tape is dropped on ingest, because trading on it would
mean using information the model would not have had at decision time.

Canonical schema, one row per closed candle, all timestamps UTC milliseconds:

    open_time, open, high, low, close, volume, close_time,
    quote_volume, trades, taker_buy_base
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

SCHEMA = [
    "open_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "close_time",
    "quote_volume",
    "trades",
    "taker_buy_base",
]

_INTERVAL_MS = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "2h": 7_200_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}


class DataFetchError(RuntimeError):
    """Raised when market data cannot be retrieved."""


def interval_ms(interval: str) -> int:
    try:
        return _INTERVAL_MS[interval]
    except KeyError:
        raise ValueError(
            f"unsupported interval {interval!r}; known: {sorted(_INTERVAL_MS)}"
        ) from None


def now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------


def _get_json(url: str, params: dict, timeout: float = 20.0, retries: int = 4):
    """GET with exponential backoff on transient failures."""
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            response = requests.get(url, params=params, timeout=timeout)
            if response.status_code == 429 or response.status_code >= 500:
                raise DataFetchError(f"HTTP {response.status_code} from {url}")
            response.raise_for_status()
            return response.json()
        except Exception as exc:  # noqa: BLE001 - retried below
            last_error = exc
            if attempt == retries - 1:
                break
            time.sleep(2**attempt)
    raise DataFetchError(f"failed to fetch {url}: {last_error}") from last_error


# --------------------------------------------------------------------------
# Exchange fetchers -> list of rows in SCHEMA order
# --------------------------------------------------------------------------


def fetch_binance(symbol: str, interval: str, start_ms: int, end_ms: int) -> list[list]:
    base = "https://api.binance.com/api/v3/klines"
    step = interval_ms(interval)
    rows: list[list] = []
    cursor = start_ms
    while cursor < end_ms:
        batch = _get_json(
            base,
            {
                "symbol": symbol,
                "interval": interval,
                "startTime": cursor,
                "endTime": end_ms,
                "limit": 1000,
            },
        )
        if not batch:
            break
        for k in batch:
            rows.append(
                [
                    int(k[0]),
                    float(k[1]),
                    float(k[2]),
                    float(k[3]),
                    float(k[4]),
                    float(k[5]),
                    int(k[6]),
                    float(k[7]),
                    int(k[8]),
                    float(k[9]),
                ]
            )
        nxt = int(batch[-1][0]) + step
        if nxt <= cursor:
            break
        cursor = nxt
        if len(batch) < 1000:
            break
    return rows


def fetch_bybit(symbol: str, interval: str, start_ms: int, end_ms: int) -> list[list]:
    base = "https://api.bybit.com/v5/market/kline"
    step = interval_ms(interval)
    bybit_interval = {"1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D"}
    if interval not in bybit_interval:
        raise ValueError(f"bybit fetcher does not support interval {interval!r}")
    rows: list[list] = []
    cursor = start_ms
    while cursor < end_ms:
        payload = _get_json(
            base,
            {
                "category": "spot",
                "symbol": symbol,
                "interval": bybit_interval[interval],
                "start": cursor,
                "end": end_ms,
                "limit": 1000,
            },
        )
        batch = (payload.get("result") or {}).get("list") or []
        if not batch:
            break
        batch = sorted(batch, key=lambda k: int(k[0]))  # bybit returns newest first
        for k in batch:
            open_time = int(k[0])
            rows.append(
                [
                    open_time,
                    float(k[1]),
                    float(k[2]),
                    float(k[3]),
                    float(k[4]),
                    float(k[5]),
                    open_time + step - 1,
                    float(k[6]),
                    np.nan,
                    np.nan,
                ]
            )
        nxt = int(batch[-1][0]) + step
        if nxt <= cursor:
            break
        cursor = nxt
        if len(batch) < 1000:
            break
    return rows


def fetch_coinbase(symbol: str, interval: str, start_ms: int, end_ms: int) -> list[list]:
    base = f"https://api.exchange.coinbase.com/products/{symbol}/candles"
    step = interval_ms(interval)
    granularity = step // 1000
    if granularity not in {60, 300, 900, 3600, 21600, 86400}:
        raise ValueError(f"coinbase does not support interval {interval!r}")
    rows: list[list] = []
    cursor = start_ms
    chunk = 300 * step
    while cursor < end_ms:
        stop = min(cursor + chunk, end_ms)
        batch = _get_json(
            base,
            {
                "granularity": granularity,
                "start": pd.Timestamp(cursor, unit="ms", tz="UTC").isoformat(),
                "end": pd.Timestamp(stop, unit="ms", tz="UTC").isoformat(),
            },
        )
        for k in sorted(batch, key=lambda r: int(r[0])):
            open_time = int(k[0]) * 1000
            rows.append(
                [
                    open_time,
                    float(k[3]),
                    float(k[2]),
                    float(k[1]),
                    float(k[4]),
                    float(k[5]),
                    open_time + step - 1,
                    np.nan,
                    np.nan,
                    np.nan,
                ]
            )
        cursor = stop
        time.sleep(0.25)  # public endpoint is rate limited
    return rows


_FETCHERS = {
    "binance": fetch_binance,
    "bybit": fetch_bybit,
    "coinbase": fetch_coinbase,
}


# --------------------------------------------------------------------------
# Frame construction / validation
# --------------------------------------------------------------------------


def to_dataframe(rows: list[list]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=SCHEMA)
    if df.empty:
        return df
    df = df.drop_duplicates(subset="open_time").sort_values("open_time")
    return df.reset_index(drop=True)


def add_datetime_index(df: pd.DataFrame) -> pd.DataFrame:
    """Attach a UTC DatetimeIndex derived from open_time (kept as a column too)."""
    out = df.copy()
    out.index = pd.to_datetime(out["open_time"], unit="ms", utc=True)
    out.index.name = "open_dt"
    return out


def drop_unclosed(df: pd.DataFrame, reference_ms: int | None = None) -> pd.DataFrame:
    """Remove the candle that is still forming.

    Using an unclosed candle is the single easiest way to leak the future into a
    live prediction, so it is stripped at the boundary of the system.
    """
    if df.empty:
        return df
    reference_ms = now_ms() if reference_ms is None else reference_ms
    return df[df["close_time"] <= reference_ms].reset_index(drop=True)


def validate_ohlcv(df: pd.DataFrame, interval: str) -> dict:
    """Structural sanity checks. Returns a report; raises on unusable data."""
    if df.empty:
        raise DataFetchError("no candles available")

    missing = [c for c in SCHEMA if c not in df.columns]
    if missing:
        raise DataFetchError(f"missing columns: {missing}")

    if not df["open_time"].is_monotonic_increasing:
        raise DataFetchError("open_time is not sorted ascending")
    if df["open_time"].duplicated().any():
        raise DataFetchError("duplicate open_time values")

    high_ok = (df["high"] >= df[["open", "close"]].max(axis=1) - 1e-9).all()
    low_ok = (df["low"] <= df[["open", "close"]].min(axis=1) + 1e-9).all()
    if not (high_ok and low_ok):
        raise DataFetchError("OHLC relations violated (high < max(o,c) or low > min(o,c))")

    step = interval_ms(interval)
    deltas = df["open_time"].diff().dropna()
    gaps = int((deltas != step).sum())

    return {
        "bars": int(len(df)),
        "start": str(pd.Timestamp(int(df["open_time"].iloc[0]), unit="ms", tz="UTC")),
        "end": str(pd.Timestamp(int(df["open_time"].iloc[-1]), unit="ms", tz="UTC")),
        "gap_count": gaps,
        "gap_pct": round(100.0 * gaps / max(len(df) - 1, 1), 4),
    }


# --------------------------------------------------------------------------
# Cache
# --------------------------------------------------------------------------


def cache_path(data_dir: Path, symbol: str, interval: str, source: str) -> Path:
    return Path(data_dir) / f"{source}_{symbol}_{interval}.csv"


def save_candles(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)


def load_candles(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    return to_dataframe(df[SCHEMA].values.tolist())


def download(
    symbol: str,
    interval: str,
    days: int,
    source: str = "binance",
    data_dir: Path = None,
    end_ms: int | None = None,
) -> pd.DataFrame:
    """Fetch `days` of history, merging with any cached candles on disk."""
    from .config import DATA_DIR

    data_dir = Path(data_dir) if data_dir is not None else DATA_DIR
    if source not in _FETCHERS:
        raise ValueError(f"unknown source {source!r}; known: {sorted(_FETCHERS)}")

    end_ms = now_ms() if end_ms is None else end_ms
    start_ms = end_ms - days * 86_400_000

    path = cache_path(data_dir, symbol, interval, source)
    cached = load_candles(path) if path.exists() else pd.DataFrame(columns=SCHEMA)

    if not cached.empty:
        # Only fetch what the cache is missing at the right edge.
        start_ms = max(start_ms, int(cached["open_time"].iloc[-1]) + 1)

    fresh = to_dataframe(_FETCHERS[source](symbol, interval, start_ms, end_ms))
    merged = to_dataframe(pd.concat([cached, fresh], ignore_index=True)[SCHEMA].values.tolist())
    merged = drop_unclosed(merged, end_ms)
    save_candles(merged, path)
    return merged


# --------------------------------------------------------------------------
# Synthetic candles
# --------------------------------------------------------------------------


def synthetic_klines(
    n_bars: int,
    *,
    interval: str = "15m",
    seed: int = 0,
    signal_strength: float = 0.0,
    start_price: float = 60_000.0,
    substeps: int = 15,
    end_time_ms: int | None = None,
) -> pd.DataFrame:
    """Generate candles with realistic second-order structure.

    The generator deliberately separates two things that behave very
    differently in real markets:

    * **Volatility** is strongly predictable. Log-variance follows an AR(1)
      process with intraday seasonality, so bar-to-bar volatility clusters.
    * **Direction** is not. With ``signal_strength=0`` returns are a martingale
      difference sequence: nothing in the past predicts the sign of the next
      bar, which is the honest null hypothesis for 15m crypto.

    ``signal_strength > 0`` injects a *known* amount of predictable direction
    (next return tilts with the previous standardised return). That makes this
    a positive control: a correct pipeline must score ~50% when the signal is
    off and clearly better than 50% when it is on. Both are asserted in the
    test suite.
    """
    if n_bars < 2:
        raise ValueError("n_bars must be >= 2")

    rng = np.random.default_rng(seed)
    step = interval_ms(interval)
    if end_time_ms is None:
        end_time_ms = (now_ms() // step) * step
    open_times = end_time_ms - step * np.arange(n_bars, 0, -1, dtype=np.int64)

    # Intraday volatility seasonality, peaking around the US session (~14 UTC).
    hours = (open_times // 3_600_000) % 24
    seasonal = 1.0 + 0.35 * np.cos((hours - 14) / 24.0 * 2 * np.pi)

    # AR(1) log-variance -> volatility clustering.
    phi, sigma_eta, base_vol = 0.97, 0.18, 0.0022
    shocks = rng.normal(0.0, 1.0, n_bars)
    h = np.zeros(n_bars)
    for t in range(1, n_bars):
        h[t] = phi * h[t - 1] + sigma_eta * shocks[t]
    vol = base_vol * np.exp(h / 2.0) * seasonal

    # Fat-tailed innovations, unit variance.
    nu = 4.0
    innov = rng.standard_t(nu, n_bars) / np.sqrt(nu / (nu - 2.0))

    ret = np.zeros(n_bars)
    prev_z = 0.0
    for t in range(n_bars):
        ret[t] = signal_strength * vol[t] * prev_z + vol[t] * innov[t]
        prev_z = float(np.clip(ret[t] / max(vol[t], 1e-12), -3.0, 3.0))

    # Intrabar path -> honest highs and lows.
    k = int(substeps)
    z = rng.normal(size=(n_bars, k))
    z -= z.mean(axis=1, keepdims=True)
    z /= z.std(axis=1, ddof=0, keepdims=True) + 1e-12
    sub = ret[:, None] / k + (vol[:, None] / np.sqrt(k)) * z * 0.85
    sub[:, -1] += ret - sub.sum(axis=1)  # enforce exact bar return

    log_open = np.log(start_price) + np.concatenate([[0.0], np.cumsum(ret)[:-1]])
    path = log_open[:, None] + np.cumsum(sub, axis=1)

    open_px = np.exp(log_open)
    close_px = np.exp(path[:, -1])
    high_px = np.maximum(open_px, np.exp(path.max(axis=1)))
    low_px = np.minimum(open_px, np.exp(path.min(axis=1)))

    # Volume rises with volatility and with the size of the move.
    vol_scale = np.exp(0.9 * h) * seasonal
    volume = 900.0 * vol_scale * np.exp(rng.normal(0.0, 0.35, n_bars))
    volume *= 1.0 + 0.6 * np.abs(ret) / base_vol / 10.0
    volume = np.maximum(volume, 1e-3)

    flow = 0.5 + 0.25 * np.tanh(ret / np.maximum(vol, 1e-12)) + rng.normal(0.0, 0.05, n_bars)
    taker_buy = volume * np.clip(flow, 0.05, 0.95)
    trades = np.maximum(np.round(volume * 12 + rng.normal(0, 40, n_bars)), 1.0)

    df = pd.DataFrame(
        {
            "open_time": open_times,
            "open": open_px,
            "high": high_px,
            "low": low_px,
            "close": close_px,
            "volume": volume,
            "close_time": open_times + step - 1,
            "quote_volume": volume * close_px,
            "trades": trades.astype(np.int64),
            "taker_buy_base": taker_buy,
        }
    )
    return df.reset_index(drop=True)
