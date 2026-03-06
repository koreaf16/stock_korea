from __future__ import annotations

import argparse
import json

from common.contracts import Zone3PatternMatch


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def symbol_hash(symbol: str) -> int:
    h = 17
    for ch in symbol:
        h = (h * 37 + ord(ch)) % 1_000_003
    return h


def run(symbol: str, spike_ratio: float, volume_power: float, local_similarity: float) -> Zone3PatternMatch:
    # Deterministic scoring that keeps output stable for same input.
    h = symbol_hash(symbol)
    hash_bias = ((h % 101) - 50) / 1000.0

    score_a = (
        (spike_ratio / 320.0) * 0.55
        + (volume_power / 160.0) * 0.35
        + local_similarity * 0.20
        + hash_bias
    )
    score_c = (
        max(0.0, (120.0 - spike_ratio) / 120.0) * 0.50
        + max(0.0, (100.0 - volume_power) / 100.0) * 0.35
        + (1.0 - local_similarity) * 0.20
        - hash_bias
    )

    if score_a >= max(score_c, 0.62):
        klass = "CLASS_A"
        base_similarity = 0.76 + score_a * 0.18
    elif score_c >= max(score_a, 0.6):
        klass = "CLASS_C"
        base_similarity = 0.74 + score_c * 0.17
    else:
        klass = "CLASS_B"
        center = 1.0 - abs(score_a - score_c)
        base_similarity = 0.56 + center * 0.12

    return Zone3PatternMatch(
        klass=klass,
        similarity=round(clamp(base_similarity, 0.0, 0.99), 2),
        matched_pattern_id=f"{klass}_{symbol}_{h % 10000:04d}",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Zone3 vector matching worker")
    parser.add_argument("--symbol", default="005930")
    parser.add_argument("--spike-ratio", type=float, default=120.0)
    parser.add_argument("--volume-power", type=float, default=100.0)
    parser.add_argument("--local-similarity", type=float, default=0.5)
    args = parser.parse_args()

    result = run(args.symbol, args.spike_ratio, args.volume_power, args.local_similarity)
    print(json.dumps(result.model_dump(), ensure_ascii=False))


if __name__ == "__main__":
    main()
