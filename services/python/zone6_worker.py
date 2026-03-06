from __future__ import annotations

import argparse
import json
import random

from common.contracts import Zone6HistoryFeedback


def run(klass: str, stage: str) -> Zone6HistoryFeedback:
    base = 0.62 if klass == "CLASS_A" else 0.38 if klass == "CLASS_C" else 0.5
    stage_adjust = -0.08 if stage == "STAGE_3" else 0.03 if stage == "STAGE_2" else 0
    win_rate = max(0.1, min(0.9, base + stage_adjust + random.uniform(-0.06, 0.06)))

    if klass == "CLASS_A":
        summary = "similar breakout setup found; watch for overheat transition."
    elif klass == "CLASS_C":
        summary = "similar downside dump setup found; bias defensive."
    else:
        summary = "neutral historical cluster; edge unclear."

    return Zone6HistoryFeedback(
        similar_trade_id=f"HIST_{random.randint(10000, 99999)}",
        win_rate=round(win_rate, 2),
        summary=summary,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Zone6 history feedback worker")
    parser.add_argument("--klass", default="CLASS_B")
    parser.add_argument("--stage", default="STAGE_1")
    args = parser.parse_args()

    result = run(args.klass, args.stage)
    print(json.dumps(result.model_dump(), ensure_ascii=False))


if __name__ == "__main__":
    main()

