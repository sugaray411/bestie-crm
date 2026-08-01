"""Pipeline behaviour, including the positive/negative control pair.

Together these two controls are the argument that the evaluation machinery can
be trusted:

* Given data with no predictable direction, the walk-forward result must land
  near 50%. Materially above that means leakage.
* Given data with a deliberately injected edge, the result must land clearly
  above 50%. Failing that means the pipeline cannot detect signal at all, so a
  50% result would prove nothing.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from btcpred.backtest import positions_from_probabilities, simulate
from btcpred.config import Config, CostModel
from btcpred.data import (
    SCHEMA,
    drop_unclosed,
    interval_ms,
    synthetic_klines,
    validate_ohlcv,
)
from btcpred.evaluate import classification_metrics
from btcpred.pipeline import prepare_dataset, run_experiment


def _fast_config(**overrides) -> Config:
    cfg = Config(
        train_min_bars=4_000,
        test_bars=1_000,
        step_bars=1_000,
        model="lightgbm",
        calibrate=False,
        seed=11,
    )
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


# --------------------------------------------------------------------------
# Synthetic data sanity
# --------------------------------------------------------------------------


def test_synthetic_candles_are_structurally_valid():
    candles = synthetic_klines(2_000, seed=3)
    assert list(candles.columns) == SCHEMA

    info = validate_ohlcv(candles, "15m")
    assert info["bars"] == 2_000
    assert info["gap_count"] == 0

    assert (candles["high"] >= candles[["open", "close"]].max(axis=1) - 1e-9).all()
    assert (candles["low"] <= candles[["open", "close"]].min(axis=1) + 1e-9).all()
    assert (candles["volume"] > 0).all()
    assert (candles["taker_buy_base"] <= candles["volume"]).all()


def test_synthetic_candles_have_volatility_clustering():
    """Absolute returns must be autocorrelated — the defining feature of real markets."""
    candles = synthetic_klines(20_000, seed=5)
    returns = np.diff(np.log(candles["close"].to_numpy()))
    abs_ret = np.abs(returns)
    autocorr = float(np.corrcoef(abs_ret[:-1], abs_ret[1:])[0, 1])
    assert autocorr > 0.05, f"expected volatility clustering, got autocorr={autocorr:.4f}"


def test_synthetic_returns_are_unpredictable_by_default():
    """With signal_strength=0 the return series must be a martingale difference."""
    candles = synthetic_klines(20_000, seed=5, signal_strength=0.0)
    returns = np.diff(np.log(candles["close"].to_numpy()))
    autocorr = float(np.corrcoef(returns[:-1], returns[1:])[0, 1])
    assert abs(autocorr) < 0.03, f"returns should be near-unpredictable, got {autocorr:.4f}"


def test_injected_signal_creates_real_autocorrelation():
    candles = synthetic_klines(20_000, seed=5, signal_strength=0.30)
    returns = np.diff(np.log(candles["close"].to_numpy()))
    autocorr = float(np.corrcoef(returns[:-1], returns[1:])[0, 1])
    assert autocorr > 0.10, f"expected injected signal to show up, got {autocorr:.4f}"


def test_unclosed_candle_is_dropped():
    candles = synthetic_klines(100, seed=1)
    reference = int(candles["close_time"].iloc[-1]) - 1  # last bar still forming
    trimmed = drop_unclosed(candles, reference_ms=reference)
    assert len(trimmed) == 99
    assert trimmed["close_time"].iloc[-1] <= reference


# --------------------------------------------------------------------------
# Dataset assembly
# --------------------------------------------------------------------------


def test_prepare_dataset_drops_warmup_and_unlabelled_rows():
    candles = synthetic_klines(1_000, seed=9)
    cfg = _fast_config()
    X, y, meta = prepare_dataset(candles, cfg)

    assert len(X) == len(y) == len(meta)
    assert not X.isna().any().any(), "feature matrix still contains NaNs"
    assert set(np.unique(y)) <= {0, 1}
    # Warmup plus the final unlabelled bar are gone.
    assert len(X) < len(candles)
    assert meta["fwd_log_ret"].notna().all()


def test_prepare_dataset_preserves_chronological_order():
    candles = synthetic_klines(1_000, seed=9)
    _, _, meta = prepare_dataset(candles, _fast_config())
    assert meta["open_time"].is_monotonic_increasing


# --------------------------------------------------------------------------
# Controls
# --------------------------------------------------------------------------


@pytest.mark.slow
def test_null_data_yields_no_edge():
    """NEGATIVE CONTROL: unpredictable data must score near 50%."""
    candles = synthetic_klines(12_000, seed=21, signal_strength=0.0)
    report = run_experiment(candles, _fast_config(), verbose=False)
    accuracy = report["metrics"]["accuracy"]
    auc = report["metrics"]["auc"]

    assert 0.46 < accuracy < 0.54, f"suspicious accuracy {accuracy:.4f} on unpredictable data"
    assert 0.44 < auc < 0.56, f"suspicious AUC {auc:.4f} on unpredictable data"


@pytest.mark.slow
def test_injected_signal_is_detected():
    """POSITIVE CONTROL: a real edge must be found, else 50% proves nothing."""
    candles = synthetic_klines(12_000, seed=21, signal_strength=0.35)
    report = run_experiment(candles, _fast_config(), verbose=False)
    accuracy = report["metrics"]["accuracy"]

    assert accuracy > 0.53, f"pipeline failed to detect an injected edge (acc={accuracy:.4f})"


# --------------------------------------------------------------------------
# Trading simulation
# --------------------------------------------------------------------------


def test_positions_respect_threshold():
    p = np.array([0.40, 0.49, 0.50, 0.51, 0.60])
    pos = positions_from_probabilities(p, threshold=0.02)
    assert list(pos) == [-1.0, 0.0, 0.0, 0.0, 1.0]

    long_only = positions_from_probabilities(p, threshold=0.02, allow_short=False)
    assert list(long_only) == [0.0, 0.0, 0.0, 0.0, 1.0]


def test_costs_reduce_returns():
    n = 500
    rng = np.random.default_rng(0)
    oos = pd.DataFrame(
        {
            "open_time": np.arange(n) * interval_ms("15m"),
            "p_up": rng.uniform(0.3, 0.7, n),
            "fwd_log_ret": rng.normal(0, 0.002, n),
            "y_true": rng.integers(0, 2, n),
        }
    )

    free = simulate(oos, 0.0, CostModel(fee_bps_per_side=0.0, slippage_bps_per_side=0.0))
    costly = simulate(oos, 0.0, CostModel(fee_bps_per_side=4.0, slippage_bps_per_side=1.0))

    assert free["cost_paid_pct"] == pytest.approx(0.0)
    assert costly["cost_paid_pct"] > 0
    assert costly["net_return_pct"] < free["net_return_pct"]
    assert free["gross_return_pct"] == pytest.approx(costly["gross_return_pct"], rel=1e-9)


def test_flat_position_costs_nothing():
    n = 100
    oos = pd.DataFrame(
        {
            "open_time": np.arange(n) * interval_ms("15m"),
            "p_up": np.full(n, 0.5),          # never crosses the threshold
            "fwd_log_ret": np.full(n, 0.001),
            "y_true": np.ones(n, dtype=int),
        }
    )
    stats = simulate(oos, 0.02, CostModel())
    assert stats["trades"] == 0
    assert stats["cost_paid_pct"] == pytest.approx(0.0)
    assert stats["net_return_pct"] == pytest.approx(0.0)


def test_multi_bar_horizon_does_not_double_count_returns():
    """Overlapping forward returns must not be summed as if they were separate trades.

    With horizon=4 every row's return covers the same four bars as its three
    neighbours. Trading each row would book that move four times over.
    """
    n, horizon = 400, 4
    oos = pd.DataFrame(
        {
            "open_time": np.arange(n) * interval_ms("15m"),
            "p_up": np.full(n, 0.99),               # always long
            "fwd_log_ret": np.full(n, 0.001),       # every 4-bar window gains 10 bps
            "y_true": np.ones(n, dtype=int),
        }
    )
    free = CostModel(fee_bps_per_side=0.0, slippage_bps_per_side=0.0)

    overlapped = simulate(oos, 0.02, free, horizon=1)
    correct = simulate(oos, 0.02, free, horizon=horizon)

    assert correct["n_bars"] == n // horizon
    # Holding through the whole period gains n/horizon non-overlapping windows.
    assert correct["gross_return_pct"] == pytest.approx(100.0 * 0.001 * (n // horizon))
    assert correct["gross_return_pct"] == pytest.approx(
        overlapped["gross_return_pct"] / horizon, rel=1e-9
    )


def test_perfect_foresight_makes_money_after_costs():
    """Sanity check on the simulator itself, not on the model."""
    n = 400
    rng = np.random.default_rng(4)
    fwd = rng.normal(0, 0.004, n)
    oos = pd.DataFrame(
        {
            "open_time": np.arange(n) * interval_ms("15m"),
            "p_up": np.where(fwd > 0, 0.99, 0.01),   # cheating on purpose
            "fwd_log_ret": fwd,
            "y_true": (fwd > 0).astype(int),
        }
    )
    stats = simulate(oos, 0.02, CostModel())
    assert stats["net_return_pct"] > 0
    assert stats["hit_rate_active"] == pytest.approx(1.0)


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------


def test_metrics_on_a_perfect_and_a_useless_predictor():
    y = np.array([0, 1, 0, 1, 1, 0, 1, 0])

    perfect = classification_metrics(y, y.astype(float) * 0.98 + 0.01)
    assert perfect["accuracy"] == pytest.approx(1.0)
    assert perfect["auc"] == pytest.approx(1.0)

    useless = classification_metrics(y, np.full(len(y), 0.5))
    assert useless["auc"] == pytest.approx(0.5)
    assert useless["log_loss_skill"] == pytest.approx(0.0, abs=1e-9)
