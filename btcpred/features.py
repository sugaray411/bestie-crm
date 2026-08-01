"""Causal feature engineering.

The contract every function in this module obeys:

    The feature row at bar t is computed only from candles 0..t inclusive.

Bar ``t`` is a *closed* candle, so its own OHLCV is legitimately known at the
moment we predict bar ``t+1``. Nothing here may reference ``t+1`` or later.
``tests/test_no_lookahead.py`` enforces this empirically by rewriting the future
and checking that past feature rows do not move.

Practical consequence: never use a centred rolling window, never use
``bfill``, and never standardise with statistics computed over the whole
sample. Scaling is handled inside the walk-forward loop on training data only.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

EPS = 1e-12


# --------------------------------------------------------------------------
# Small causal primitives
# --------------------------------------------------------------------------


def _safe_div(a: pd.Series, b: pd.Series) -> pd.Series:
    return a / b.replace(0.0, np.nan)


def rolling_z(series: pd.Series, window: int) -> pd.Series:
    """Z-score against a trailing window that ends at the current bar."""
    mean = series.rolling(window, min_periods=window).mean()
    std = series.rolling(window, min_periods=window).std(ddof=0)
    return (series - mean) / (std + EPS)


def rsi(close: pd.Series, window: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1.0 / window, adjust=False, min_periods=window).mean()
    avg_loss = loss.ewm(alpha=1.0 / window, adjust=False, min_periods=window).mean()
    rs = avg_gain / (avg_loss + EPS)
    return 100.0 - 100.0 / (1.0 + rs)


def atr(df: pd.DataFrame, window: int = 14) -> pd.Series:
    prev_close = df["close"].shift(1)
    true_range = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - prev_close).abs(),
            (df["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return true_range.ewm(alpha=1.0 / window, adjust=False, min_periods=window).mean()


def parkinson_vol(df: pd.DataFrame, window: int) -> pd.Series:
    """Range-based volatility estimator; far less noisy than close-to-close."""
    hl = np.log(df["high"] / df["low"].replace(0.0, np.nan)) ** 2
    return np.sqrt(hl.rolling(window, min_periods=window).mean() / (4.0 * np.log(2.0)))


def garman_klass_vol(df: pd.DataFrame, window: int) -> pd.Series:
    hl = 0.5 * np.log(df["high"] / df["low"].replace(0.0, np.nan)) ** 2
    co = (2.0 * np.log(2.0) - 1.0) * np.log(df["close"] / df["open"].replace(0.0, np.nan)) ** 2
    return np.sqrt((hl - co).clip(lower=0.0).rolling(window, min_periods=window).mean())


# --------------------------------------------------------------------------
# Feature block builders
# --------------------------------------------------------------------------

RETURN_LAGS = (1, 2, 3, 4, 8, 12, 24, 48, 96)
VOL_WINDOWS = (4, 8, 16, 32, 96)


def _returns_block(df: pd.DataFrame, out: dict) -> pd.Series:
    close = df["close"]
    log_close = np.log(close)
    r1 = log_close.diff()
    out["log_ret_1"] = r1

    for lag in RETURN_LAGS[1:]:
        out[f"log_ret_{lag}"] = log_close.diff(lag)

    # Individual lagged bar returns let the model see short-horizon
    # autocorrelation structure directly.
    for lag in (1, 2, 3, 4, 5):
        out[f"log_ret_1_lag{lag}"] = r1.shift(lag)

    for window in (16, 96):
        out[f"ret_z_{window}"] = rolling_z(r1, window)

    return r1


def _volatility_block(df: pd.DataFrame, out: dict, r1: pd.Series) -> None:
    close = df["close"]

    for window in VOL_WINDOWS:
        out[f"rv_{window}"] = r1.rolling(window, min_periods=window).std(ddof=0)

    out["parkinson_16"] = parkinson_vol(df, 16)
    out["garman_klass_16"] = garman_klass_vol(df, 16)
    out["atr_14_pct"] = _safe_div(atr(df, 14), close)

    # Volatility regime: is short-term vol elevated relative to the baseline?
    out["vol_ratio_4_96"] = _safe_div(out["rv_4"], out["rv_96"])
    out["vol_ratio_16_96"] = _safe_div(out["rv_16"], out["rv_96"])
    out["vol_z_96"] = rolling_z(out["rv_16"], 96)

    # Realised return scaled by its own recent volatility.
    out["ret_over_vol_16"] = _safe_div(r1, out["rv_16"])


def _shape_block(df: pd.DataFrame, out: dict) -> None:
    rng = (df["high"] - df["low"]).replace(0.0, np.nan)
    body = df["close"] - df["open"]
    upper = df["high"] - df[["open", "close"]].max(axis=1)
    lower = df[["open", "close"]].min(axis=1) - df["low"]

    out["body_frac"] = body / rng
    out["upper_wick_frac"] = upper / rng
    out["lower_wick_frac"] = lower / rng
    out["range_pct"] = rng / df["open"].replace(0.0, np.nan)
    out["body_pct"] = body / df["open"].replace(0.0, np.nan)
    # Close location value: where in the bar's range did it settle?
    out["clv"] = ((df["close"] - df["low"]) - (df["high"] - df["close"])) / rng

    for lag in (1, 2):
        out[f"body_frac_lag{lag}"] = out["body_frac"].shift(lag)
        out[f"clv_lag{lag}"] = out["clv"].shift(lag)

    # Overnight-style gap between the previous close and this open.
    out["gap_pct"] = df["open"] / df["close"].shift(1).replace(0.0, np.nan) - 1.0

    out["range_z_96"] = rolling_z(out["range_pct"], 96)


def _volume_block(df: pd.DataFrame, out: dict) -> None:
    volume = df["volume"].replace(0.0, np.nan)
    out["log_volume"] = np.log(volume)
    out["volume_z_96"] = rolling_z(out["log_volume"], 96)
    out["volume_ratio_4_96"] = _safe_div(
        volume.rolling(4, min_periods=4).mean(), volume.rolling(96, min_periods=96).mean()
    )

    if "trades" in df.columns and df["trades"].notna().any():
        trades = df["trades"].replace(0.0, np.nan)
        out["log_trades"] = np.log(trades)
        out["trades_z_96"] = rolling_z(out["log_trades"], 96)
        out["avg_trade_size"] = _safe_div(volume, trades)

    # Order-flow imbalance. On Binance this is genuine aggressor-side
    # information and is one of the few features with a real economic story.
    if "taker_buy_base" in df.columns and df["taker_buy_base"].notna().any():
        ratio = df["taker_buy_base"] / volume
        ofi = 2.0 * ratio - 1.0
        out["ofi"] = ofi
        for window in (4, 16, 96):
            out[f"ofi_ma_{window}"] = ofi.rolling(window, min_periods=window).mean()
        out["ofi_z_96"] = rolling_z(ofi, 96)
        for lag in (1, 2):
            out[f"ofi_lag{lag}"] = ofi.shift(lag)


def _technical_block(df: pd.DataFrame, out: dict, r1: pd.Series) -> None:
    close = df["close"]

    out["rsi_14"] = rsi(close, 14) / 100.0
    out["rsi_48"] = rsi(close, 48) / 100.0

    ema_fast = close.ewm(span=12, adjust=False, min_periods=12).mean()
    ema_slow = close.ewm(span=26, adjust=False, min_periods=26).mean()
    macd = ema_fast - ema_slow
    macd_signal = macd.ewm(span=9, adjust=False, min_periods=9).mean()
    out["macd_hist_pct"] = _safe_div(macd - macd_signal, close)

    for window in (16, 48, 96):
        sma = close.rolling(window, min_periods=window).mean()
        std = close.rolling(window, min_periods=window).std(ddof=0)
        out[f"dist_sma_{window}"] = _safe_div(close - sma, std + EPS)

    # Bollinger %b on a 20-bar window.
    sma20 = close.rolling(20, min_periods=20).mean()
    std20 = close.rolling(20, min_periods=20).std(ddof=0)
    out["bb_pctb_20"] = (close - (sma20 - 2 * std20)) / (4 * std20 + EPS)

    # Where does the current close sit inside its recent range?
    for window in (16, 96):
        hi = df["high"].rolling(window, min_periods=window).max()
        lo = df["low"].rolling(window, min_periods=window).min()
        out[f"pos_in_range_{window}"] = (close - lo) / ((hi - lo).replace(0.0, np.nan))

    # Run length of consecutive same-signed bars.
    sign = np.sign(r1).fillna(0.0)
    streak = sign.groupby((sign != sign.shift()).cumsum()).cumcount() + 1
    out["signed_streak"] = (streak * sign).clip(-8, 8)
    out["up_frac_16"] = (r1 > 0).rolling(16, min_periods=16).mean()


def _time_block(df: pd.DataFrame, out: dict) -> None:
    ts = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    minute_of_day = ts.dt.hour * 60 + ts.dt.minute
    day_of_week = ts.dt.dayofweek

    out["tod_sin"] = np.sin(2 * np.pi * minute_of_day / 1440.0)
    out["tod_cos"] = np.cos(2 * np.pi * minute_of_day / 1440.0)
    out["dow_sin"] = np.sin(2 * np.pi * day_of_week / 7.0)
    out["dow_cos"] = np.cos(2 * np.pi * day_of_week / 7.0)
    out["is_weekend"] = (day_of_week >= 5).astype(float)


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

# Longest lookback used by any feature; rows before this are unusable.
WARMUP_BARS = 96


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Build the causal feature matrix.

    Returns a frame aligned row-for-row with ``df`` (same length, same order).
    Early rows contain NaNs while the longest window warms up; callers drop
    them via :func:`assemble`.
    """
    required = {"open", "high", "low", "close", "volume", "open_time"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"missing required columns: {sorted(missing)}")

    df = df.reset_index(drop=True)
    out: dict[str, pd.Series] = {}

    r1 = _returns_block(df, out)
    _volatility_block(df, out, r1)
    _shape_block(df, out)
    _volume_block(df, out)
    _technical_block(df, out, r1)
    _time_block(df, out)

    features = pd.DataFrame(out, index=df.index)
    # Infinities come from degenerate bars (zero range, zero volume).
    return features.replace([np.inf, -np.inf], np.nan)


def feature_columns(features: pd.DataFrame) -> list[str]:
    return list(features.columns)
