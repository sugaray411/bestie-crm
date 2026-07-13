"""Turn an equity curve into the numbers that decide go / no-go.

The point of these is to resist self-deception. A strategy can have a great
total return and still be untradeable because the drawdown would have made you
quit, or because it only "wins" by taking rare catastrophic losses. Always read
max drawdown and the comparison against buy-and-hold, not just total return.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Sequence

from .backtest import BacktestResult


@dataclass
class Metrics:
    total_return_pct: float
    cagr_pct: float
    max_drawdown_pct: float
    sharpe: float
    volatility_pct: float
    num_trades: int
    win_rate_pct: float
    avg_trade_pct: float
    final_equity: float
    periods_per_year: float


def _returns(equity: Sequence[float]) -> List[float]:
    out = []
    for a, b in zip(equity, equity[1:]):
        if a > 0:
            out.append(b / a - 1.0)
    return out


def max_drawdown(equity: Sequence[float]) -> float:
    """Largest peak-to-trough decline as a positive fraction."""
    peak = -math.inf
    worst = 0.0
    for v in equity:
        peak = max(peak, v)
        if peak > 0:
            worst = min(worst, v / peak - 1.0)
    return -worst


def infer_periods_per_year(times: Sequence[int]) -> float:
    """Guess how many bars make up a year from the median bar spacing."""
    if len(times) < 2:
        return 252.0
    gaps = sorted(t2 - t1 for t1, t2 in zip(times, times[1:]) if t2 > t1)
    if not gaps:
        return 252.0
    median_gap = gaps[len(gaps) // 2]
    year = 365.25 * 24 * 3600
    return max(1.0, year / median_gap)


def compute_metrics(result: BacktestResult) -> Metrics:
    equity = result.equity_curve
    if len(equity) < 2:
        return Metrics(0, 0, 0, 0, 0, 0, 0, 0, result.final_equity, 252.0)

    rets = _returns(equity)
    ppy = infer_periods_per_year(result.times)

    total_return = equity[-1] / equity[0] - 1.0

    n_periods = len(rets)
    years = n_periods / ppy if ppy else 0
    if years > 0 and equity[0] > 0 and equity[-1] > 0:
        cagr = (equity[-1] / equity[0]) ** (1 / years) - 1.0
    else:
        cagr = 0.0

    mean = sum(rets) / len(rets) if rets else 0.0
    var = sum((r - mean) ** 2 for r in rets) / len(rets) if rets else 0.0
    std = math.sqrt(var)
    # Annualised Sharpe with a zero risk-free rate — a simplification, stated
    # plainly so nobody mistakes it for a risk-adjusted return net of cash yield.
    sharpe = (mean / std * math.sqrt(ppy)) if std > 0 else 0.0
    vol_annual = std * math.sqrt(ppy)

    wins = [t for t in result.trades if t.return_pct > 0]
    win_rate = (len(wins) / len(result.trades) * 100.0) if result.trades else 0.0
    avg_trade = (
        sum(t.return_pct for t in result.trades) / len(result.trades) * 100.0
        if result.trades
        else 0.0
    )

    return Metrics(
        total_return_pct=total_return * 100,
        cagr_pct=cagr * 100,
        max_drawdown_pct=max_drawdown(equity) * 100,
        sharpe=sharpe,
        volatility_pct=vol_annual * 100,
        num_trades=len(result.trades),
        win_rate_pct=win_rate,
        avg_trade_pct=avg_trade,
        final_equity=equity[-1],
        periods_per_year=ppy,
    )


def format_report(result: BacktestResult, benchmark: Metrics | None = None) -> str:
    m = compute_metrics(result)
    lines = [
        f"Strategy:          {result.strategy_name}",
        f"Fees / slippage:   {result.fee * 100:.3f}% / {result.slippage * 100:.3f}%",
        f"Final equity:      ${m.final_equity:,.2f}  (started ${result.initial_cash:,.2f})",
        f"Total return:      {m.total_return_pct:+.2f}%",
        f"CAGR:              {m.cagr_pct:+.2f}%",
        f"Max drawdown:      -{m.max_drawdown_pct:.2f}%",
        f"Annual volatility: {m.volatility_pct:.2f}%",
        f"Sharpe (rf=0):     {m.sharpe:.2f}",
        f"Round-trip trades: {m.num_trades}",
        f"Win rate:          {m.win_rate_pct:.1f}%",
        f"Avg trade:         {m.avg_trade_pct:+.2f}%",
    ]
    if benchmark is not None:
        edge = m.total_return_pct - benchmark.total_return_pct
        lines.append("")
        lines.append(
            f"Buy & hold return: {benchmark.total_return_pct:+.2f}%  "
            f"(drawdown -{benchmark.max_drawdown_pct:.2f}%)"
        )
        verdict = "BEATS" if edge > 0 else "TRAILS"
        lines.append(f"Edge vs buy&hold:  {edge:+.2f}%  -> strategy {verdict} buy & hold")
    return "\n".join(lines)
