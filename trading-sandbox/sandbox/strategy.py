"""Strategy interface and a couple of example strategies.

A strategy looks at candles up to *and including* index ``i`` and returns a
target position for the *next* bar as a fraction of equity in [0, 1]:

    0.0  -> flat (all cash)
    1.0  -> fully long

Long/flat only — no shorting or leverage. That is a deliberate safety choice:
shorting and leverage can lose more than you put in, and this sandbox is for
learning whether an edge exists at all.

The golden rule enforced by convention here: a strategy may only read
``candles[: i + 1]``. Reading ``candles[i + 1]`` would be peeking at the future
and is the single most common way backtests lie. The backtester also applies
the returned target on the *following* bar's open, so even a perfectly-timed
signal cannot trade on information it could not have had.
"""

from __future__ import annotations

from typing import List, Sequence

from .data import Candle
from .indicators import rsi, sma


class Strategy:
    """Base class. Subclass and implement :meth:`target_position`."""

    name = "base"

    def target_position(self, candles: Sequence[Candle], i: int) -> float:
        """Return desired position in [0, 1] given history up to index ``i``."""
        raise NotImplementedError

    def warmup(self) -> int:
        """Bars of history needed before signals are meaningful."""
        return 0


class BuyAndHold(Strategy):
    """The benchmark every strategy must beat to be worth the risk."""

    name = "buy_and_hold"

    def target_position(self, candles: Sequence[Candle], i: int) -> float:
        return 1.0


class SmaCrossover(Strategy):
    """Long when the fast SMA is above the slow SMA, else flat."""

    def __init__(self, fast: int = 20, slow: int = 50):
        if fast >= slow:
            raise ValueError("fast period must be shorter than slow period")
        self.fast = fast
        self.slow = slow
        self.name = f"sma_crossover({fast},{slow})"
        self._closes: List[float] = []
        self._fast: List = []
        self._slow: List = []
        self._computed_len = -1

    def _ensure(self, candles: Sequence[Candle]) -> None:
        # Recompute indicators only when the series length changes.
        if len(candles) != self._computed_len:
            self._closes = [c.close for c in candles]
            self._fast = sma(self._closes, self.fast)
            self._slow = sma(self._closes, self.slow)
            self._computed_len = len(candles)

    def target_position(self, candles: Sequence[Candle], i: int) -> float:
        self._ensure(candles)
        f = self._fast[i]
        s = self._slow[i]
        if f is None or s is None:
            return 0.0
        return 1.0 if f > s else 0.0

    def warmup(self) -> int:
        return self.slow


class RsiReversion(Strategy):
    """Buy when oversold (RSI < ``low``), sell out when RSI recovers past ``high``."""

    def __init__(self, period: int = 14, low: float = 30.0, high: float = 55.0):
        self.period = period
        self.low = low
        self.high = high
        self.name = f"rsi_reversion({period},{low:g},{high:g})"
        self._rsi: List = []
        self._computed_len = -1
        self._held = False

    def _ensure(self, candles: Sequence[Candle]) -> None:
        if len(candles) != self._computed_len:
            self._rsi = rsi([c.close for c in candles], self.period)
            self._computed_len = len(candles)

    def target_position(self, candles: Sequence[Candle], i: int) -> float:
        self._ensure(candles)
        r = self._rsi[i]
        if r is None:
            return 0.0
        if not self._held and r < self.low:
            self._held = True
        elif self._held and r > self.high:
            self._held = False
        return 1.0 if self._held else 0.0

    def warmup(self) -> int:
        return self.period + 1
