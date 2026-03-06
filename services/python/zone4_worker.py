from __future__ import annotations

import argparse
import json

from common.contracts import Zone4Madness


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def symbol_hash(symbol: str) -> int:
    h = 13
    for ch in symbol:
        h = (h * 41 + ord(ch)) % 1_000_003
    return h


def run(
    symbol: str,
    spike_ratio: float,
    volume_power: float,
    similarity: float,
    sentiment: float,
    news_velocity: float,
    local_score: float,
) -> Zone4Madness:
    h = symbol_hash(symbol)
    hash_bias = ((h % 17) - 8) * 0.22

    raw = (
        spike_ratio * 0.18
        + volume_power * 0.24
        + similarity * 30.0
        + abs(sentiment) * 16.0
        + news_velocity * 0.21
        + local_score * 0.28
        + hash_bias
    )
    score = clamp(raw, 0.0, 100.0)
    stage = "STAGE_3" if score >= 75 else "STAGE_2" if score >= 55 else "STAGE_1"
    return Zone4Madness(
        score=round(score, 2),
        stage=stage,
        sentiment=round(clamp(sentiment, -1.0, 1.0), 2),
        news_velocity=round(clamp(news_velocity, 0.0, 100.0), 2),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Zone4 madness scoring worker")
    parser.add_argument("--symbol", default="005930")
    parser.add_argument("--spike-ratio", type=float, default=120.0)
    parser.add_argument("--volume-power", type=float, default=100.0)
    parser.add_argument("--similarity", type=float, default=0.72)
    parser.add_argument("--sentiment", type=float, default=0.0)
    parser.add_argument("--news-velocity", type=float, default=0.0)
    parser.add_argument("--local-score", type=float, default=50.0)
    args = parser.parse_args()

    result = run(
        args.symbol,
        args.spike_ratio,
        args.volume_power,
        args.similarity,
        args.sentiment,
        args.news_velocity,
        args.local_score,
    )
    print(json.dumps(result.model_dump(), ensure_ascii=False))


if __name__ == "__main__":
    main()
