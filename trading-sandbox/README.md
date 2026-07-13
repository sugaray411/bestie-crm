# Trading Strategy Sandbox

A safe place to find out whether a trading strategy is *actually* profitable —
**before** any real money is at risk. Nothing in here places a real order or
touches a brokerage. It backtests strategies on historical data and paper-trades
them forward against live prices with fake money.

Pure Python 3 standard library. No `pip install`, no API keys to get started.

## Read this first (the honest part)

You asked for "something that trades for me while I sleep." This is the
responsible way to pursue that, and it comes with facts you should hear up front:

- **Most retail trading bots lose money.** A bot doesn't remove market risk; it
  just executes without hesitation, so a bad idea loses money faster.
- **No strategy earns money every single day.** Anything that appears to is
  either curve-fit to the past or quietly stacking hidden risk that eventually
  blows up. Judge a strategy by its **max drawdown** and its edge over
  buy-and-hold, never by a good week.
- **Backtests flatter.** Real fills, fees, and slippage are worse than any
  simulation. This sandbox models fees and slippage precisely so it lies to you
  *less* — but it still can't fully capture reality.
- **This is not financial advice.** It's an engineering tool for learning. The
  responsible path is: backtest → paper-trade for weeks → only then consider
  real money you can afford to lose entirely.

## The workflow

```
1. Backtest      Does the strategy beat buy-and-hold on real historical data,
                 after fees and slippage?           -> most ideas die here
2. Paper trade   Run it forward on LIVE prices with fake money for weeks.
                 Does it hold up out-of-sample?      -> most survivors die here
3. Decide        Only what survives both, and only with risk capital, and only
                 you — the sandbox will not do this step for you.
```

## Quick start (works offline, on synthetic data)

```bash
cd trading-sandbox

# Run the tests
python3 tests/test_sandbox.py

# Backtest the moving-average crossover strategy (falls back to fake data)
python3 -m sandbox.cli backtest --strategy sma --fast 20 --slow 50

# Backtest the RSI mean-reversion strategy
python3 -m sandbox.cli backtest --strategy rsi

# Paper-trade forward, 5 simulated polls, offline
python3 -m sandbox.cli paper --strategy sma --iterations 5 --poll 0
```

## Using real market data (run on your own machine)

The public exchange APIs are blocked inside the locked-down build environment,
but work fine from your laptop:

```bash
# Real Bitcoin daily candles from Coinbase (no API key)
python3 -m sandbox.cli backtest --strategy sma --source coinbase --symbol BTC-USD --granularity 86400

# Real data from Binance
python3 -m sandbox.cli backtest --strategy rsi --source binance --symbol BTCUSDT --interval 1d

# Or load a CSV you already have (columns: time,open,high,low,close,volume)
python3 -m sandbox.cli backtest --csv mydata.csv

# Paper trade live, polling Coinbase hourly
python3 -m sandbox.cli paper --strategy sma --source coinbase --symbol BTC-USD --granularity 3600 --poll 3600
```

## What's inside

| Module | Purpose |
|---|---|
| `sandbox/data.py` | Candle type; synthetic, CSV, Coinbase and Binance loaders |
| `sandbox/indicators.py` | SMA, EMA, RSI — carefully aligned to avoid lookahead |
| `sandbox/strategy.py` | `Strategy` base class + BuyAndHold, SmaCrossover, RsiReversion |
| `sandbox/backtest.py` | Event-driven backtester with fees, slippage, no lookahead |
| `sandbox/metrics.py` | Total return, CAGR, max drawdown, Sharpe, win rate, vs benchmark |
| `sandbox/paper.py` | Forward paper trading with a persistent virtual portfolio |
| `sandbox/cli.py` | `python -m sandbox.cli backtest\|paper ...` |
| `tests/` | Offline, deterministic test suite |

## Writing your own strategy

Subclass `Strategy` and return a target position in `[0, 1]` (0 = all cash,
1 = fully invested). You may only look at `candles[: i + 1]` — never the future.

```python
from sandbox.strategy import Strategy

class MyStrategy(Strategy):
    name = "my_idea"

    def target_position(self, candles, i):
        # e.g. go long only after three straight up days
        if i < 3:
            return 0.0
        closes = [c.close for c in candles[i-3 : i+1]]
        rising = closes[1] > closes[0] and closes[2] > closes[1] and closes[3] > closes[2]
        return 1.0 if rising else 0.0

    def warmup(self):
        return 3
```

Then backtest it from a short script:

```python
from sandbox.data import fetch_coinbase           # or synthetic_candles / load_csv
from sandbox.backtest import run_backtest
from sandbox.metrics import compute_metrics, format_report
from sandbox.strategy import BuyAndHold

candles = fetch_coinbase("BTC-USD", 86400)
result = run_backtest(candles, MyStrategy())
bench = compute_metrics(run_backtest(candles, BuyAndHold()))
print(format_report(result, bench))
```

## Going live (deliberately not automated)

There is no "flip to real money" switch, on purpose. To trade for real you would
replace `PaperTrader._simulate_fill` with real order placement through a broker
API (e.g. Alpaca for US stocks, or an exchange's authenticated API for crypto)
and add real risk controls: position limits, a hard daily loss cap, and a kill
switch. Do that only after weeks of paper results you trust, and only with money
you can afford to lose. That step is yours to take with eyes open — the sandbox
will help you decide, but it won't decide for you.
