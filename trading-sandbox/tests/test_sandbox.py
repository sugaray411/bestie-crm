"""Offline tests. No network, deterministic. Run: python -m pytest, or just
``python tests/test_sandbox.py`` which self-runs without pytest installed.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sandbox.backtest import run_backtest
from sandbox.data import Candle, save_csv, load_csv, synthetic_candles
from sandbox.indicators import sma, ema, rsi
from sandbox.metrics import compute_metrics, max_drawdown
from sandbox.paper import PaperTrader
from sandbox.strategy import BuyAndHold, RsiReversion, SmaCrossover


def test_sma_alignment():
    vals = [1, 2, 3, 4, 5]
    out = sma(vals, 3)
    assert out[:2] == [None, None]
    assert out[2] == 2.0  # (1+2+3)/3
    assert out[4] == 4.0  # (3+4+5)/3


def test_ema_basic():
    out = ema([1, 2, 3, 4, 5], 3)
    assert out[0] is None and out[1] is None
    assert out[2] == 2.0  # seeded with SMA of first 3
    assert out[3] is not None and out[3] > 2.0


def test_rsi_bounds():
    rising = list(range(1, 40))
    out = rsi(rising, 14)
    assert out[14] is not None
    assert 0 <= out[-1] <= 100
    assert out[-1] > 90  # steadily rising -> high RSI


def test_max_drawdown():
    assert abs(max_drawdown([100, 120, 60, 90]) - 0.5) < 1e-9  # 120 -> 60 = -50%
    assert max_drawdown([100, 110, 120]) == 0.0


def test_backtest_runs_and_conserves_sanity():
    candles = synthetic_candles(n=300, seed=1)
    res = run_backtest(candles, SmaCrossover(10, 30), initial_cash=10_000)
    assert len(res.equity_curve) == len(candles)
    assert res.final_equity > 0
    # Equity should never go negative (long/flot only, no leverage).
    assert all(e > 0 for e in res.equity_curve)


def test_buy_and_hold_matches_price_move():
    candles = synthetic_candles(n=200, seed=7)
    res = run_backtest(candles, BuyAndHold(), initial_cash=10_000, fee=0.0, slippage=0.0)
    # With no fees, buy&hold return should track the underlying price return.
    price_move = candles[-1].close / candles[1].open - 1.0
    bh_move = res.final_equity / 10_000 - 1.0
    assert abs(price_move - bh_move) < 0.02


def test_fees_reduce_return():
    candles = synthetic_candles(n=300, seed=3)
    cheap = run_backtest(candles, SmaCrossover(5, 20), fee=0.0, slippage=0.0)
    pricey = run_backtest(candles, SmaCrossover(5, 20), fee=0.01, slippage=0.01)
    assert pricey.final_equity < cheap.final_equity


def test_no_lookahead_flat_strategy_never_trades():
    # A strategy that always returns 0 must end with exactly the initial cash.
    from sandbox.strategy import Strategy

    class AlwaysFlat(Strategy):
        name = "flat"

        def target_position(self, candles, i):
            return 0.0

    candles = synthetic_candles(n=100, seed=5)
    res = run_backtest(candles, AlwaysFlat(), initial_cash=10_000)
    assert abs(res.final_equity - 10_000) < 1e-6
    assert res.trades == []


def test_metrics_shape():
    candles = synthetic_candles(n=400, seed=9)
    res = run_backtest(candles, SmaCrossover(10, 40))
    m = compute_metrics(res)
    assert m.max_drawdown_pct >= 0
    assert -100 <= m.total_return_pct
    assert m.num_trades >= 0


def test_csv_roundtrip(tmp_path=None):
    import tempfile

    candles = synthetic_candles(n=20, seed=2)
    d = tempfile.mkdtemp()
    path = os.path.join(d, "c.csv")
    save_csv(candles, path)
    loaded = load_csv(path)
    assert len(loaded) == len(candles)
    assert abs(loaded[0].close - candles[0].close) < 1e-6


def test_paper_trader_persists(tmp_path=None):
    import tempfile

    d = tempfile.mkdtemp()
    state = os.path.join(d, "state.json")
    candles = synthetic_candles(n=60, seed=4)
    t1 = PaperTrader(SmaCrossover(5, 15), state_path=state, initial_cash=10_000)
    t1.step(candles)
    assert os.path.exists(state)
    # Reload and confirm state survived.
    t2 = PaperTrader(SmaCrossover(5, 15), state_path=state, initial_cash=10_000)
    assert abs(t2.portfolio.equity - t1.portfolio.equity) < 1.0


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        fn()
        print(f"  ok  {fn.__name__}")
        passed += 1
    print(f"\n{passed}/{len(fns)} tests passed")


if __name__ == "__main__":
    _run_all()
