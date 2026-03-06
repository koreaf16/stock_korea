from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import oracledb
import pandas as pd


RAW_DAILY_DIR = Path(os.getenv("ZONE3_RAW_DAILY_DIR", "data/zone3/raw/daily"))
RAW_MINUTE_DIR = Path(os.getenv("ZONE3_RAW_MINUTE_DIR", "data/zone3/raw/minutes"))
MACRO_DIM = max(64, int(os.getenv("ZONE3_MACRO_DIM", "256")))
MICRO_DIM = max(64, int(os.getenv("ZONE3_MICRO_DIM", "256")))


@dataclass
class MatchResult:
    pattern_id: str
    symbol: str
    event_ts: str
    event_type: str
    macro_similarity: float
    micro_similarity: float
    future_ret_1d: float | None


def read_oracle_env() -> tuple[str, str, str]:
    user = os.getenv("ORACLE_USER", "").strip()
    password = os.getenv("ORACLE_PASSWORD", "").strip()
    connect_string = os.getenv("ORACLE_CONNECTION_STRING", "").strip()
    if not user or not password or not connect_string:
        raise RuntimeError("ORACLE_USER / ORACLE_PASSWORD / ORACLE_CONNECTION_STRING required")
    return user, password, connect_string


def normalize(series: np.ndarray) -> np.ndarray:
    s_min = float(np.min(series))
    s_max = float(np.max(series))
    if math.isclose(s_min, s_max, rel_tol=1e-12, abs_tol=1e-12):
        return np.zeros_like(series, dtype=np.float32)
    return ((series - s_min) / (s_max - s_min)).astype(np.float32)


def resample(values: np.ndarray, dim: int) -> np.ndarray:
    if values.size == 0:
        return np.zeros(dim, dtype=np.float32)
    if values.size == dim:
        return values.astype(np.float32)
    x_old = np.linspace(0.0, 1.0, num=values.size, dtype=np.float32)
    x_new = np.linspace(0.0, 1.0, num=dim, dtype=np.float32)
    return np.interp(x_new, x_old, values.astype(np.float32)).astype(np.float32)


def load_daily_df(symbol: str) -> pd.DataFrame:
    path = RAW_DAILY_DIR / f"{symbol}.csv"
    if not path.exists():
        raise FileNotFoundError(f"daily csv not found: {path}")
    df = pd.read_csv(path)
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df.dropna(subset=["Date"]).sort_values("Date").reset_index(drop=True)
    for col in ("Open", "High", "Low", "Close", "Volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
    return df


def load_minute_df(symbol: str) -> pd.DataFrame:
    path = RAW_MINUTE_DIR / f"{symbol}.csv"
    if not path.exists():
        raise FileNotFoundError(f"minute csv not found: {path}")
    df = pd.read_csv(path)
    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    df = df.dropna(subset=["timestamp"]).sort_values("timestamp").reset_index(drop=True)
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
    return df


def vectorize_macro(daily_df: pd.DataFrame, asof_date: pd.Timestamp, dim: int = MACRO_DIM) -> list[float]:
    df = daily_df[daily_df["Date"] <= asof_date].copy()
    if len(df) < 10:
        return [0.0] * dim
    df = df.tail(61).reset_index(drop=True)
    rets = (df["Close"].pct_change().fillna(0.0).to_numpy(dtype=np.float32))[1:]
    vols = df["Volume"].to_numpy(dtype=np.float32)[1:]
    feature = np.concatenate([normalize(rets), normalize(vols)], axis=0)
    vec = resample(feature, dim)
    return vec.tolist()


def vectorize_micro(minute_df: pd.DataFrame, asof_date: pd.Timestamp, dim: int = MICRO_DIM) -> list[float]:
    day_df = minute_df[minute_df["timestamp"].dt.date == asof_date.date()].copy()
    if day_df.empty:
        day_df = minute_df.tail(120).copy()
    if day_df.empty:
        return [0.0] * dim

    window = day_df.tail(30)
    close = normalize(window["close"].to_numpy(dtype=np.float32))
    high = normalize(window["high"].to_numpy(dtype=np.float32))
    low = normalize(window["low"].to_numpy(dtype=np.float32))
    vol = normalize(window["volume"].to_numpy(dtype=np.float32))
    feature = np.concatenate([close, high, low, vol], axis=0)
    vec = resample(feature, dim)
    return vec.tolist()


def query_hybrid_matches(
    *,
    macro_vector: list[float],
    micro_vector: list[float],
    macro_top_k: int,
    micro_top_k: int,
    micro_similarity_threshold: float,
) -> list[MatchResult]:
    user, password, connect_string = read_oracle_env()

    macro_vec_text = "[" + ",".join(f"{float(v):.8f}" for v in macro_vector) + "]"
    micro_vec_text = "[" + ",".join(f"{float(v):.8f}" for v in micro_vector) + "]"

    sql = """
        with macro_candidates as (
            select
                t.pattern_id,
                t.symbol,
                t.event_ts,
                t.event_type,
                t.future_ret_1d,
                t.micro_vector,
                (1 - vector_distance(t.macro_vector, to_vector(:macro_vec), COSINE)) as macro_sim
            from TB_ZONE3_PATTERN_LIBRARY t
            order by vector_distance(t.macro_vector, to_vector(:macro_vec), COSINE)
            fetch first :macro_top_k rows only
        )
        select
            pattern_id,
            symbol,
            event_ts,
            event_type,
            macro_sim,
            (1 - vector_distance(micro_vector, to_vector(:micro_vec), COSINE)) as micro_sim,
            future_ret_1d
        from macro_candidates
        where (1 - vector_distance(micro_vector, to_vector(:micro_vec), COSINE)) >= :micro_threshold
        order by micro_sim desc
        fetch first :micro_top_k rows only
    """

    out: list[MatchResult] = []
    with oracledb.connect(user=user, password=password, dsn=connect_string) as conn:
        with conn.cursor() as cur:
            cur.execute(
                sql,
                macro_vec=macro_vec_text,
                micro_vec=micro_vec_text,
                macro_top_k=macro_top_k,
                micro_top_k=micro_top_k,
                micro_threshold=micro_similarity_threshold,
            )
            for row in cur:
                out.append(
                    MatchResult(
                        pattern_id=str(row[0]),
                        symbol=str(row[1]),
                        event_ts=str(row[2]),
                        event_type=str(row[3]),
                        macro_similarity=float(row[4]),
                        micro_similarity=float(row[5]),
                        future_ret_1d=float(row[6]) if row[6] is not None else None,
                    )
                )
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Zone3 hybrid macro-micro matcher")
    parser.add_argument("--symbol", required=True, help="Target symbol (e.g. 005930)")
    parser.add_argument("--asof-date", default="", help="YYYY-MM-DD (default: latest daily row)")
    parser.add_argument("--macro-top-k", type=int, default=500)
    parser.add_argument("--micro-top-k", type=int, default=3)
    parser.add_argument("--micro-threshold", type=float, default=0.90)
    args = parser.parse_args()

    symbol = str(args.symbol).strip().upper()
    daily_df = load_daily_df(symbol)
    minute_df = load_minute_df(symbol)

    if args.asof_date:
        asof = pd.to_datetime(args.asof_date, errors="coerce")
        if pd.isna(asof):
            raise RuntimeError(f"invalid --asof-date: {args.asof_date}")
    else:
        asof = pd.to_datetime(daily_df.iloc[-1]["Date"])

    macro_vec = vectorize_macro(daily_df, asof, dim=MACRO_DIM)
    micro_vec = vectorize_micro(minute_df, asof, dim=MICRO_DIM)

    matches = query_hybrid_matches(
        macro_vector=macro_vec,
        micro_vector=micro_vec,
        macro_top_k=max(10, args.macro_top_k),
        micro_top_k=max(1, args.micro_top_k),
        micro_similarity_threshold=max(0.0, min(1.0, args.micro_threshold)),
    )

    payload: dict[str, Any] = {
        "symbol": symbol,
        "asof_date": asof.strftime("%Y-%m-%d"),
        "macro_dim": MACRO_DIM,
        "micro_dim": MICRO_DIM,
        "top_k": args.micro_top_k,
        "matches": [
            {
                "pattern_id": m.pattern_id,
                "symbol": m.symbol,
                "event_ts": m.event_ts,
                "event_type": m.event_type,
                "macro_similarity": m.macro_similarity,
                "micro_similarity": m.micro_similarity,
                "future_ret_1d": m.future_ret_1d,
            }
            for m in matches
        ],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
