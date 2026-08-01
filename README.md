# btcpred — predicting the next 15m BTC candle

A complete, honest system for forecasting the next 15-minute Bitcoin candle:
data ingestion, causal feature engineering, walk-forward evaluation, cost-aware
backtesting, and live prediction.

**Read this before you read the code.** The hard part of this problem is not
building a model. It is building an evaluation you can trust. Almost every
"90% accurate BTC predictor" you will find online is measuring itself wrong, in
one of four specific ways this project is designed to prevent.

---

## What to actually expect

| Target | Question | Realistically achievable |
|---|---|---|
| **Direction** | Will the next candle close up or down? | **50–52%.** Anything above ~53% out-of-sample on liquid BTC is almost certainly a bug. |
| **Return** | How much will it move, signed? | Barely better than predicting zero. |
| **Range / volatility** | How *big* will the next candle be? | **Genuinely predictable.** R² of 0.2–0.5 is normal and real. |

That table is the single most important thing in this repository. Direction at a
15-minute horizon on the most liquid crypto market in the world is close to a
coin flip, because if it were not, someone with faster infrastructure than yours
would have already traded it away. Volatility, on the other hand, clusters
strongly and is forecastable — which is why the professional version of this
question is usually about sizing and risk, not about calling the next candle.

There is also a second bar to clear after statistical significance: **cost**. A
15m BTC candle moves ~20–30 bps on average, while a round-trip taker trade costs
~10 bps. A model that is right 52% of the time still loses money. The backtester
here charges every position change, so net numbers are the ones it reports.

---

## Quickstart

```bash
pip install -r requirements.txt

# Offline: prove the evaluation machinery works, no network needed
python -m btcpred.cli demo

# With real data
python -m btcpred.cli fetch    --days 720
python -m btcpred.cli backtest --days 720
python -m btcpred.cli train
python -m btcpred.cli predict
```

`demo` runs a **positive/negative control pair** on synthetic data and takes
about a minute:

```
A: no signal (null)          accuracy = 0.4980
B: injected signal           accuracy = 0.5612

PASS: ~50% on unpredictable data, clearly above 50% when a real edge exists.
```

Run A is data with genuinely no predictable direction — scoring well above 50%
there would prove the pipeline is leaking. Run B has a known edge injected —
failing to find it would prove the pipeline cannot detect signal, which would
make run A's 50% meaningless. **Passing both is the evidence that the numbers
this system reports about real data can be believed.**

### Note on network access

The exchange REST endpoints (Binance, Bybit, Coinbase) are blocked in many
sandboxes and CI environments, and Binance is geo-restricted in some countries.
If `fetch` fails, either run it on your own machine, try `--source bybit` /
`--source coinbase`, or use `--synthetic N` to exercise everything offline.

---

## The four ways this problem is usually got wrong

**1. Lookahead bias.** Using information that would not have existed at decision
time — a centred rolling window, a `bfill`, a scaler fit on the whole dataset,
or the still-forming candle at the right edge of the tape.

*Prevented by:* every feature is causal by construction, the unclosed candle is
dropped at ingest, and scaling happens inside the walk-forward loop. This is
enforced empirically, not by inspection — `tests/test_no_lookahead.py` checks
**prefix invariance**: the feature row at bar `t` must be identical whether the
dataset ends at bar `t` or continues for another thousand bars. A second test
violently rewrites all future candles and asserts no past feature moves.

**2. Random cross-validation.** Shuffling time series into random folds trains
the model on the future and tests it on the past.

*Prevented by:* `splits.py` only ever trains on data preceding the test window.
It also **purges** the `horizon + embargo` bars immediately before each test
window, because the label for bar `t` is built from bar `t+1`, so a training bar
sitting right against the boundary shares data with the test set even though it
precedes it.

**3. Ignoring costs.** Reporting gross returns, or assuming you trade at the
mid price.

*Prevented by:* `backtest.py` charges fees plus slippage on every position
change; flipping long to short costs two sides. Defaults model a Binance
USDT-M taker (4 bps fee + 1 bp slippage per side). Spot taker fees near 10 bps
per side will erase essentially any 15m edge — try `--fee-bps 10` and watch.

**4. No baseline.** "52% accuracy" means nothing next to a market that closed up
52% of the time.

*Prevented by:* every report shows always-up, majority-class, persistence and
mean-reversion baselines, buy-and-hold, an exact binomial test against chance,
and a bootstrap confidence interval on per-bar PnL.

**A fifth trap appears once you use `--horizon > 1`:** consecutive labels then
cover overlapping price windows. Two things go wrong if you ignore that. The
significance test treats correlated observations as independent and reports a
tiny p-value for nothing, and the backtester books the same price move
`horizon` times over. Both are corrected — the binomial test uses an effective
sample size of `n / horizon`, and the simulator thins positions to
non-overlapping windows. On signal-free synthetic data at `--horizon 4`, the
uncorrected code claimed +31% net return at p ≈ 0; corrected, it reports +0.6%
with p = 0.20, which is the truth.

---

## Layout

```
btcpred/
  config.py     Config + CostModel (fees, slippage, walk-forward geometry)
  data.py       Exchange fetchers, CSV cache, validation, synthetic generator
  features.py   ~69 strictly causal features
  labels.py     Forward targets: direction, return, range; dataset assembly
  splits.py     Walk-forward folds with purging and embargo
  models.py     LightGBM / HistGradientBoosting / logistic, chronological calibration
  evaluate.py   Metrics, baselines, binomial + bootstrap significance, calibration
  backtest.py   Out-of-sample walk-forward loop, cost-aware trading simulation
  pipeline.py   Orchestration, reporting, model persistence, live prediction
  cli.py        fetch / backtest / demo / train / predict
tests/
  test_no_lookahead.py   Prefix invariance, label alignment, split correctness
  test_pipeline.py       Controls, simulator behaviour, metric sanity
```

### Features

All derived from OHLCV plus taker-buy volume, all causal:

- **Returns** — log returns over 1–96 bars, individual lagged bar returns, z-scores
- **Volatility** — realised vol over several windows, Parkinson and Garman-Klass
  range estimators, ATR, short/long vol ratios (regime)
- **Candle shape** — body and wick fractions, close location value, gaps, range z-score
- **Order flow** — taker buy/sell imbalance and its moving averages. On Binance
  this is real aggressor-side information and one of the few features with an
  actual economic story behind it
- **Technicals** — RSI, MACD histogram, Bollinger %b, distance from moving
  averages in units of volatility, position in recent range, signed streaks
- **Time** — cyclical encodings of time-of-day and day-of-week (crypto has a
  real intraday volatility profile tied to US and Asia session hours)

Adding more indicators is the least valuable thing you can do to this system.
They are near-linear combinations of what is already here, and every one you add
raises the chance of finding something that works by luck.

---

## CLI

```bash
# Data
python -m btcpred.cli fetch --days 720 --source binance --symbol BTCUSDT

# Evaluation (the only numbers worth trusting)
python -m btcpred.cli backtest --days 720
python -m btcpred.cli backtest --model logistic          # simpler baseline
python -m btcpred.cli backtest --rolling                 # rolling not expanding window
python -m btcpred.cli backtest --fee-bps 10              # spot taker fees
python -m btcpred.cli backtest --deadband-bps 12         # ignore moves too small to trade
python -m btcpred.cli backtest --horizon 4               # predict 1 hour ahead instead
python -m btcpred.cli backtest --synthetic 60000         # fully offline
```

Live use:

```bash
python -m btcpred.cli train
python -m btcpred.cli predict
```

Key knobs: `--train-min` (bars before the first test fold), `--test-bars` and
`--step-bars` (fold geometry), `--embargo` (purge gap), `--threshold`
(how confident before taking a position).

---

## Reading a report

```
accuracy            : 0.5612
  vs always-up      : 0.5011
  vs persistence    : 0.5733          <-- beaten by a free strategy: bad sign
AUC                 : 0.5897
binomial vs 50%     : p = 1.07e-55    <-- statistically real
per-fold accuracy   : 0.5612 +/- 0.0160 (100% of folds > 50%)
...
gross return        : +483.73%
costs paid          : 644.30%         <-- this is the whole story
NET return          : -160.57%
```

Work down in this order:

1. **Per-fold consistency.** One great fold and five bad ones is noise. You want
   most folds above 50%, with low spread.
2. **Baselines.** If persistence beats the model, the model has learned nothing
   that a one-line rule does not already capture.
3. **Significance.** With 15,000 out-of-sample bars, 51% can be significant;
   with 500 bars, 55% is not.
4. **Net return and its bootstrap CI.** Gross return is marketing. If the 95% CI
   on per-bar PnL straddles zero, you do not have a strategy.
5. **Calibration.** If bars where the model says 60% only come in at 52%, the
   probabilities are not usable for sizing even if the direction call is fine.

The report ends with a plain-language verdict that distinguishes "no edge" from
"real edge that costs eat" — they are different findings with different
responses.

---

## If you want to push this further

In rough order of expected value:

1. **Trade the volatility target instead.** It is the part that actually works.
   Predicted range feeds position sizing, stop placement and options strategies.
   `run_volatility_experiment` already scores it against a persistence baseline.
2. **Get better data.** Order book depth and imbalance, trade-by-trade flow,
   liquidations, funding rates, open interest. Nearly all remaining short-horizon
   signal lives in microstructure that 15m OHLCV bars have already averaged away.
3. **Predict something more tradeable.** "Up or down in 15 minutes" is a poor
   target. Triple-barrier labels (first touch of a profit target, a stop, or a
   time limit) match how a trade actually resolves. `--deadband-bps` is a first
   step in that direction.
4. **Model the regime.** Edges appear in specific conditions — high volatility,
   thin liquidity, particular sessions — and vanish in others. A model that
   knows when to abstain beats one that always has an opinion.
5. **Longer horizons.** Signal-to-noise improves as the horizon lengthens and
   costs amortise over a larger expected move. Try `--horizon 4` or `--horizon 96`.

---

## Limitations, stated plainly

- Backtested on one asset and one venue. Cross-validating across symbols and
  exchanges would catch overfitting this design cannot.
- Costs are modelled as a constant. Real slippage widens exactly when you most
  want to trade.
- Assumes your order fills at the next candle's open with no market impact.
  True for retail size, false as size grows.
- No funding rates, so perpetual-futures PnL is optimistic.
- Every parameter choice in this repo — feature windows, model
  hyperparameters, thresholds — is a researcher degree of freedom. The more
  configurations you try, the more likely the best one is luck. The threshold
  sweep is printed to show the *shape* of the trade-off, not to be mined for
  the best number.

**This is a research tool, not trading advice.** A walk-forward backtest is the
weakest possible evidence that something will make money in the future. Paper
trade first, in real time, for longer than feels necessary.

---

## Tests

```bash
pytest tests/ -q                    # everything
pytest tests/ -q -m "not slow"      # fast subset
```

24 tests. The ones that matter most are the prefix-invariance checks in
`test_no_lookahead.py` and the control pair in `test_pipeline.py`. If you change
anything in `features.py`, run them — they exist to catch the failure mode that
would otherwise make this whole system quietly worthless.
