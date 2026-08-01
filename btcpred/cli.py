"""Command line interface.

    python -m btcpred.cli fetch    --days 720
    python -m btcpred.cli backtest --days 720
    python -m btcpred.cli backtest --synthetic 60000
    python -m btcpred.cli demo
    python -m btcpred.cli train
    python -m btcpred.cli predict
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

from . import pipeline
from .config import ARTIFACT_DIR, DATA_DIR, Config, CostModel
from .data import (
    DataFetchError,
    cache_path,
    download,
    drop_unclosed,
    load_candles,
    synthetic_klines,
    validate_ohlcv,
)


def _config_from_args(args) -> Config:
    cfg = Config(
        symbol=args.symbol,
        interval=args.interval,
        source=args.source,
        horizon=getattr(args, "horizon", 1),
        deadband_bps=getattr(args, "deadband_bps", 0.0),
        train_min_bars=getattr(args, "train_min", 20_000),
        test_bars=getattr(args, "test_bars", 2_000),
        step_bars=getattr(args, "step_bars", 2_000),
        embargo_bars=getattr(args, "embargo", 8),
        expanding=not getattr(args, "rolling", False),
        model=getattr(args, "model", "lightgbm"),
        calibrate=not getattr(args, "no_calibrate", False),
        seed=getattr(args, "seed", 7),
        trade_threshold=getattr(args, "threshold", 0.02),
        costs=CostModel(
            fee_bps_per_side=getattr(args, "fee_bps", 4.0),
            slippage_bps_per_side=getattr(args, "slippage_bps", 1.0),
        ),
    )
    return cfg


def _load_candles(args, cfg: Config) -> pd.DataFrame:
    """Synthetic if requested, else the on-disk cache, else fetch."""
    if getattr(args, "synthetic", None):
        n = int(args.synthetic)
        print(f"generating {n:,} synthetic {cfg.interval} candles "
              f"(signal_strength={args.signal_strength})")
        return synthetic_klines(
            n,
            interval=cfg.interval,
            seed=cfg.seed,
            signal_strength=args.signal_strength,
        )

    path = cache_path(DATA_DIR, cfg.symbol, cfg.interval, cfg.source)
    if path.exists() and not getattr(args, "refresh", False):
        candles = load_candles(path)
        print(f"loaded {len(candles):,} cached candles from {path}")
        return candles

    print(f"fetching {args.days} days of {cfg.symbol} {cfg.interval} from {cfg.source}")
    return download(cfg.symbol, cfg.interval, args.days, cfg.source, DATA_DIR)


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------


def cmd_fetch(args) -> int:
    cfg = _config_from_args(args)
    try:
        candles = download(cfg.symbol, cfg.interval, args.days, cfg.source, DATA_DIR)
    except DataFetchError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print(
            "\nThe exchange endpoint is unreachable. Common causes:\n"
            "  * the network blocks the exchange (sandboxes often do)\n"
            "  * Binance is geo-restricted where you are; try --source bybit or coinbase\n"
            "You can still exercise the whole pipeline offline with:\n"
            "  python -m btcpred.cli backtest --synthetic 60000",
            file=sys.stderr,
        )
        return 1

    info = validate_ohlcv(candles, cfg.interval)
    print(f"saved {info['bars']:,} candles: {info['start']} -> {info['end']}")
    if info["gap_count"]:
        print(f"note: {info['gap_count']} gaps ({info['gap_pct']}% of bars) — exchange downtime")
    return 0


def cmd_backtest(args) -> int:
    cfg = _config_from_args(args)
    candles = _load_candles(args, cfg)
    candles = drop_unclosed(candles)
    info = validate_ohlcv(candles, cfg.interval)
    print(f"candles: {info['bars']:,}  {info['start']} -> {info['end']}  gaps={info['gap_count']}")

    report = pipeline.run_experiment(candles, cfg, verbose=not args.quiet)

    vol_report = None
    if not args.skip_volatility:
        print("running volatility walk-forward...")
        vol_report = pipeline.run_volatility_experiment(candles, cfg, verbose=False)

    print()
    print(pipeline.format_report(report, vol_report))

    if not args.no_save:
        paths = pipeline.save_report(report, ARTIFACT_DIR, name=args.name)
        print("\nartifacts written:")
        for key, path in paths.items():
            print(f"  {key:12s} {path}")
    return 0


def cmd_demo(args) -> int:
    """Positive control: prove the pipeline finds a signal only when one exists.

    Run A has no predictable direction. Any model that scores well above 50%
    there is leaking the future. Run B injects a known edge, so a model that
    cannot find it is broken. Passing both is the evidence that the evaluation
    machinery is trustworthy.
    """
    cfg = _config_from_args(args)
    cfg.train_min_bars = 8_000
    cfg.test_bars = 1_500
    cfg.step_bars = 1_500

    results = {}
    for label, strength in (("A: no signal (null)", 0.0), ("B: injected signal", 0.20)):
        print("\n" + "=" * 72)
        print(f"DEMO RUN {label}   signal_strength={strength}")
        print("=" * 72)
        candles = synthetic_klines(
            args.bars, interval=cfg.interval, seed=cfg.seed, signal_strength=strength
        )
        report = pipeline.run_experiment(candles, cfg, verbose=not args.quiet)
        print()
        print(pipeline.format_report(report))
        results[label] = report["metrics"]["accuracy"]

    print("\n" + "=" * 72)
    print("POSITIVE CONTROL SUMMARY")
    print("=" * 72)
    for label, acc in results.items():
        print(f"  {label:28s} accuracy = {acc:.4f}")
    null_acc = results["A: no signal (null)"]
    signal_acc = results["B: injected signal"]
    print()
    if null_acc < 0.52 and signal_acc > 0.53:
        print("PASS: ~50% on unpredictable data, clearly above 50% when a real edge exists.")
        print("      The evaluation machinery is not leaking and is able to detect signal.")
    else:
        print("FAIL: control did not behave as expected — investigate before trusting results.")
    return 0


def cmd_train(args) -> int:
    cfg = _config_from_args(args)
    candles = _load_candles(args, cfg)
    candles = drop_unclosed(candles)
    validate_ohlcv(candles, cfg.interval)

    model, columns, meta = pipeline.train_final_model(candles, cfg)
    out = Path(args.out) if args.out else ARTIFACT_DIR / "model.joblib"
    pipeline.save_model(model, columns, cfg, out)
    print(f"trained on {len(meta):,} bars, {len(columns)} features")
    print(f"model saved to {out}")
    print(
        "\nReminder: this model is fit on all history including the most recent bars.\n"
        "Its accuracy is NOT the number to trust — only the walk-forward report is."
    )
    return 0


def cmd_predict(args) -> int:
    model_path = Path(args.model) if args.model else ARTIFACT_DIR / "model.joblib"
    if not model_path.exists():
        print(f"ERROR: no model at {model_path}. Run `train` first.", file=sys.stderr)
        return 1

    model, columns, cfg = pipeline.load_model(model_path)

    if args.synthetic:
        candles = synthetic_klines(int(args.synthetic), interval=cfg.interval, seed=cfg.seed + 1)
    else:
        try:
            candles = download(cfg.symbol, cfg.interval, args.days, cfg.source, DATA_DIR)
        except DataFetchError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
    candles = drop_unclosed(candles)

    result = pipeline.predict_next(candles, model, columns)
    print("-" * 60)
    print(f"last closed candle : {result['last_closed_open_time']}")
    print(f"last close         : {result['last_close']:,.2f}")
    print(f"predicting candle  : {result['predicts_bar_starting']} -> {result['predicts_bar_ending']}")
    print(f"P(up)              : {result['p_up']:.4f}")
    print(f"direction          : {result['direction']}")
    print(f"edge over coinflip : {result['confidence_over_coinflip']:.4f}")
    print("-" * 60)
    print("A probability near 0.50 means the model has no opinion. That is the")
    print("normal state for this problem, and acting on it costs fees.")
    return 0


# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="btcpred", description="Predict the next 15m BTC candle, evaluated honestly."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("--symbol", default="BTCUSDT")
        p.add_argument("--interval", default="15m")
        p.add_argument("--source", default="binance", choices=["binance", "bybit", "coinbase"])
        p.add_argument("--days", type=int, default=720, help="days of history to fetch")
        p.add_argument("--seed", type=int, default=7)

    def model_args(p):
        p.add_argument("--model", default="lightgbm", choices=["lightgbm", "hgb", "logistic"])
        p.add_argument("--horizon", type=int, default=1, help="bars ahead to predict")
        p.add_argument("--deadband-bps", type=float, default=0.0, dest="deadband_bps")
        p.add_argument("--train-min", type=int, default=20_000, dest="train_min")
        p.add_argument("--test-bars", type=int, default=2_000, dest="test_bars")
        p.add_argument("--step-bars", type=int, default=2_000, dest="step_bars")
        p.add_argument("--embargo", type=int, default=8)
        p.add_argument("--rolling", action="store_true", help="rolling instead of expanding window")
        p.add_argument("--no-calibrate", action="store_true", dest="no_calibrate")
        p.add_argument("--threshold", type=float, default=0.02)
        p.add_argument("--fee-bps", type=float, default=4.0, dest="fee_bps")
        p.add_argument("--slippage-bps", type=float, default=1.0, dest="slippage_bps")
        p.add_argument("--synthetic", type=int, default=None, metavar="N_BARS")
        p.add_argument("--signal-strength", type=float, default=0.0, dest="signal_strength")

    p_fetch = sub.add_parser("fetch", help="download candles to data/")
    common(p_fetch)
    p_fetch.set_defaults(func=cmd_fetch)

    p_back = sub.add_parser("backtest", help="walk-forward evaluation")
    common(p_back)
    model_args(p_back)
    p_back.add_argument("--refresh", action="store_true", help="re-fetch instead of using cache")
    p_back.add_argument("--skip-volatility", action="store_true")
    p_back.add_argument("--no-save", action="store_true")
    p_back.add_argument("--quiet", action="store_true")
    p_back.add_argument("--name", default="report")
    p_back.set_defaults(func=cmd_backtest)

    p_demo = sub.add_parser("demo", help="offline positive-control demo")
    common(p_demo)
    model_args(p_demo)
    p_demo.add_argument("--bars", type=int, default=30_000)
    p_demo.add_argument("--quiet", action="store_true", default=True)
    p_demo.set_defaults(func=cmd_demo)

    p_train = sub.add_parser("train", help="fit a final model on all history")
    common(p_train)
    model_args(p_train)
    p_train.add_argument("--refresh", action="store_true")
    p_train.add_argument("--out", default=None)
    p_train.set_defaults(func=cmd_train)

    p_pred = sub.add_parser("predict", help="predict the next candle")
    common(p_pred)
    p_pred.add_argument("--model", default=None)
    p_pred.add_argument("--synthetic", type=int, default=None, metavar="N_BARS")
    p_pred.set_defaults(func=cmd_predict)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
