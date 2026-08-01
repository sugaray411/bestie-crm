"""Prediction targets for the next candle.

"Predict the next candle" is not one problem, it is several, and they have very
different difficulty:

``direction``
    Will bar t+1 close above bar t's close? Nearly a coin flip on 15m BTC.
``ret``
    The signed log return of bar t+1. Same difficulty as direction, plus
    magnitude.
``range``
    The high-low range of bar t+1, scaled by price. Genuinely predictable,
    because volatility clusters.

All targets for bar ``t`` are built from bar ``t+horizon``, so the last
``horizon`` rows have no label. Those rows are exactly the ones a live
prediction is made on.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

LABEL_COLUMNS = ["fwd_log_ret", "fwd_ret_bps", "y_dir", "y_range", "y_tradeable"]


def make_labels(
    df: pd.DataFrame,
    horizon: int = 1,
    deadband_bps: float = 0.0,
) -> pd.DataFrame:
    """Build forward-looking targets aligned to the *decision* bar.

    Row ``t`` holds what happens over bars ``t+1 .. t+horizon``, i.e. what a
    model standing at the close of bar ``t`` is trying to guess.

    ``deadband_bps`` marks bars whose forward move is too small to be worth
    trading as untradeable (``y_tradeable == 0``). Setting it near the
    round-trip cost focuses training on moves that could actually pay.
    """
    if horizon < 1:
        raise ValueError("horizon must be >= 1")

    df = df.reset_index(drop=True)
    close = df["close"]

    fwd_log_ret = np.log(close.shift(-horizon) / close)
    fwd_ret_bps = fwd_log_ret * 10_000.0

    # High/low over the forward window t+1 .. t+horizon. Reversing before the
    # rolling call turns a trailing window into a leading one; the extra
    # shift(-1) moves it off the current bar.
    fwd_high = df["high"][::-1].rolling(horizon, min_periods=horizon).max()[::-1].shift(-1)
    fwd_low = df["low"][::-1].rolling(horizon, min_periods=horizon).min()[::-1].shift(-1)

    y_range = (fwd_high - fwd_low) / close

    y_dir = pd.Series(np.where(fwd_log_ret > 0, 1.0, 0.0), index=df.index)
    y_dir[fwd_log_ret.isna()] = np.nan

    if deadband_bps > 0:
        tradeable = (fwd_ret_bps.abs() >= deadband_bps).astype(float)
    else:
        tradeable = pd.Series(1.0, index=df.index)
    tradeable[fwd_log_ret.isna()] = np.nan

    return pd.DataFrame(
        {
            "fwd_log_ret": fwd_log_ret,
            "fwd_ret_bps": fwd_ret_bps,
            "y_dir": y_dir,
            "y_range": y_range,
            "y_tradeable": tradeable,
        },
        index=df.index,
    )


def assemble(
    candles: pd.DataFrame,
    features: pd.DataFrame,
    labels: pd.DataFrame,
    warmup: int,
) -> tuple[pd.DataFrame, pd.Series, pd.DataFrame]:
    """Join features and labels, dropping warmup and unlabelled rows.

    Returns ``(X, y_dir, meta)`` where ``meta`` carries the timestamps, the
    forward return used for PnL, and the other targets.
    """
    frame = pd.concat(
        [
            candles[["open_time", "close_time", "open", "high", "low", "close", "volume"]],
            features,
            labels,
        ],
        axis=1,
    )
    frame = frame.iloc[warmup:]
    frame = frame.dropna(subset=["y_dir"])
    frame = frame.dropna(subset=list(features.columns))
    frame = frame.reset_index(drop=True)

    X = frame[list(features.columns)]
    y = frame["y_dir"].astype(int)
    meta = frame[
        ["open_time", "close_time", "close", "fwd_log_ret", "fwd_ret_bps", "y_range", "y_tradeable"]
    ]
    return X, y, meta


def live_feature_row(features: pd.DataFrame) -> pd.Series:
    """The most recent fully-formed feature row, for predicting the next bar."""
    usable = features.dropna()
    if usable.empty:
        raise ValueError("no complete feature row available; fetch more history")
    return usable.iloc[-1]
