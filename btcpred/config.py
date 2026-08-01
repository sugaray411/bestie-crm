"""Central configuration objects for the BTC 15m candle prediction system."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
ARTIFACT_DIR = REPO_ROOT / "artifacts"

# 15m bars per year, used to annualise Sharpe ratios.
BARS_PER_YEAR = 365 * 24 * 4


@dataclass
class CostModel:
    """Round-trip trading costs, expressed in basis points (1 bp = 0.01%).

    Defaults model a Binance USDT-M perpetual taker order. Spot taker fees are
    roughly 10 bps per side, which is high enough to erase almost any 15m edge,
    so the futures fee is the more forgiving default.
    """

    fee_bps_per_side: float = 4.0
    slippage_bps_per_side: float = 1.0

    @property
    def per_side_bps(self) -> float:
        return self.fee_bps_per_side + self.slippage_bps_per_side

    @property
    def round_trip_bps(self) -> float:
        return 2.0 * self.per_side_bps

    @property
    def per_side_frac(self) -> float:
        return self.per_side_bps / 10_000.0


@dataclass
class Config:
    """Everything needed to reproduce a run."""

    # --- data ---
    symbol: str = "BTCUSDT"
    interval: str = "15m"
    source: str = "binance"

    # --- prediction target ---
    horizon: int = 1
    # Bars whose forward move is smaller than this are treated as "no trade"
    # when deadband labelling is enabled. 0 disables it.
    deadband_bps: float = 0.0

    # --- walk-forward evaluation ---
    train_min_bars: int = 20_000       # ~7 months of 15m bars before first test
    test_bars: int = 2_000             # ~3 weeks of out-of-sample bars per fold
    step_bars: int = 2_000             # how far the window advances each fold
    embargo_bars: int = 8              # purge gap between train and test
    expanding: bool = True             # expanding vs rolling training window

    # --- model ---
    model: str = "lightgbm"            # lightgbm | hgb | logistic
    calibrate: bool = True
    seed: int = 7

    # --- trading simulation ---
    trade_threshold: float = 0.02      # |p_up - 0.5| needed to take a position
    costs: CostModel = field(default_factory=CostModel)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True)

    @classmethod
    def from_dict(cls, payload: dict) -> "Config":
        payload = dict(payload)
        costs = payload.pop("costs", None)
        cfg = cls(**payload)
        if costs:
            cfg.costs = CostModel(**costs)
        return cfg
