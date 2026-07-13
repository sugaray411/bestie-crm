"""Command-line entry point: ``python -m sandbox.cli ...``

Subcommands:
  backtest   Run a strategy over historical or synthetic data and print a report.
  paper      Paper-trade a strategy forward against live prices (needs internet).

Run with no data source and it falls back to synthetic data so you can try it
anywhere, including offline.
"""

from __future__ import annotations

import argparse
import sys
from typing import List

from . import data as datamod
from .backtest import run_backtest
from .metrics import compute_metrics, format_report
from .strategy import BuyAndHold, RsiReversion, SmaCrossover, Strategy


def _build_strategy(name: str, args: argparse.Namespace) -> Strategy:
    if name == "sma":
        return SmaCrossover(fast=args.fast, slow=args.slow)
    if name == "rsi":
        return RsiReversion(period=args.rsi_period, low=args.rsi_low, high=args.rsi_high)
    if name == "hold":
        return BuyAndHold()
    raise SystemExit(f"unknown strategy: {name}")


def _load_candles(args: argparse.Namespace) -> List[datamod.Candle]:
    if args.csv:
        return datamod.load_csv(args.csv)
    if args.source == "coinbase":
        return datamod.fetch_coinbase(args.symbol, args.granularity)
    if args.source == "binance":
        return datamod.fetch_binance(args.symbol, args.interval, args.limit)
    # Default: synthetic, works offline.
    return datamod.synthetic_candles(n=args.synthetic_n, seed=args.seed)


def cmd_backtest(args: argparse.Namespace) -> int:
    candles = _load_candles(args)
    if len(candles) < 10:
        print("Not enough candles to backtest.", file=sys.stderr)
        return 1

    strategy = _build_strategy(args.strategy, args)
    result = run_backtest(
        candles,
        strategy,
        initial_cash=args.cash,
        fee=args.fee,
        slippage=args.slippage,
    )

    bench = run_backtest(candles, BuyAndHold(), initial_cash=args.cash, fee=args.fee, slippage=args.slippage)
    print(format_report(result, compute_metrics(bench)))

    if args.source == "synthetic" and not args.csv:
        print(
            "\nNote: this ran on SYNTHETIC (fake) data. Results mean nothing about\n"
            "real markets. Point --source at coinbase/binance or --csv at real data\n"
            "on your own machine.",
            file=sys.stderr,
        )
    return 0


def cmd_paper(args: argparse.Namespace) -> int:
    from .paper import run_paper_loop

    strategy = _build_strategy(args.strategy, args)

    if args.source == "coinbase":
        fetch = lambda: datamod.fetch_coinbase(args.symbol, args.granularity)
    elif args.source == "binance":
        fetch = lambda: datamod.fetch_binance(args.symbol, args.interval, args.limit)
    else:
        # Offline demo: replay synthetic data, growing the window each poll.
        full = datamod.synthetic_candles(n=args.synthetic_n, seed=args.seed)
        state = {"k": strategy.warmup() + 1}

        def fetch():
            k = min(state["k"], len(full))
            state["k"] += 1
            return full[:k]

    run_paper_loop(
        strategy,
        fetch,
        state_path=args.state,
        poll_seconds=args.poll,
        max_iterations=args.iterations,
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="sandbox", description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    def add_common(sp):
        sp.add_argument("--strategy", default="sma", choices=["sma", "rsi", "hold"])
        sp.add_argument("--fast", type=int, default=20)
        sp.add_argument("--slow", type=int, default=50)
        sp.add_argument("--rsi-period", type=int, default=14)
        sp.add_argument("--rsi-low", type=float, default=30.0)
        sp.add_argument("--rsi-high", type=float, default=55.0)
        sp.add_argument("--source", default="synthetic", choices=["synthetic", "coinbase", "binance"])
        sp.add_argument("--symbol", default="BTC-USD")
        sp.add_argument("--granularity", type=int, default=86400, help="coinbase, seconds")
        sp.add_argument("--interval", default="1d", help="binance interval")
        sp.add_argument("--limit", type=int, default=500, help="binance candle count")
        sp.add_argument("--csv", default=None, help="load candles from a CSV file")
        sp.add_argument("--synthetic-n", type=int, default=500)
        sp.add_argument("--seed", type=int, default=42)
        sp.add_argument("--cash", type=float, default=10_000.0)
        sp.add_argument("--fee", type=float, default=0.001)
        sp.add_argument("--slippage", type=float, default=0.0005)

    bt = sub.add_parser("backtest", help="backtest a strategy")
    add_common(bt)
    bt.set_defaults(func=cmd_backtest)

    pa = sub.add_parser("paper", help="paper-trade forward")
    add_common(pa)
    pa.add_argument("--state", default="paper_state.json")
    pa.add_argument("--poll", type=int, default=3600, help="seconds between polls")
    pa.add_argument("--iterations", type=int, default=None, help="stop after N polls")
    pa.set_defaults(func=cmd_paper)

    return p


def main(argv: List[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
