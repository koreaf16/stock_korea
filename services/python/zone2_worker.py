from __future__ import annotations

import argparse
import json

from common.contracts import Zone2Fundamental

ISSUE_MAP = {
    "cb_bw": "최근 3개월 내 CB/BW/유상증자 이력",
    "krx": "KRX 투자경고/투자위험/관리종목 지정",
    "capital": "완전자본잠식 또는 재무 불건전성 신호",
}


def parse_bool(raw: str) -> bool:
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def symbol_hash(symbol: str) -> int:
    h = 7
    for ch in symbol:
        h = (h * 31 + ord(ch)) % 1_000_003
    return h


def run(symbol: str, has_cb_bw: bool | None, has_krx: bool | None, has_capital: bool | None) -> Zone2Fundamental:
    # If explicit flags are absent, derive deterministic mock flags from symbol hash.
    hashed = symbol_hash(symbol)
    cb_bw = has_cb_bw if has_cb_bw is not None else (hashed % 23 == 0)
    krx = has_krx if has_krx is not None else (hashed % 29 == 0)
    capital = has_capital if has_capital is not None else (hashed % 31 == 0)

    issues: list[str] = []
    if cb_bw:
        issues.append(ISSUE_MAP["cb_bw"])
    if krx:
        issues.append(ISSUE_MAP["krx"])
    if capital:
        issues.append(ISSUE_MAP["capital"])

    blocked = len(issues) > 0
    return Zone2Fundamental(
        symbol=symbol,
        risk_flag="BLOCKED" if blocked else "CLEAR",
        issues=issues,
        has_cb_bw_issue=cb_bw,
        has_krx_warning=krx,
        has_capital_impairment=capital,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Zone2 fundamental risk worker")
    parser.add_argument("--symbol", default="005930")
    parser.add_argument("--has-cb-bw", default="")
    parser.add_argument("--has-krx-warning", default="")
    parser.add_argument("--has-capital-impairment", default="")
    args = parser.parse_args()

    cb_bw = parse_bool(args.has_cb_bw) if args.has_cb_bw != "" else None
    krx = parse_bool(args.has_krx_warning) if args.has_krx_warning != "" else None
    capital = parse_bool(args.has_capital_impairment) if args.has_capital_impairment != "" else None

    result = run(args.symbol, cb_bw, krx, capital)
    print(json.dumps(result.model_dump(), ensure_ascii=False))


if __name__ == "__main__":
    main()
