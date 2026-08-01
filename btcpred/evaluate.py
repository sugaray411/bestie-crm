"""Metrics, baselines and significance tests.

A directional accuracy of 51% means nothing on its own. It has to be compared
against what you would get for free, and it has to survive a test for whether
it could plausibly be luck. Everything in this module exists to stop a number
like that from being mistaken for an edge.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    brier_score_loss,
    log_loss,
    matthews_corrcoef,
    roc_auc_score,
)


def classification_metrics(y_true: np.ndarray, p_up: np.ndarray) -> dict:
    y_true = np.asarray(y_true, dtype=int)
    p_up = np.clip(np.asarray(p_up, dtype=float), 1e-6, 1 - 1e-6)
    y_pred = (p_up > 0.5).astype(int)

    metrics = {
        "n": int(len(y_true)),
        "base_rate_up": float(y_true.mean()),
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "balanced_accuracy": float(balanced_accuracy_score(y_true, y_pred)),
        "log_loss": float(log_loss(y_true, p_up, labels=[0, 1])),
        "brier": float(brier_score_loss(y_true, p_up)),
        "mcc": float(matthews_corrcoef(y_true, y_pred)) if len(np.unique(y_pred)) > 1 else 0.0,
        "pred_up_rate": float(y_pred.mean()),
    }
    metrics["auc"] = (
        float(roc_auc_score(y_true, p_up)) if len(np.unique(y_true)) > 1 else float("nan")
    )
    # Log loss of the constant base-rate predictor: the bar to clear.
    base = float(y_true.mean())
    metrics["log_loss_baseline"] = float(
        log_loss(y_true, np.full(len(y_true), np.clip(base, 1e-6, 1 - 1e-6)), labels=[0, 1])
    )
    metrics["log_loss_skill"] = metrics["log_loss_baseline"] - metrics["log_loss"]
    return metrics


def baseline_accuracies(y_true: np.ndarray, prev_direction: np.ndarray | None = None) -> dict:
    """Free strategies the model must beat to be worth anything."""
    y_true = np.asarray(y_true, dtype=int)
    out = {
        "always_up": float((y_true == 1).mean()),
        "always_down": float((y_true == 0).mean()),
        "majority_class": float(max((y_true == 1).mean(), (y_true == 0).mean())),
    }
    if prev_direction is not None:
        prev = np.asarray(prev_direction, dtype=int)
        out["persistence"] = float((y_true == prev).mean())
        out["mean_reversion"] = float((y_true == (1 - prev)).mean())
    return out


def binomial_test(correct: int, n: int, p_null: float = 0.5) -> dict:
    """Two-sided exact test that accuracy differs from chance."""
    if n == 0:
        return {"accuracy": float("nan"), "p_value": float("nan")}
    result = stats.binomtest(int(correct), int(n), p_null, alternative="two-sided")
    return {
        "accuracy": correct / n,
        "p_null": p_null,
        "p_value": float(result.pvalue),
        "ci95": [float(v) for v in result.proportion_ci(0.95)],
    }


def calibration_table(y_true: np.ndarray, p_up: np.ndarray, bins: int = 10) -> pd.DataFrame:
    """Are predicted probabilities honest? Compare predicted vs realised."""
    y_true = np.asarray(y_true, dtype=int)
    p_up = np.asarray(p_up, dtype=float)
    edges = np.quantile(p_up, np.linspace(0, 1, bins + 1))
    edges = np.unique(edges)
    if len(edges) < 3:
        return pd.DataFrame(columns=["bin", "n", "mean_pred", "realised", "gap"])

    idx = np.clip(np.digitize(p_up, edges[1:-1], right=True), 0, len(edges) - 2)
    rows = []
    for b in range(len(edges) - 1):
        mask = idx == b
        if mask.sum() == 0:
            continue
        rows.append(
            {
                "bin": f"[{edges[b]:.3f}, {edges[b + 1]:.3f}]",
                "n": int(mask.sum()),
                "mean_pred": float(p_up[mask].mean()),
                "realised": float(y_true[mask].mean()),
                "gap": float(p_up[mask].mean() - y_true[mask].mean()),
            }
        )
    return pd.DataFrame(rows)


def regression_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    """For the volatility/range target, scored against a persistence baseline."""
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    mask = np.isfinite(y_true) & np.isfinite(y_pred)
    y_true, y_pred = y_true[mask], y_pred[mask]
    if len(y_true) < 3:
        return {"n": int(len(y_true))}

    resid = y_true - y_pred
    ss_res = float((resid**2).sum())
    ss_tot = float(((y_true - y_true.mean()) ** 2).sum())
    return {
        "n": int(len(y_true)),
        "mae": float(np.abs(resid).mean()),
        "rmse": float(np.sqrt((resid**2).mean())),
        "r2": float(1.0 - ss_res / ss_tot) if ss_tot > 0 else float("nan"),
        "corr": float(np.corrcoef(y_true, y_pred)[0, 1]),
    }


def bootstrap_mean_test(
    values: np.ndarray, n_boot: int = 5000, seed: int = 7
) -> dict:
    """Bootstrap CI for a mean (used on per-bar PnL) plus a one-sided p-value."""
    values = np.asarray(values, dtype=float)
    values = values[np.isfinite(values)]
    if len(values) < 30:
        return {"mean": float(values.mean()) if len(values) else float("nan")}

    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(values), size=(n_boot, len(values)))
    means = values[idx].mean(axis=1)
    return {
        "mean": float(values.mean()),
        "ci95_low": float(np.quantile(means, 0.025)),
        "ci95_high": float(np.quantile(means, 0.975)),
        "p_value_gt_zero": float((means <= 0).mean()),
    }
