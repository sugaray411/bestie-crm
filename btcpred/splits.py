"""Walk-forward splitting with purging and embargo.

Random k-fold cross-validation is invalid for time series and is the most
common reason a backtest looks profitable and live trading does not. Two
distinct problems:

1. **Temporal leakage.** Training on bars that come after the test bars lets the
   model learn from the future.
2. **Label overlap.** The label for bar ``t`` is built from bars up to
   ``t+horizon``. A training bar sitting within ``horizon`` of the test window
   shares data with it, so it leaks even when it precedes the test set.

The splitter below trains only on the past, and purges the ``horizon +
embargo`` bars immediately before each test window to break the overlap.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

import numpy as np


@dataclass(frozen=True)
class Fold:
    index: int
    train_start: int
    train_end: int   # exclusive, already purged
    test_start: int
    test_end: int    # exclusive

    @property
    def n_train(self) -> int:
        return self.train_end - self.train_start

    @property
    def n_test(self) -> int:
        return self.test_end - self.test_start


def walk_forward_folds(
    n_samples: int,
    train_min: int,
    test_size: int,
    step: int,
    horizon: int = 1,
    embargo: int = 0,
    expanding: bool = True,
) -> list[Fold]:
    """Generate chronologically ordered folds.

    ``expanding=True`` grows the training set each fold (uses all history).
    ``expanding=False`` slides a fixed-width window of ``train_min`` bars, which
    adapts faster to regime change at the cost of less data.
    """
    if train_min < 1 or test_size < 1 or step < 1:
        raise ValueError("train_min, test_size and step must all be >= 1")

    purge = max(horizon - 1, 0) + max(embargo, 0)
    folds: list[Fold] = []
    test_start = train_min + purge
    fold_index = 0

    while test_start + test_size <= n_samples:
        train_end = test_start - purge
        train_start = 0 if expanding else max(0, train_end - train_min)
        if train_end - train_start >= train_min or (not expanding and train_end > train_start):
            folds.append(
                Fold(
                    index=fold_index,
                    train_start=train_start,
                    train_end=train_end,
                    test_start=test_start,
                    test_end=test_start + test_size,
                )
            )
            fold_index += 1
        test_start += step

    return folds


def fold_arrays(fold: Fold) -> tuple[np.ndarray, np.ndarray]:
    train_idx = np.arange(fold.train_start, fold.train_end)
    test_idx = np.arange(fold.test_start, fold.test_end)
    return train_idx, test_idx


def describe_folds(folds: list[Fold]) -> str:
    if not folds:
        return "no folds (not enough data for the configured window sizes)"
    lines = [f"{len(folds)} walk-forward folds"]
    first, last = folds[0], folds[-1]
    lines.append(
        f"  fold 0: train[{first.train_start}:{first.train_end}] "
        f"test[{first.test_start}:{first.test_end}]"
    )
    lines.append(
        f"  fold {last.index}: train[{last.train_start}:{last.train_end}] "
        f"test[{last.test_start}:{last.test_end}]"
    )
    total_test = sum(f.n_test for f in folds)
    lines.append(f"  total out-of-sample bars: {total_test}")
    return "\n".join(lines)
