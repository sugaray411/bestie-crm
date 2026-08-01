"""Walk-forward out-of-sample prediction and trading simulation.

Two separate questions, kept separate on purpose:

* *Statistical*: does the model predict direction better than chance?
* *Economic*: does that prediction survive fees and slippage?

The second is much harder than the first. A model that is right 51.5% of the
time sounds like an edge, but on 15m BTC the average absolute move is roughly
20-30 bps while a round trip costs about 10 bps. Small accuracy edges are
routinely eaten whole by costs, which is why the simulation charges for every
position change rather than reporting gross returns.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .config import BARS_PER_YEAR, Config, CostModel
from .models import build_classifier, feature_importance, fit_classifier, predict_proba_up
from .splits import Fold, fold_arrays, walk_forward_folds


def run_walk_forward(
    X: pd.DataFrame,
    y: pd.Series,
    meta: pd.DataFrame,
    cfg: Config,
    verbose: bool = True,
) -> tuple[pd.DataFrame, list[dict]]:
    """Train and predict fold by fold, never letting a model see its own future.

    Returns the concatenated out-of-sample predictions and per-fold diagnostics.
    """
    folds = walk_forward_folds(
        n_samples=len(X),
        train_min=cfg.train_min_bars,
        test_size=cfg.test_bars,
        step=cfg.step_bars,
        horizon=cfg.horizon,
        embargo=cfg.embargo_bars,
        expanding=cfg.expanding,
    )
    if not folds:
        raise ValueError(
            f"not enough data for walk-forward: {len(X)} usable bars but "
            f"train_min_bars={cfg.train_min_bars} + test_bars={cfg.test_bars} required. "
            "Fetch more history or lower --train-min."
        )

    X_values = X.to_numpy(dtype=float)
    y_values = y.to_numpy(dtype=int)
    columns = list(X.columns)

    predictions: list[pd.DataFrame] = []
    diagnostics: list[dict] = []

    # With a deadband, train only on bars whose move was big enough to be worth
    # trading. The test set is never filtered — doing so would quietly drop the
    # hardest bars and inflate the reported accuracy.
    tradeable = (
        meta["y_tradeable"].to_numpy(dtype=float) if cfg.deadband_bps > 0 else None
    )

    for fold in folds:
        train_idx, test_idx = fold_arrays(fold)

        if tradeable is not None:
            kept = train_idx[tradeable[train_idx] > 0]
            if len(kept) >= 500 and len(np.unique(y_values[kept])) > 1:
                train_idx = kept

        model = build_classifier(cfg.model, seed=cfg.seed)
        fitted = fit_classifier(
            model,
            X_values[train_idx],
            y_values[train_idx],
            calibrate=cfg.calibrate,
            seed=cfg.seed,
        )
        p_up = predict_proba_up(fitted, X_values[test_idx])

        block = meta.iloc[test_idx].copy()
        block["p_up"] = p_up
        block["y_true"] = y_values[test_idx]
        block["fold"] = fold.index
        predictions.append(block)

        acc = float(((p_up > 0.5).astype(int) == y_values[test_idx]).mean())
        diagnostics.append(
            {
                "fold": fold.index,
                "n_train": int(len(train_idx)),
                "n_test": fold.n_test,
                "train_up_rate": float(y_values[train_idx].mean()),
                "test_up_rate": float(y_values[test_idx].mean()),
                "accuracy": acc,
                "importance": feature_importance(fitted, columns),
            }
        )
        if verbose:
            print(
                f"  fold {fold.index:>2}  train={len(train_idx):>6}  "
                f"test={fold.n_test:>5}  acc={acc:.4f}"
            )

    oos = pd.concat(predictions, ignore_index=True)
    return oos, diagnostics


def positions_from_probabilities(
    p_up: np.ndarray, threshold: float, allow_short: bool = True
) -> np.ndarray:
    """Map probabilities to target positions in {-1, 0, +1}."""
    p_up = np.asarray(p_up, dtype=float)
    pos = np.zeros(len(p_up))
    pos[p_up > 0.5 + threshold] = 1.0
    if allow_short:
        pos[p_up < 0.5 - threshold] = -1.0
    return pos


def simulate(
    oos: pd.DataFrame,
    threshold: float,
    costs: CostModel,
    allow_short: bool = True,
    horizon: int = 1,
) -> dict:
    """Charge costs on every position change and report net performance.

    When ``horizon > 1`` each row's forward return spans several bars, so
    consecutive rows overlap. Trading every row would count the same price move
    ``horizon`` times over and manufacture returns that are not achievable.
    Rows are therefore thinned to every ``horizon``-th bar, giving a series of
    non-overlapping, actually-holdable positions.
    """
    if oos.empty:
        return {"n_bars": 0}

    oos = oos.sort_values("open_time").reset_index(drop=True)
    if horizon > 1:
        oos = oos.iloc[::horizon].reset_index(drop=True)

    periods_per_year = BARS_PER_YEAR / max(horizon, 1)
    fwd_ret = oos["fwd_log_ret"].to_numpy(dtype=float)
    pos = positions_from_probabilities(oos["p_up"].to_numpy(), threshold, allow_short)

    # Cost is proportional to how much the position changes. Entering from flat
    # costs one side; flipping long to short costs two.
    prev_pos = np.concatenate([[0.0], pos[:-1]])
    turnover = np.abs(pos - prev_pos)
    cost = turnover * costs.per_side_frac

    gross = pos * fwd_ret
    net = gross - cost

    equity = np.cumsum(net)
    peak = np.maximum.accumulate(equity)
    drawdown = equity - peak

    active = pos != 0
    n_active = int(active.sum())
    wins = int(((gross > 0) & active).sum())

    std = float(net.std(ddof=0))
    sharpe = float(net.mean() / std * np.sqrt(periods_per_year)) if std > 0 else float("nan")

    downside = net[net < 0]
    dstd = float(downside.std(ddof=0)) if len(downside) > 1 else 0.0
    sortino = float(net.mean() / dstd * np.sqrt(periods_per_year)) if dstd > 0 else float("nan")

    n_bars = len(oos)
    years = n_bars / periods_per_year

    return {
        "n_bars": n_bars,
        "years": float(years),
        "threshold": float(threshold),
        "trades": int((turnover > 0).sum()),
        "bars_in_market_pct": float(100.0 * n_active / n_bars),
        "hit_rate_active": float(wins / n_active) if n_active else float("nan"),
        "gross_return_pct": float(100.0 * gross.sum()),
        "cost_paid_pct": float(100.0 * cost.sum()),
        "net_return_pct": float(100.0 * net.sum()),
        "net_return_annualised_pct": float(100.0 * net.sum() / years) if years > 0 else float("nan"),
        "sharpe_net": sharpe,
        "sortino_net": sortino,
        "max_drawdown_pct": float(100.0 * drawdown.min()),
        "mean_net_bps_per_bar": float(1e4 * net.mean()),
        "net_series": net,
        "equity_curve": equity,
    }


def buy_and_hold(oos: pd.DataFrame, horizon: int = 1) -> dict:
    """The benchmark any BTC strategy actually has to beat."""
    if oos.empty:
        return {}
    oos = oos.sort_values("open_time").reset_index(drop=True)
    if horizon > 1:  # de-overlap, same reasoning as in simulate()
        oos = oos.iloc[::horizon].reset_index(drop=True)

    periods_per_year = BARS_PER_YEAR / max(horizon, 1)
    fwd_ret = oos["fwd_log_ret"].to_numpy(dtype=float)
    equity = np.cumsum(fwd_ret)
    peak = np.maximum.accumulate(equity)
    std = float(fwd_ret.std(ddof=0))
    years = len(fwd_ret) / periods_per_year
    return {
        "net_return_pct": float(100.0 * fwd_ret.sum()),
        "net_return_annualised_pct": float(100.0 * fwd_ret.sum() / years) if years > 0 else float("nan"),
        "sharpe_net": float(fwd_ret.mean() / std * np.sqrt(periods_per_year)) if std > 0 else float("nan"),
        "max_drawdown_pct": float(100.0 * (equity - peak).min()),
    }


def threshold_sweep(
    oos: pd.DataFrame,
    costs: CostModel,
    thresholds: list[float] | None = None,
    horizon: int = 1,
) -> pd.DataFrame:
    """How selectivity trades off against opportunity.

    Note this sweep is itself an in-sample choice: picking the best threshold
    here and reporting its return is a mild form of overfitting. It is shown to
    illustrate the shape of the trade-off, not to select a live parameter.
    """
    if thresholds is None:
        thresholds = [0.0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.10]
    rows = []
    for t in thresholds:
        stats = simulate(oos, t, costs, horizon=horizon)
        rows.append(
            {
                "threshold": t,
                "bars_in_market_pct": stats["bars_in_market_pct"],
                "trades": stats["trades"],
                "hit_rate_active": stats["hit_rate_active"],
                "gross_return_pct": stats["gross_return_pct"],
                "cost_paid_pct": stats["cost_paid_pct"],
                "net_return_pct": stats["net_return_pct"],
                "sharpe_net": stats["sharpe_net"],
            }
        )
    return pd.DataFrame(rows)


def aggregate_importance(diagnostics: list[dict], top_n: int = 20) -> pd.DataFrame:
    """Average feature importance across folds."""
    totals: dict[str, list[float]] = {}
    for diag in diagnostics:
        for name, value in (diag.get("importance") or {}).items():
            totals.setdefault(name, []).append(value)
    if not totals:
        return pd.DataFrame(columns=["feature", "mean_importance"])
    rows = [
        {"feature": name, "mean_importance": float(np.mean(values))}
        for name, values in totals.items()
    ]
    df = pd.DataFrame(rows).sort_values("mean_importance", ascending=False)
    return df.head(top_n).reset_index(drop=True)
