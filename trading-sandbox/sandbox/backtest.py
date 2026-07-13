"""Event-driven backtester with realistic frictions.

Key modelling choices that keep the results honest:

- **No lookahead.** The target position a strategy returns at bar ``i`` is
  executed at bar ``i + 1``'s open. You can never trade on a bar's own close.
- **Fees.** A ``fee`` fraction (e.g. 0.001 = 0.1%) is charged on the traded
  notional every time the position changes.
- **Slippage.** Buys fill slightly above and sells slightly below the open by a
  ``slippage`` fraction, approximating the spread and market impact you really
  pay.

The result is an equity curve plus a list of completed round-trip trades, which
the metrics module turns into the numbers that actually matter.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Sequence

from .data import Candle
from .strategy import Strategy


@dataclass
class Trade:
    entry_time: int
    entry_price: float
    exit_time: int
    exit_price: float
    return_pct: float  # net of fees/slippage, per unit of capital deployed


@dataclass
class BacktestResult:
    equity_curve: List[float] = field(default_factory=list)
    times: List[int] = field(default_factory=list)
    trades: List[Trade] = field(default_factory=list)
    initial_cash: float = 0.0
    final_equity: float = 0.0
    fee: float = 0.0
    slippage: float = 0.0
    strategy_name: str = ""


def run_backtest(
    candles: Sequence[Candle],
    strategy: Strategy,
    initial_cash: float = 10_000.0,
    fee: float = 0.001,
    slippage: float = 0.0005,
) -> BacktestResult:
    """Simulate ``strategy`` over ``candles`` and return the result.

    Positions are long/flat. ``position`` is the fraction of equity currently
    invested (0..1). We size to the target on each bar's open.
    """
    n = len(candles)
    result = BacktestResult(
        initial_cash=initial_cash,
        fee=fee,
        slippage=slippage,
        strategy_name=strategy.name,
    )
    if n == 0:
        return result

    cash = initial_cash
    units = 0.0  # units of the asset held
    position = 0.0  # fraction of equity invested, for reference
    # Open-trade bookkeeping for round-trip stats.
    open_entry_price = 0.0
    open_entry_time = 0
    open_cost_basis = 0.0  # cash actually spent entering (incl. costs)

    warmup = strategy.warmup()

    for i in range(n):
        price_close = candles[i].close
        equity = cash + units * price_close
        result.equity_curve.append(equity)
        result.times.append(candles[i].time)

        # Decide the target for the NEXT bar based on info up to bar i.
        if i < warmup or i + 1 >= n:
            # No execution possible on the final bar (no next open to fill at).
            continue

        target = strategy.target_position(candles, i)
        target = min(1.0, max(0.0, target))

        # Execute at next bar's open.
        exec_price = candles[i + 1].open
        current_equity = cash + units * exec_price
        target_value = target * current_equity
        current_value = units * exec_price
        delta_value = target_value - current_value

        if abs(delta_value) < 1e-9:
            position = target
            continue

        if delta_value > 0:
            # Buying: pay slippage up, fee on notional.
            fill = exec_price * (1 + slippage)
            spend = delta_value
            buy_units = spend / fill
            fee_cost = spend * fee
            cash -= spend + fee_cost
            units += buy_units
            if open_cost_basis == 0.0:
                open_entry_price = fill
                open_entry_time = candles[i + 1].time
            open_cost_basis += spend + fee_cost
        else:
            # Selling: receive slippage down, fee on notional.
            fill = exec_price * (1 - slippage)
            sell_value = -delta_value
            sell_units = min(units, sell_value / fill)
            proceeds = sell_units * fill
            fee_cost = proceeds * fee
            cash += proceeds - fee_cost
            units -= sell_units
            # If we've closed the whole position, record a round-trip.
            if units <= 1e-9 and open_cost_basis > 0:
                gross = proceeds - fee_cost
                ret = (gross - open_cost_basis) / open_cost_basis
                result.trades.append(
                    Trade(
                        entry_time=open_entry_time,
                        entry_price=open_entry_price,
                        exit_time=candles[i + 1].time,
                        exit_price=fill,
                        return_pct=ret,
                    )
                )
                open_cost_basis = 0.0
                units = 0.0
        position = target

    # Mark to market at the last close.
    result.final_equity = cash + units * candles[-1].close
    return result
