"""Model construction.

Financial tabular data has a signal-to-noise ratio far below anything these
learners were tuned for. The hyperparameters here are deliberately
conservative: shallow trees, heavy subsampling, strong regularisation, high
minimum leaf counts. A model with the capacity to fit BTC returns exactly will
fit noise exactly.
"""

from __future__ import annotations

import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

try:  # optional dependency
    import lightgbm as lgb

    HAS_LIGHTGBM = True
except ImportError:  # pragma: no cover - environment dependent
    HAS_LIGHTGBM = False

try:  # scikit-learn >= 1.6 replaced cv="prefit" with an explicit wrapper
    from sklearn.frozen import FrozenEstimator

    HAS_FROZEN = True
except ImportError:  # pragma: no cover - older scikit-learn
    HAS_FROZEN = False


def _calibrator(fitted_model):
    """Wrap an already-fitted model so calibration does not refit it."""
    if HAS_FROZEN:
        return CalibratedClassifierCV(FrozenEstimator(fitted_model), method="isotonic")
    return CalibratedClassifierCV(fitted_model, method="isotonic", cv="prefit")


def _lightgbm_classifier(seed: int, n_estimators: int):
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=n_estimators,
        learning_rate=0.02,
        num_leaves=15,
        max_depth=4,
        min_child_samples=200,
        subsample=0.7,
        subsample_freq=1,
        colsample_bytree=0.6,
        reg_alpha=1.0,
        reg_lambda=5.0,
        random_state=seed,
        n_jobs=-1,
        verbosity=-1,
    )


def build_classifier(name: str, seed: int = 7, n_estimators: int = 400):
    """Return an unfitted classifier that predicts P(next bar closes up)."""
    name = name.lower()

    if name == "lightgbm":
        if not HAS_LIGHTGBM:
            raise ImportError("lightgbm is not installed; use --model hgb or logistic")
        return _lightgbm_classifier(seed, n_estimators)

    if name == "hgb":
        return HistGradientBoostingClassifier(
            max_iter=n_estimators,
            learning_rate=0.02,
            max_leaf_nodes=15,
            max_depth=4,
            min_samples_leaf=200,
            l2_regularization=5.0,
            random_state=seed,
        )

    if name == "logistic":
        return Pipeline(
            [
                ("impute", SimpleImputer(strategy="median")),
                ("scale", StandardScaler()),
                ("clf", LogisticRegression(C=0.05, max_iter=2000, random_state=seed)),
            ]
        )

    raise ValueError(f"unknown model {name!r}; choose lightgbm, hgb or logistic")


def build_regressor(name: str, seed: int = 7, n_estimators: int = 400):
    """Return an unfitted regressor, used for the volatility/range target."""
    name = name.lower()

    if name == "lightgbm":
        if not HAS_LIGHTGBM:
            raise ImportError("lightgbm is not installed; use --model hgb or logistic")
        return lgb.LGBMRegressor(
            objective="l2",
            n_estimators=n_estimators,
            learning_rate=0.03,
            num_leaves=15,
            max_depth=4,
            min_child_samples=200,
            subsample=0.7,
            subsample_freq=1,
            colsample_bytree=0.6,
            reg_alpha=1.0,
            reg_lambda=5.0,
            random_state=seed,
            n_jobs=-1,
            verbosity=-1,
        )

    if name == "hgb":
        return HistGradientBoostingRegressor(
            max_iter=n_estimators,
            learning_rate=0.03,
            max_leaf_nodes=15,
            max_depth=4,
            min_samples_leaf=200,
            l2_regularization=5.0,
            random_state=seed,
        )

    if name == "logistic":  # linear counterpart
        return Pipeline(
            [
                ("impute", SimpleImputer(strategy="median")),
                ("scale", StandardScaler()),
                ("reg", Ridge(alpha=10.0, random_state=seed)),
            ]
        )

    raise ValueError(f"unknown model {name!r}")


def fit_classifier(model, X, y, calibrate: bool = False, calib_frac: float = 0.2, seed: int = 7):
    """Fit, optionally calibrating probabilities on a held-out tail slice.

    The calibration slice is the most recent part of the training window, held
    out chronologically. Using ``CalibratedClassifierCV`` with random folds here
    would reintroduce the temporal leakage the walk-forward loop exists to
    prevent, so the split is done by hand.
    """
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=int)

    if not calibrate or len(X) < 500:
        model.fit(X, y)
        return model

    cut = int(len(X) * (1.0 - calib_frac))
    if cut < 100 or len(X) - cut < 100:
        model.fit(X, y)
        return model

    model.fit(X[:cut], y[:cut])
    calibrated = _calibrator(model)
    calibrated.fit(X[cut:], y[cut:])
    return calibrated


def predict_proba_up(model, X) -> np.ndarray:
    """P(up) as a 1-D array, tolerant of single-class training folds."""
    X = np.asarray(X, dtype=float)
    proba = model.predict_proba(X)
    classes = getattr(model, "classes_", np.array([0, 1]))
    if proba.shape[1] == 1:
        # Degenerate fold: only one class was present in training.
        return np.full(len(X), float(classes[0]))
    up_col = int(np.where(np.asarray(classes) == 1)[0][0])
    return proba[:, up_col]


def feature_importance(model, columns: list[str]) -> dict[str, float]:
    """Best-effort importance extraction across the supported model types."""
    # Unwrap CalibratedClassifierCV and FrozenEstimator layers to reach the tree model.
    base = model
    for _ in range(4):
        if hasattr(base, "feature_importances_") or hasattr(base, "named_steps"):
            break
        nxt = getattr(base, "estimator", None)
        if nxt is None:
            break
        base = nxt

    if hasattr(base, "feature_importances_"):
        values = np.asarray(base.feature_importances_, dtype=float)
    elif hasattr(base, "named_steps") and hasattr(base.named_steps.get("clf"), "coef_"):
        values = np.abs(base.named_steps["clf"].coef_.ravel())
    else:
        return {}
    total = values.sum()
    if total <= 0:
        return {}
    return {c: float(v / total) for c, v in zip(columns, values)}
