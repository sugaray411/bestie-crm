"""Paper trading: run a strategy forward against live prices with fake money.

This is the bridge between backtesting and (maybe, someday) real trading. It
keeps a persistent virtual portfolio in a JSON file and, each time you poll,
fetches the latest candles, asks the strategy for a target, and simulates the
resulting order with the same fees/slippage model as the backtester.

It never connects to a brokerage and never places a real order. To go from here
to live trading you would replace ``_simulate_fill`` with real order placement
— which you should only do after weeks of paper results you trust, and with
money you can afford to lose.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from typing import Callable, List, Sequence

from .data import Candle
from .strategy import Strategy


@dataclass
class PaperPortfolio:
    cash: float
    units: float
    initial_cash: float
    last_price: float = 0.0
    history: List[dict] = None  # list of {time, action, price, units, equity}

    def __post_init__(self):
        if self.history is None:
            self.history = []

    @property
    def equity(self) -> float:
        return self.cash + self.units * self.last_price


class PaperTrader:
    def __init__(
        self,
        strategy: Strategy,
        state_path: str,
        initial_cash: float = 10_000.0,
        fee: float = 0.001,
        slippage: float = 0.0005,
    ):
        self.strategy = strategy
        self.state_path = state_path
        self.fee = fee
        self.slippage = slippage
        self.portfolio = self._load(initial_cash)

    def _load(self, initial_cash: float) -> PaperPortfolio:
        if os.path.exists(self.state_path):
            with open(self.state_path) as fh:
                data = json.load(fh)
            return PaperPortfolio(**data)
        return PaperPortfolio(cash=initial_cash, units=0.0, initial_cash=initial_cash)

    def save(self) -> None:
        with open(self.state_path, "w") as fh:
            json.dump(asdict(self.portfolio), fh, indent=2)

    def step(self, candles: Sequence[Candle]) -> dict:
        """Process the latest candles once. Returns a summary of what happened.

        ``candles`` should be recent history ending at the most recent closed
        bar. The strategy decides on the last bar; we fill at that bar's close
        (live paper trading has no "next open" to wait for).
        """
        if not candles:
            return {"action": "none", "reason": "no data"}
        i = len(candles) - 1
        price = candles[i].close
        self.portfolio.last_price = price

        if i < self.strategy.warmup():
            self.save()
            return {"action": "warmup", "price": price, "equity": self.portfolio.equity}

        target = min(1.0, max(0.0, self.strategy.target_position(candles, i)))
        summary = self._simulate_fill(target, price, candles[i].time)
        self.save()
        return summary

    def _simulate_fill(self, target: float, price: float, time: int) -> dict:
        equity = self.portfolio.cash + self.portfolio.units * price
        target_value = target * equity
        current_value = self.portfolio.units * price
        delta = target_value - current_value

        action = "hold"
        if delta > 1e-6:
            fill = price * (1 + self.slippage)
            spend = delta
            buy_units = spend / fill
            fee_cost = spend * self.fee
            self.portfolio.cash -= spend + fee_cost
            self.portfolio.units += buy_units
            action = "buy"
        elif delta < -1e-6:
            fill = price * (1 - self.slippage)
            sell_value = -delta
            sell_units = min(self.portfolio.units, sell_value / fill)
            proceeds = sell_units * fill
            fee_cost = proceeds * self.fee
            self.portfolio.cash += proceeds - fee_cost
            self.portfolio.units -= sell_units
            action = "sell"

        self.portfolio.last_price = price
        entry = {
            "time": time,
            "action": action,
            "price": price,
            "units": self.portfolio.units,
            "equity": self.portfolio.equity,
        }
        if action != "hold":
            self.portfolio.history.append(entry)
        return entry


def run_paper_loop(
    strategy: Strategy,
    fetch: Callable[[], Sequence[Candle]],
    state_path: str,
    poll_seconds: int = 3600,
    max_iterations: int | None = None,
) -> None:
    """Poll ``fetch`` forever (or ``max_iterations`` times), stepping each time.

    ``fetch`` is any callable returning recent candles — e.g.
    ``lambda: fetch_coinbase("BTC-USD", 3600)``. Kept injectable so the loop is
    testable offline with synthetic data.
    """
    import time as _time

    trader = PaperTrader(strategy, state_path)
    it = 0
    while max_iterations is None or it < max_iterations:
        candles = list(fetch())
        summary = trader.step(candles)
        print(
            f"[{it}] {summary.get('action'):>6}  "
            f"price={summary.get('price', 0):.2f}  "
            f"equity={trader.portfolio.equity:.2f}"
        )
        it += 1
        if max_iterations is not None and it >= max_iterations:
            break
        _time.sleep(poll_seconds)
