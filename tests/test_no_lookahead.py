"""The tests that matter most: proof that no future information leaks backwards.

A backtest with lookahead bias looks spectacular and loses money. Rather than
reasoning about each feature by hand, these tests check the property directly:

    **Prefix invariance** — the feature row at bar t must be identical whether
    the dataset ends at bar t or continues for thousands more bars.

If any feature peeks ahead, in any way, this property breaks.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from btcpred.data import synthetic_klines
from btcpred.features import WARMUP_BARS, build_features
from btcpred.labels import make_labels
from btcpred.splits import walk_forward_folds


@pytest.fixture(scope="module")
def candles() -> pd.DataFrame:
    return synthetic_klines(1500, seed=42, signal_strength=0.0)


def test_features_are_prefix_invariant(candles):
    """Truncating the future must not change any past feature value."""
    full = build_features(candles)

    for cut in (400, 800, 1200):
        truncated = build_features(candles.iloc[:cut].reset_index(drop=True))

        assert list(truncated.columns) == list(full.columns)
        head_full = full.iloc[:cut]

        pd.testing.assert_frame_equal(
            truncated,
            head_full,
            check_exact=False,
            rtol=1e-9,
            atol=1e-12,
            obj=f"features truncated at {cut}",
        )


def test_features_ignore_rewritten_future(candles):
    """Corrupting future candles must leave earlier feature rows untouched."""
    cut = 900
    baseline = build_features(candles).iloc[:cut]

    tampered = candles.copy()
    tail = slice(cut, None)
    # Violently rewrite everything after the cut.
    tampered.loc[tail, "open"] *= 3.0
    tampered.loc[tail, "high"] *= 4.0
    tampered.loc[tail, "low"] *= 0.5
    tampered.loc[tail, "close"] *= 3.5
    tampered.loc[tail, "volume"] *= 100.0
    tampered.loc[tail, "taker_buy_base"] *= 0.01
    tampered.loc[tail, "trades"] = 1

    after = build_features(tampered).iloc[:cut]

    pd.testing.assert_frame_equal(
        baseline, after, check_exact=False, rtol=1e-9, atol=1e-12,
        obj="features after future was rewritten",
    )


def test_no_feature_correlates_suspiciously_with_the_future(candles):
    """Smoke test: a feature that correlates strongly with the next return is a red flag.

    On signal-free synthetic data nothing should predict the next bar. A large
    correlation here means either leakage or a bug in the generator.
    """
    features = build_features(candles)
    labels = make_labels(candles, horizon=1)

    frame = pd.concat([features, labels["fwd_log_ret"]], axis=1).iloc[WARMUP_BARS:].dropna()
    target = frame["fwd_log_ret"]

    offenders = {}
    for column in features.columns:
        series = frame[column]
        if series.std(ddof=0) < 1e-15:
            continue
        corr = abs(float(np.corrcoef(series, target)[0, 1]))
        if corr > 0.20:
            offenders[column] = corr

    assert not offenders, f"suspiciously predictive features (possible leakage): {offenders}"


def test_labels_look_exactly_one_bar_ahead(candles):
    labels = make_labels(candles, horizon=1)
    close = candles["close"].to_numpy()

    for t in (100, 500, 999):
        expected = np.log(close[t + 1] / close[t])
        assert labels["fwd_log_ret"].iloc[t] == pytest.approx(expected, rel=1e-12)
        assert labels["y_dir"].iloc[t] == float(close[t + 1] > close[t])

    # The final bar has no future, so it must be unlabelled.
    assert np.isnan(labels["fwd_log_ret"].iloc[-1])
    assert np.isnan(labels["y_dir"].iloc[-1])


def test_label_range_uses_only_the_forward_window(candles):
    labels = make_labels(candles, horizon=3)
    high = candles["high"].to_numpy()
    low = candles["low"].to_numpy()
    close = candles["close"].to_numpy()

    t = 300
    expected = (high[t + 1 : t + 4].max() - low[t + 1 : t + 4].min()) / close[t]
    assert labels["y_range"].iloc[t] == pytest.approx(expected, rel=1e-12)

    # Last `horizon` rows cannot be labelled.
    assert labels["y_range"].iloc[-3:].isna().all()


def test_walk_forward_never_trains_on_the_future():
    folds = walk_forward_folds(
        n_samples=10_000, train_min=3_000, test_size=500, step=500, horizon=1, embargo=8
    )
    assert folds, "expected at least one fold"

    for fold in folds:
        assert fold.train_end <= fold.test_start, "training window overlaps the test window"
        assert fold.train_start < fold.train_end
        assert fold.test_end <= 10_000


def test_walk_forward_purges_the_label_overlap():
    horizon, embargo = 5, 8
    folds = walk_forward_folds(
        n_samples=10_000, train_min=3_000, test_size=500, step=500,
        horizon=horizon, embargo=embargo,
    )
    expected_gap = (horizon - 1) + embargo

    for fold in folds:
        gap = fold.test_start - fold.train_end
        assert gap == expected_gap, f"purge gap was {gap}, expected {expected_gap}"


def test_folds_move_forward_in_time():
    folds = walk_forward_folds(
        n_samples=10_000, train_min=3_000, test_size=500, step=500, horizon=1, embargo=0
    )
    starts = [f.test_start for f in folds]
    assert starts == sorted(starts)
    assert len(set(starts)) == len(starts), "duplicate test windows"


def test_rolling_window_has_bounded_training_size():
    folds = walk_forward_folds(
        n_samples=20_000, train_min=3_000, test_size=500, step=500,
        horizon=1, embargo=0, expanding=False,
    )
    assert folds
    assert all(f.n_train <= 3_000 for f in folds)

    expanding = walk_forward_folds(
        n_samples=20_000, train_min=3_000, test_size=500, step=500,
        horizon=1, embargo=0, expanding=True,
    )
    assert expanding[-1].n_train > expanding[0].n_train
