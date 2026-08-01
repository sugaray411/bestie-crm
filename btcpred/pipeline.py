"""End-to-end orchestration: data -> features -> walk-forward -> report."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from . import backtest, evaluate
from .config import ARTIFACT_DIR, Config
from .data import add_datetime_index, synthetic_klines, validate_ohlcv
from .features import WARMUP_BARS, build_features
from .labels import assemble, live_feature_row, make_labels
from .models import build_classifier, build_regressor, fit_classifier, predict_proba_up
from .splits import fold_arrays, walk_forward_folds


def prepare_dataset(candles: pd.DataFrame, cfg: Config):
    """Candles -> (X, y, meta), with all causality rules applied."""
    features = build_features(candles)
    labels = make_labels(candles, horizon=cfg.horizon, deadband_bps=cfg.deadband_bps)
    return assemble(candles, features, labels, warmup=WARMUP_BARS)


def run_experiment(candles: pd.DataFrame, cfg: Config, verbose: bool = True) -> dict:
    """Full walk-forward evaluation of the direction model plus baselines."""
    X, y, meta = prepare_dataset(candles, cfg)
    if verbose:
        print(f"dataset: {len(X)} labelled bars, {X.shape[1]} features")

    oos, diagnostics = backtest.run_walk_forward(X, y, meta, cfg, verbose=verbose)

    y_true = oos["y_true"].to_numpy(dtype=int)
    p_up = oos["p_up"].to_numpy(dtype=float)
    y_pred = (p_up > 0.5).astype(int)

    metrics = evaluate.classification_metrics(y_true, p_up)

    # Persistence baseline: assume the next bar repeats this bar's direction.
    prev_dir = (oos["fwd_log_ret"].shift(1) > 0).astype(int).to_numpy()
    baselines = evaluate.baseline_accuracies(y_true, prev_dir)

    correct = int((y_pred == y_true).sum())

    # A binomial test assumes independent trials. When horizon > 1 consecutive
    # labels are built from overlapping price windows, so the real information
    # content is closer to n/horizon observations. Without this correction a
    # multi-bar horizon reports wildly overstated significance.
    n_eff = max(len(y_true) // max(cfg.horizon, 1), 1)
    correct_eff = int(round(metrics["accuracy"] * n_eff))

    significance = evaluate.binomial_test(correct_eff, n_eff, p_null=0.5)
    significance["effective_n"] = n_eff
    significance["overlap_adjusted"] = cfg.horizon > 1
    vs_majority = evaluate.binomial_test(
        correct_eff, n_eff, p_null=max(baselines["majority_class"], 1e-6)
    )

    calibration = evaluate.calibration_table(y_true, p_up)

    sim = backtest.simulate(oos, cfg.trade_threshold, cfg.costs, horizon=cfg.horizon)
    pnl_test = evaluate.bootstrap_mean_test(sim["net_series"], seed=cfg.seed)
    sweep = backtest.threshold_sweep(oos, cfg.costs, horizon=cfg.horizon)
    hold = backtest.buy_and_hold(oos, horizon=cfg.horizon)
    importance = backtest.aggregate_importance(diagnostics)

    fold_accs = [d["accuracy"] for d in diagnostics]

    return {
        "config": asdict(cfg),
        "data": {
            "labelled_bars": int(len(X)),
            "n_features": int(X.shape[1]),
            "oos_bars": int(len(oos)),
            "n_folds": len(diagnostics),
            "start": str(pd.Timestamp(int(meta["open_time"].iloc[0]), unit="ms", tz="UTC")),
            "end": str(pd.Timestamp(int(meta["open_time"].iloc[-1]), unit="ms", tz="UTC")),
        },
        "metrics": metrics,
        "baselines": baselines,
        "significance_vs_coinflip": significance,
        "significance_vs_majority": vs_majority,
        "fold_accuracy": {
            "mean": float(np.mean(fold_accs)),
            "std": float(np.std(fold_accs)),
            "min": float(np.min(fold_accs)),
            "max": float(np.max(fold_accs)),
            "pct_folds_above_50": float(100.0 * np.mean([a > 0.5 for a in fold_accs])),
        },
        "calibration": calibration,
        "trading": {k: v for k, v in sim.items() if k not in {"net_series", "equity_curve"}},
        "trading_significance": pnl_test,
        "threshold_sweep": sweep,
        "buy_and_hold": hold,
        "importance": importance,
        "oos": oos,
    }


def run_volatility_experiment(candles: pd.DataFrame, cfg: Config, verbose: bool = True) -> dict:
    """Same walk-forward protocol applied to next-bar range.

    Included because it is the honest counterweight to the direction result:
    volatility is genuinely forecastable, direction mostly is not.
    """
    features = build_features(candles)
    labels = make_labels(candles, horizon=cfg.horizon)
    frame = pd.concat([candles[["open_time"]], features, labels], axis=1)
    frame = frame.iloc[WARMUP_BARS:].dropna(subset=["y_range"]).dropna(subset=list(features.columns))
    frame = frame.reset_index(drop=True)

    X = frame[list(features.columns)].to_numpy(dtype=float)
    y = frame["y_range"].to_numpy(dtype=float)

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
        raise ValueError("not enough data for the volatility walk-forward")

    preds, actuals, naive = [], [], []
    for fold in folds:
        train_idx, test_idx = fold_arrays(fold)
        model = build_regressor(cfg.model, seed=cfg.seed)
        model.fit(X[train_idx], y[train_idx])
        preds.append(model.predict(X[test_idx]))
        actuals.append(y[test_idx])
        # Naive baseline: next bar's range equals this bar's range.
        naive.append(frame["y_range"].shift(1).to_numpy(dtype=float)[test_idx])
        if verbose:
            print(f"  vol fold {fold.index:>2} done")

    y_pred = np.concatenate(preds)
    y_true = np.concatenate(actuals)
    y_naive = np.concatenate(naive)

    return {
        "model": evaluate.regression_metrics(y_true, y_pred),
        "persistence_baseline": evaluate.regression_metrics(y_true, y_naive),
    }


# --------------------------------------------------------------------------
# Final model / live prediction
# --------------------------------------------------------------------------


def train_final_model(candles: pd.DataFrame, cfg: Config):
    """Fit on all available labelled history, for predicting the live next bar."""
    X, y, meta = prepare_dataset(candles, cfg)

    # Mirror the deadband filter used during walk-forward training.
    if cfg.deadband_bps > 0:
        keep = meta["y_tradeable"].to_numpy(dtype=float) > 0
        if keep.sum() >= 500 and len(np.unique(y.to_numpy()[keep])) > 1:
            X, y, meta = X[keep], y[keep], meta[keep]

    model = build_classifier(cfg.model, seed=cfg.seed)
    fitted = fit_classifier(
        model, X.to_numpy(dtype=float), y.to_numpy(dtype=int), calibrate=cfg.calibrate, seed=cfg.seed
    )
    return fitted, list(X.columns), meta


def save_model(model, columns: list[str], cfg: Config, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "columns": columns, "config": asdict(cfg)}, path)


def load_model(path: Path):
    payload = joblib.load(path)
    return payload["model"], payload["columns"], Config.from_dict(payload["config"])


def predict_next(candles: pd.DataFrame, model, columns: list[str]) -> dict:
    """Predict the bar that follows the last closed candle."""
    candles = candles.reset_index(drop=True)
    features = build_features(candles)
    row = live_feature_row(features)
    x = row[columns].to_numpy(dtype=float).reshape(1, -1)
    p_up = float(predict_proba_up(model, x)[0])

    last = candles.iloc[row.name]
    interval_ms = int(last["close_time"]) - int(last["open_time"]) + 1
    next_open = int(last["close_time"]) + 1

    return {
        "last_closed_open_time": str(pd.Timestamp(int(last["open_time"]), unit="ms", tz="UTC")),
        "last_close": float(last["close"]),
        "predicts_bar_starting": str(pd.Timestamp(next_open, unit="ms", tz="UTC")),
        "predicts_bar_ending": str(
            pd.Timestamp(next_open + interval_ms - 1, unit="ms", tz="UTC")
        ),
        "p_up": p_up,
        "direction": "UP" if p_up > 0.5 else "DOWN",
        "confidence_over_coinflip": abs(p_up - 0.5),
    }


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------


def format_report(report: dict, vol_report: dict | None = None) -> str:
    m = report["metrics"]
    b = report["baselines"]
    t = report["trading"]
    f = report["fold_accuracy"]
    sig = report["significance_vs_coinflip"]
    d = report["data"]

    lines: list[str] = []
    add = lines.append

    add("=" * 72)
    add("WALK-FORWARD OUT-OF-SAMPLE REPORT")
    add("=" * 72)
    add(f"period            : {d['start']}  ->  {d['end']}")
    add(f"labelled bars     : {d['labelled_bars']:,}   features: {d['n_features']}")
    add(f"out-of-sample bars: {d['oos_bars']:,}   folds: {d['n_folds']}")
    add(f"model             : {report['config']['model']}")
    add("")

    add("-- DIRECTION (can it call the next candle?) " + "-" * 28)
    add(f"accuracy            : {m['accuracy']:.4f}")
    add(f"  vs always-up      : {b['always_up']:.4f}")
    add(f"  vs majority class : {b['majority_class']:.4f}")
    if "persistence" in b:
        add(f"  vs persistence    : {b['persistence']:.4f}")
        add(f"  vs mean-reversion : {b['mean_reversion']:.4f}")
    add(f"AUC                 : {m['auc']:.4f}   (0.5 = no skill)")
    add(f"log loss            : {m['log_loss']:.5f}  vs base rate {m['log_loss_baseline']:.5f}")
    add(f"log-loss skill      : {m['log_loss_skill']:+.5f}  (positive = better than base rate)")
    add(f"Brier score         : {m['brier']:.5f}")
    add(f"MCC                 : {m['mcc']:+.4f}")
    add(
        f"binomial vs 50%     : p = {sig['p_value']:.4g}   "
        f"95% CI [{sig['ci95'][0]:.4f}, {sig['ci95'][1]:.4f}]"
    )
    if sig.get("overlap_adjusted"):
        add(
            f"                      (effective n = {sig['effective_n']:,} after "
            f"correcting for overlapping labels)"
        )
    add(
        f"per-fold accuracy   : {f['mean']:.4f} +/- {f['std']:.4f}  "
        f"(min {f['min']:.4f}, max {f['max']:.4f}, {f['pct_folds_above_50']:.0f}% of folds > 50%)"
    )
    add("")

    add("-- ECONOMICS (does the edge survive costs?) " + "-" * 28)
    costs = report["config"]["costs"]
    add(
        f"cost assumption     : {costs['fee_bps_per_side']:.1f} bps fee + "
        f"{costs['slippage_bps_per_side']:.1f} bps slippage per side "
        f"({2 * (costs['fee_bps_per_side'] + costs['slippage_bps_per_side']):.1f} bps round trip)"
    )
    add(f"threshold           : {t['threshold']:.3f}   trades: {t['trades']:,}")
    add(f"bars in market      : {t['bars_in_market_pct']:.1f}%")
    add(f"hit rate (active)   : {t['hit_rate_active']:.4f}")
    add(f"gross return        : {t['gross_return_pct']:+.2f}%")
    add(f"costs paid          : {t['cost_paid_pct']:.2f}%")
    add(f"NET return          : {t['net_return_pct']:+.2f}%  "
        f"({t['net_return_annualised_pct']:+.2f}%/yr over {t['years']:.2f} yr)")
    add(f"net Sharpe          : {t['sharpe_net']:.3f}")
    add(f"max drawdown        : {t['max_drawdown_pct']:.2f}%")
    add(f"mean net per bar    : {t['mean_net_bps_per_bar']:+.4f} bps")

    ts = report["trading_significance"]
    if "ci95_low" in ts:
        add(
            f"bootstrap mean PnL  : {1e4 * ts['mean']:+.4f} bps  "
            f"95% CI [{1e4 * ts['ci95_low']:+.4f}, {1e4 * ts['ci95_high']:+.4f}] bps  "
            f"p(<=0) = {ts['p_value_gt_zero']:.3f}"
        )
    hold = report["buy_and_hold"]
    if hold:
        add(
            f"buy & hold over same period: {hold['net_return_pct']:+.2f}%  "
            f"Sharpe {hold['sharpe_net']:.3f}  maxDD {hold['max_drawdown_pct']:.2f}%"
        )
    add("")

    sweep = report["threshold_sweep"]
    add("-- THRESHOLD SWEEP (in-sample choice, shown for shape only) " + "-" * 12)
    add(sweep.to_string(index=False, float_format=lambda v: f"{v:.4f}"))
    add("")

    cal = report["calibration"]
    if not cal.empty:
        add("-- CALIBRATION (are the probabilities honest?) " + "-" * 25)
        add(cal.to_string(index=False, float_format=lambda v: f"{v:.4f}"))
        add("")

    imp = report["importance"]
    if not imp.empty:
        add("-- TOP FEATURES (mean over folds) " + "-" * 38)
        add(imp.head(15).to_string(index=False, float_format=lambda v: f"{v:.4f}"))
        add("")

    if vol_report:
        add("-- VOLATILITY TARGET (next-bar range) " + "-" * 34)
        vm, vb = vol_report["model"], vol_report["persistence_baseline"]
        add(f"model      : R2 = {vm.get('r2', float('nan')):+.4f}   corr = {vm.get('corr', float('nan')):.4f}")
        add(f"persistence: R2 = {vb.get('r2', float('nan')):+.4f}   corr = {vb.get('corr', float('nan')):.4f}")
        add("")

    add("=" * 72)
    add(_verdict(report))
    add("=" * 72)
    return "\n".join(lines)


def _verdict(report: dict) -> str:
    m = report["metrics"]
    t = report["trading"]
    sig = report["significance_vs_coinflip"]
    ts = report["trading_significance"]

    stat_edge = sig["p_value"] < 0.05 and m["accuracy"] > report["baselines"]["majority_class"]
    econ_edge = t["net_return_pct"] > 0 and ts.get("p_value_gt_zero", 1.0) < 0.05

    if econ_edge and stat_edge:
        return (
            "VERDICT: statistically significant AND profitable after costs on this sample.\n"
            "Treat with suspicion anyway: verify on a fresh out-of-sample period, check for\n"
            "data errors, and paper trade before risking capital."
        )
    if stat_edge:
        return (
            "VERDICT: a statistically detectable directional edge, but it does NOT survive\n"
            "trading costs. This is the normal outcome for 15m crypto. The edge is real in\n"
            "the statistical sense and worthless in the economic sense."
        )
    return (
        "VERDICT: no reliable directional edge. Accuracy is within noise of a coin flip.\n"
        "This is the expected and correct result for next-candle direction on liquid BTC.\n"
        "The volatility/range target is where forecastable structure actually lives."
    )


def save_report(report: dict, out_dir: Path, name: str = "report") -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {}

    serialisable = {
        k: v
        for k, v in report.items()
        if k not in {"oos", "calibration", "threshold_sweep", "importance"}
    }
    paths["json"] = out_dir / f"{name}.json"
    paths["json"].write_text(json.dumps(serialisable, indent=2, default=str))

    paths["predictions"] = out_dir / f"{name}_oos_predictions.csv"
    report["oos"].to_csv(paths["predictions"], index=False)

    if not report["importance"].empty:
        paths["importance"] = out_dir / f"{name}_feature_importance.csv"
        report["importance"].to_csv(paths["importance"], index=False)

    return paths
