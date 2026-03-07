from __future__ import annotations

import argparse
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast
from urllib.error import URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None  # type: ignore[assignment]

try:
    import oracledb  # type: ignore
except Exception:  # pragma: no cover
    oracledb = None

try:
    import torch
except Exception:  # pragma: no cover
    torch = None  # type: ignore[assignment]

try:
    from sentence_transformers import SentenceTransformer
except Exception:  # pragma: no cover
    SentenceTransformer = None  # type: ignore[assignment]


ZONE_DIMS: dict[str, int] = {
    "z1": 128,
    "z2": 256,
    "z3": 512,
    "z4": 768,
}

ZONE_MODEL_ENV: dict[str, str] = {
    "z1": "INTEGRATED_MINER_Z1_MODEL",
    "z2": "INTEGRATED_MINER_Z2_MODEL",
    "z3": "INTEGRATED_MINER_Z3_MODEL",
    "z4": "INTEGRATED_MINER_Z4_MODEL",
}

ZONE_MODEL_DEFAULT: dict[str, str] = {
    "z1": "sentence-transformers/all-MiniLM-L6-v2",
    "z2": "intfloat/multilingual-e5-base",
    "z3": "sentence-transformers/paraphrase-multilingual-mpnet-base-v2",
    "z4": "sentence-transformers/paraphrase-multilingual-mpnet-base-v2",
}

ZONE_PROJECTION_SEED: dict[str, int] = {
    "z1": 1001,
    "z2": 2003,
    "z3": 3007,
    "z4": 4001,
}

Z4_TEXT_DIM = 700
Z4_NUMERIC_DIM = 68
Z4_TEXT_PROJECTION_SEED = 4401
Z4_NUMERIC_PROJECTION_SEED = 4403


def read_oracle_env() -> tuple[str, str, str]:
    user = os.getenv("ORACLE_USER", "").strip()
    password = os.getenv("ORACLE_PASSWORD", "").strip()
    connect_string = os.getenv("ORACLE_CONNECTION_STRING", "").strip()
    if not user or not password or not connect_string:
        raise RuntimeError("ORACLE_USER / ORACLE_PASSWORD / ORACLE_CONNECTION_STRING required")
    return user, password, connect_string


def parse_event_ts(raw: str) -> datetime | None:
    text = raw.strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(db_timezone()).replace(tzinfo=None)


def now_utc_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def format_ts(dt: datetime) -> str:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=db_timezone()).isoformat()
    return dt.astimezone(db_timezone()).isoformat()


def db_timezone() -> ZoneInfo:
    name = os.getenv("INTEGRATED_MINER_DB_TIMEZONE", "Asia/Seoul").strip() or "Asia/Seoul"
    return ZoneInfo(name)


def normalize_l2(vec: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vec))
    if not math.isfinite(norm) or norm <= 0:
        return np.zeros_like(vec, dtype=np.float32)
    return (vec / norm).astype(np.float32)


def to_oracle_vector_text(values: list[float]) -> str:
    return "[" + ",".join(f"{float(v):.8f}" for v in values) + "]"


def lob_to_text(value: Any) -> str:
    if value is None:
        return ""
    reader = getattr(value, "read", None)
    if callable(reader):
        try:
            return str(reader())
        except Exception:
            return str(value)
    return str(value)


@dataclass
class TriggerInput:
    symbol: str
    event_ts: datetime
    profit_rate: float | None


class GpuEmbeddingStation:
    def __init__(self, *, allow_cpu_fallback: bool, skip_gpu_name_check: bool) -> None:
        if np is None:
            raise RuntimeError("numpy is required. Run: pip install numpy")
        if torch is None or SentenceTransformer is None:
            raise RuntimeError(
                "torch and sentence-transformers are required for Integrated Miner. "
                "Run: pip install torch sentence-transformers transformers"
            )

        self._np = cast(Any, np)
        self._torch = cast(Any, torch)
        self._projection_cache: dict[tuple[int, int, int], np.ndarray] = {}

        self.device = self._resolve_device(allow_cpu_fallback)
        self.device_name = self._resolve_device_name()
        self._validate_gpu_name(skip_gpu_name_check=skip_gpu_name_check)
        self.models = self._load_models()
        self._warmup_models()

    def _resolve_device(self, allow_cpu_fallback: bool) -> str:
        preferred = os.getenv("INTEGRATED_MINER_DEVICE", "cuda:0").strip()
        if self._torch.cuda.is_available():
            return preferred
        if allow_cpu_fallback:
            return "cpu"
        raise RuntimeError("CUDA is not available. RTX 3090 환경에서 실행하거나 --allow-cpu-fallback 사용")

    def _resolve_device_name(self) -> str:
        if self.device.startswith("cuda") and self._torch.cuda.is_available():
            index = int(self.device.split(":")[1]) if ":" in self.device else 0
            return str(self._torch.cuda.get_device_name(index))
        return "CPU"

    def _validate_gpu_name(self, *, skip_gpu_name_check: bool) -> None:
        if skip_gpu_name_check or not self.device.startswith("cuda"):
            return

        required = os.getenv("INTEGRATED_MINER_REQUIRED_GPU", "3090").strip().lower()
        if required and required not in self.device_name.lower():
            raise RuntimeError(
                f"GPU 검증 실패: required='{required}', actual='{self.device_name}'. "
                "필요 시 --skip-gpu-name-check 사용"
            )

    def _load_models(self) -> dict[str, Any]:
        models: dict[str, Any] = {}
        for zone in ("z1", "z2", "z3", "z4"):
            model_name = os.getenv(ZONE_MODEL_ENV[zone], ZONE_MODEL_DEFAULT[zone]).strip()
            if not model_name:
                raise RuntimeError(f"{ZONE_MODEL_ENV[zone]} is empty")
            models[zone] = SentenceTransformer(model_name, device=self.device)
        return models

    def _warmup_models(self) -> None:
        warmup_text = "integrated miner gpu warmup"
        for zone, model in self.models.items():
            _ = model.encode(
                [warmup_text],
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=False,
                batch_size=1,
            )
            if self.device.startswith("cuda"):
                self._torch.cuda.synchronize()

    def _projection_matrix(self, in_dim: int, out_dim: int, seed: int) -> np.ndarray:
        key = (in_dim, out_dim, seed)
        cached = self._projection_cache.get(key)
        if cached is not None:
            return cached

        rng = self._np.random.default_rng(seed)
        matrix = rng.standard_normal((in_dim, out_dim), dtype=self._np.float32) / math.sqrt(float(out_dim))
        self._projection_cache[key] = matrix.astype(self._np.float32)
        return self._projection_cache[key]

    def _fit_dim(self, zone: str, vector: np.ndarray) -> np.ndarray:
        target_dim = ZONE_DIMS[zone]
        return self._fit_raw_dim(vector.astype(np.float32), target_dim, ZONE_PROJECTION_SEED[zone])

    def _fit_raw_dim(self, vector: np.ndarray, target_dim: int, seed: int) -> np.ndarray:
        in_dim = int(vector.shape[0])
        if in_dim == target_dim:
            return normalize_l2(vector.astype(np.float32))

        proj = self._projection_matrix(in_dim, target_dim, seed)
        fitted = cast(np.ndarray, vector.astype(np.float32) @ proj)
        return normalize_l2(fitted.astype(np.float32))

    def embed_zone(self, zone: str, text: str) -> list[float]:
        model = self.models[zone]
        raw = model.encode(
            [text],
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
            batch_size=1,
        )
        arr = cast(np.ndarray, raw[0]).astype(np.float32).reshape(-1)
        fitted = self._fit_dim(zone, arr)
        return [float(v) for v in fitted.tolist()]

    def embed_zone4_hybrid(self, text: str, numeric_features: list[float]) -> list[float]:
        model = self.models["z4"]
        raw = model.encode(
            [text],
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
            batch_size=1,
        )
        text_arr = cast(np.ndarray, raw[0]).astype(np.float32).reshape(-1)
        text_700 = self._fit_raw_dim(text_arr, Z4_TEXT_DIM, Z4_TEXT_PROJECTION_SEED)
        numeric_68 = fit_numeric_features(numeric_features)
        combined = self._np.concatenate([text_700, numeric_68]).astype(self._np.float32)
        normalized = normalize_l2(combined)
        return [float(v) for v in normalized.tolist()]


def fit_numeric_features(features: list[float]) -> np.ndarray:
    arr = np.asarray(features, dtype=np.float32).reshape(-1)
    if arr.shape[0] == Z4_NUMERIC_DIM:
        return normalize_l2(arr.astype(np.float32))

    in_dim = int(arr.shape[0])
    if in_dim <= 0:
        return np.zeros((Z4_NUMERIC_DIM,), dtype=np.float32)

    rng = np.random.default_rng(Z4_NUMERIC_PROJECTION_SEED)
    matrix = rng.standard_normal((in_dim, Z4_NUMERIC_DIM), dtype=np.float32) / math.sqrt(float(Z4_NUMERIC_DIM))
    projected = cast(np.ndarray, arr @ matrix)
    return normalize_l2(projected.astype(np.float32))


def resolve_trigger(conn: Any, symbol: str, event_ts: datetime | None) -> TriggerInput:
    clean_symbol = symbol.strip().upper()
    if not clean_symbol:
        raise RuntimeError("symbol is empty")

    if event_ts is not None:
        return TriggerInput(symbol=clean_symbol, event_ts=event_ts, profit_rate=None)

    with conn.cursor() as cursor:
        cursor.execute(
            """
            select max(event_ts)
            from TB_ZONE1_TICK_RAW
            where symbol = :symbol
            """,
            {"symbol": clean_symbol},
        )
        row = cursor.fetchone()
    latest = row[0] if row else None
    if latest is None:
        raise RuntimeError(f"TB_ZONE1_TICK_RAW에서 symbol={clean_symbol} 최신 event_ts를 찾지 못했습니다.")
    return TriggerInput(symbol=clean_symbol, event_ts=latest, profit_rate=None)


def fetch_zone1_raw(
    conn: Any,
    *,
    symbol: str,
    event_ts: datetime,
    lookback_sec: int,
    max_rows: int,
) -> list[dict[str, Any]]:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            select event_ts, last_price, trade_volume, acc_trade_value, bid_price_1, ask_price_1
            from (
                select event_ts, last_price, trade_volume, acc_trade_value, bid_price_1, ask_price_1
                from TB_ZONE1_TICK_RAW
                where symbol = :symbol
                  and event_ts <= :event_ts
                  and event_ts >= (:event_ts - numtodsinterval(:lookback_sec, 'SECOND'))
                order by event_ts desc
            )
            where rownum <= :max_rows
            order by event_ts asc
            """,
            {
                "symbol": symbol,
                "event_ts": event_ts,
                "lookback_sec": int(max(1, lookback_sec)),
                "max_rows": int(max(1, max_rows)),
            },
        )
        rows = cursor.fetchall()

    out: list[dict[str, Any]] = []
    for row in rows:
        out.append(
            {
                "event_ts": row[0],
                "last_price": float(row[1]) if row[1] is not None else 0.0,
                "trade_volume": float(row[2]) if row[2] is not None else 0.0,
                "acc_trade_value": float(row[3]) if row[3] is not None else 0.0,
                "bid_price_1": float(row[4]) if row[4] is not None else 0.0,
                "ask_price_1": float(row[5]) if row[5] is not None else 0.0,
            }
        )
    return out


def fetch_zone2_row(conn: Any, *, symbol: str) -> dict[str, Any] | None:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            select risk_flag, issues_json, has_cb_bw_issue, has_krx_warning, has_capital_impairment, checked_at
            from TB_ZONE2_FUNDAMENTAL
            where symbol = :symbol
            """,
            {"symbol": symbol},
        )
        row = cursor.fetchone()
    if not row:
        return None
    return {
        "risk_flag": str(row[0]) if row[0] is not None else "UNKNOWN",
        "issues_json": lob_to_text(row[1]) if row[1] is not None else "[]",
        "has_cb_bw_issue": int(row[2]) if row[2] is not None else 0,
        "has_krx_warning": int(row[3]) if row[3] is not None else 0,
        "has_capital_impairment": int(row[4]) if row[4] is not None else 0,
        "checked_at": row[5],
    }


def fetch_zone3_raw(
    conn: Any,
    *,
    symbol: str,
    event_ts: datetime,
    lookback_min: int,
    max_rows: int,
) -> list[dict[str, Any]]:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            select candle_ts, open_price, high_price, low_price, close_price, volume, notional
            from (
                select candle_ts, open_price, high_price, low_price, close_price, volume, notional
                from TB_ZONE3_CANDLE_RAW
                where symbol = :symbol
                  and candle_ts <= :event_ts
                  and candle_ts >= (:event_ts - numtodsinterval(:lookback_min, 'MINUTE'))
                order by candle_ts desc
            )
            where rownum <= :max_rows
            order by candle_ts asc
            """,
            {
                "symbol": symbol,
                "event_ts": event_ts,
                "lookback_min": int(max(1, lookback_min)),
                "max_rows": int(max(1, max_rows)),
            },
        )
        rows = cursor.fetchall()

    out: list[dict[str, Any]] = []
    for row in rows:
        out.append(
            {
                "candle_ts": row[0],
                "open_price": float(row[1]) if row[1] is not None else 0.0,
                "high_price": float(row[2]) if row[2] is not None else 0.0,
                "low_price": float(row[3]) if row[3] is not None else 0.0,
                "close_price": float(row[4]) if row[4] is not None else 0.0,
                "volume": float(row[5]) if row[5] is not None else 0.0,
                "notional": float(row[6]) if row[6] is not None else 0.0,
            }
        )
    return out


def fetch_zone4_raw(
    conn: Any,
    *,
    symbol: str,
    event_ts: datetime,
    lookback_min: int,
    max_rows: int,
) -> list[dict[str, Any]]:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            select
              news_ts,
              source,
              source_class,
              source_score,
              headline,
              body_text,
              sentiment_score,
              keywords_json,
              keyword_strength,
              reaction_latency_ms,
              tempo_label,
              sector_coupling_idx,
              llm_potential_score,
              shock_score
            from (
                select
                  news_ts,
                  source,
                  source_class,
                  source_score,
                  headline,
                  body_text,
                  sentiment_score,
                  keywords_json,
                  keyword_strength,
                  reaction_latency_ms,
                  tempo_label,
                  sector_coupling_idx,
                  llm_potential_score,
                  shock_score
                from TB_ZONE4_NEWS_RAW
                where news_ts <= :event_ts
                  and news_ts >= (:event_ts - numtodsinterval(:lookback_min, 'MINUTE'))
                  and (symbol = :symbol or symbol is null)
                order by news_ts desc
            )
            where rownum <= :max_rows
            order by news_ts asc
            """,
            {
                "symbol": symbol,
                "event_ts": event_ts,
                "lookback_min": int(max(1, lookback_min)),
                "max_rows": int(max(1, max_rows)),
            },
        )
        rows = cursor.fetchall()

    out: list[dict[str, Any]] = []
    for row in rows:
        body = lob_to_text(row[5]) if row[5] is not None else ""
        raw_keywords = lob_to_text(row[7]) if row[7] is not None else "[]"
        out.append(
            {
                "news_ts": row[0],
                "source": str(row[1]) if row[1] is not None else "UNKNOWN",
                "source_class": str(row[2]) if row[2] is not None else "UNKNOWN",
                "source_score": float(row[3]) if row[3] is not None else 0.0,
                "headline": str(row[4]) if row[4] is not None else "",
                "body_text": body[:900],
                "sentiment_score": float(row[6]) if row[6] is not None else 0.0,
                "keywords_json": raw_keywords[:4000],
                "keyword_strength": float(row[8]) if row[8] is not None else 0.0,
                "reaction_latency_ms": float(row[9]) if row[9] is not None else None,
                "tempo_label": str(row[10]) if row[10] is not None else "NO_SPIKE",
                "sector_coupling_idx": float(row[11]) if row[11] is not None else 0.0,
                "llm_potential_score": float(row[12]) if row[12] is not None else 0.0,
                "shock_score": float(row[13]) if row[13] is not None else 0.0,
            }
        )
    return out


def build_zone1_text(symbol: str, event_ts: datetime, rows: list[dict[str, Any]]) -> str:
    if not rows:
        return f"symbol={symbol} event_ts={format_ts(event_ts)} zone1_ticks=0"

    prices = [float(r["last_price"]) for r in rows]
    volumes = [float(r["trade_volume"]) for r in rows]
    spreads = [max(0.0, float(r["ask_price_1"]) - float(r["bid_price_1"])) for r in rows]
    last_price = prices[-1]
    first_price = prices[0]
    ret = ((last_price - first_price) / first_price) if first_price > 0 else 0.0
    vol_sum = float(sum(volumes))
    spread_avg = float(sum(spreads) / len(spreads))
    samples = rows[-8:]
    path = " | ".join(
        f"{str(s['event_ts'])[-8:]} p={s['last_price']:.4f} v={s['trade_volume']:.3f} spr={max(0.0, s['ask_price_1']-s['bid_price_1']):.4f}"
        for s in samples
    )
    return (
        f"symbol={symbol}\n"
        f"event_ts={format_ts(event_ts)}\n"
        f"zone=1 tick_count={len(rows)}\n"
        f"price_first={first_price:.4f} price_last={last_price:.4f} return={ret:.6f}\n"
        f"volume_sum={vol_sum:.3f} spread_avg={spread_avg:.6f}\n"
        f"path={path}"
    )


def build_zone2_text(symbol: str, row: dict[str, Any] | None) -> str:
    if row is None:
        return f"symbol={symbol} zone=2 fundamental_missing=true"
    issues_text = str(row.get("issues_json", "[]"))
    return (
        f"symbol={symbol}\n"
        f"zone=2 risk_flag={row.get('risk_flag', 'UNKNOWN')}\n"
        f"has_cb_bw_issue={row.get('has_cb_bw_issue', 0)}\n"
        f"has_krx_warning={row.get('has_krx_warning', 0)}\n"
        f"has_capital_impairment={row.get('has_capital_impairment', 0)}\n"
        f"issues_json={issues_text[:2000]}"
    )


def build_zone3_text(symbol: str, event_ts: datetime, rows: list[dict[str, Any]]) -> str:
    if not rows:
        return f"symbol={symbol} event_ts={format_ts(event_ts)} zone3_candles=0"

    closes = [float(r["close_price"]) for r in rows]
    highs = [float(r["high_price"]) for r in rows]
    lows = [float(r["low_price"]) for r in rows]
    vols = [float(r["volume"]) for r in rows]
    last_close = closes[-1]
    first_close = closes[0]
    ret = ((last_close - first_close) / first_close) if first_close > 0 else 0.0
    volatility = float(max(highs) - min(lows))
    vol_sum = float(sum(vols))
    samples = rows[-12:]
    shape = " | ".join(
        f"{str(s['candle_ts'])[-8:]} o={s['open_price']:.4f} h={s['high_price']:.4f} l={s['low_price']:.4f} c={s['close_price']:.4f} v={s['volume']:.3f}"
        for s in samples
    )
    return (
        f"symbol={symbol}\n"
        f"event_ts={format_ts(event_ts)}\n"
        f"zone=3 candle_count={len(rows)}\n"
        f"close_first={first_close:.4f} close_last={last_close:.4f} return={ret:.6f}\n"
        f"range_abs={volatility:.6f} volume_sum={vol_sum:.3f}\n"
        f"shape={shape}"
    )


def build_zone4_text(symbol: str, event_ts: datetime, rows: list[dict[str, Any]]) -> str:
    if not rows:
        return f"symbol={symbol} event_ts={format_ts(event_ts)} zone4_news=0"

    sentiment_avg = sum(float(r["sentiment_score"]) for r in rows) / max(1, len(rows))
    snippets = []
    for row in rows[:20]:
        headline = str(row["headline"]).strip()
        body = str(row["body_text"]).strip().replace("\n", " ")
        source = str(row["source"]).strip()
        source_class = str(row.get("source_class", "UNKNOWN")).strip()
        tempo = str(row.get("tempo_label", "NO_SPIKE")).strip()
        keyword_strength = float(row.get("keyword_strength", 0.0))
        if not headline and not body:
            continue
        snippets.append(
            f"[{source}/{source_class}/tempo={tempo}/kw={keyword_strength:.3f}] {headline} {body[:220]}".strip()
        )

    joined = " || ".join(snippets)
    return (
        f"symbol={symbol}\n"
        f"event_ts={format_ts(event_ts)}\n"
        f"zone=4 news_count={len(rows)} sentiment_avg={sentiment_avg:.4f}\n"
        f"news={joined[:12000]}"
    )


def parse_keywords(raw: str) -> list[str]:
    text = raw.strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    out: list[str] = []
    for item in parsed:
        token = str(item).strip()
        if token:
            out.append(token)
    return out


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def latency_quality_score(latency_ms: float | None) -> float:
    if latency_ms is None:
        return 0.15
    if latency_ms <= 1_000:
        return 1.0
    if latency_ms >= 60_000:
        return 0.05
    return float(math.exp(-latency_ms / 15_000.0))


def estimate_zero_shot_potential(text: str, source_class: str) -> float:
    base_url = os.getenv("ZONE4_META_LLM_BASE_URL", "").strip() or os.getenv("ZONE5_LLM_BASE_URL", "").strip() or os.getenv("LLM_BASE_URL", "").strip()
    model = os.getenv("ZONE4_META_LLM_MODEL", "").strip() or os.getenv("ZONE5_LLM_MODEL", "").strip() or os.getenv("LLM_MODEL", "openai/gpt-oss-20b").strip()
    timeout_ms = int(max(200, float(os.getenv("ZONE4_META_LLM_TIMEOUT_MS", "900"))))
    fallback = 5.0

    if not base_url:
        return fallback

    payload = {
        "model": model,
        "temperature": 0.1,
        "max_tokens": 80,
        "messages": [
            {
                "role": "system",
                "content": "Score disruptive potential of this stock news from 1 to 10. Respond JSON only: {\"potential_score\": number}.",
            },
            {
                "role": "user",
                "content": json.dumps({"source_class": source_class, "text": text[:1500]}, ensure_ascii=False),
            },
        ],
    }
    try:
        req = Request(
            f"{base_url.rstrip('/')}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req, timeout=timeout_ms / 1000.0) as resp:
            raw = resp.read().decode("utf-8", errors="ignore")
        parsed = json.loads(raw)
        content = ""
        try:
            choice = parsed.get("choices", [])[0]
            message = choice.get("message", {})
            msg_content = message.get("content", "")
            if isinstance(msg_content, str):
                content = msg_content
            elif isinstance(msg_content, list):
                content = "".join(str(part.get("text", "")) for part in msg_content if isinstance(part, dict))
        except Exception:
            content = ""
        if not content:
            return fallback
        try:
            obj = json.loads(content.strip())
        except Exception:
            start = content.find("{")
            end = content.rfind("}")
            if start >= 0 and end > start:
                try:
                    obj = json.loads(content[start : end + 1])
                except Exception:
                    return fallback
            else:
                return fallback
        score = float(obj.get("potential_score", fallback))
        if not math.isfinite(score):
            return fallback
        return max(1.0, min(10.0, score))
    except (OSError, URLError, ValueError):
        return fallback


def build_zone4_numeric_features(symbol: str, event_ts: datetime, rows: list[dict[str, Any]]) -> list[float]:
    if not rows:
        cold = estimate_zero_shot_potential(f"symbol={symbol} event_ts={format_ts(event_ts)} no_news", "UNKNOWN")
        base = [0.0] * Z4_NUMERIC_DIM
        base[0] = cold / 10.0
        base[1] = 0.1
        base[2] = 0.1
        return base

    source_scores = [float(r.get("source_score", 0.0)) for r in rows]
    keyword_strengths = [float(r.get("keyword_strength", 0.0)) for r in rows]
    sector_couplings = [float(r.get("sector_coupling_idx", 0.0)) for r in rows]
    shock_scores = [float(r.get("shock_score", 0.0)) / 10.0 for r in rows]
    sentiments = [float(r.get("sentiment_score", 0.0)) for r in rows]
    latencies = [
        float(r.get("reaction_latency_ms"))
        for r in rows
        if r.get("reaction_latency_ms") is not None and math.isfinite(float(r.get("reaction_latency_ms")))
    ]
    potential_scores = [float(r.get("llm_potential_score", 0.0)) / 10.0 for r in rows]

    keyword_count = 0.0
    impact_count = 0.0
    tempo_hist = {"HIGH_QUALITY": 0.0, "MID_QUALITY": 0.0, "LOW_QUALITY": 0.0, "NO_SPIKE": 0.0}
    for row in rows:
        keywords = parse_keywords(str(row.get("keywords_json", "[]")))
        keyword_count += len(keywords)
        impact_count += sum(1 for token in keywords if token in ("공급계약", "임상3상", "최대주주변경", "수주", "합병"))
        tempo = str(row.get("tempo_label", "NO_SPIKE")).strip()
        tempo_hist[tempo if tempo in tempo_hist else "NO_SPIKE"] += 1.0

    avg_source = sum(source_scores) / max(1, len(source_scores))
    avg_keyword_strength = sum(keyword_strengths) / max(1, len(keyword_strengths))
    avg_sector = sum(sector_couplings) / max(1, len(sector_couplings))
    avg_shock = sum(shock_scores) / max(1, len(shock_scores))
    avg_sentiment = sum(sentiments) / max(1, len(sentiments))
    avg_potential = sum(potential_scores) / max(1, len(potential_scores))
    avg_latency = (sum(latencies) / len(latencies)) if latencies else None
    quality = latency_quality_score(avg_latency)

    cold_start_min_rows = int(max(10, float(os.getenv("ZONE4_ZERO_SHOT_MIN_ROWS", "120"))))
    if len(rows) < cold_start_min_rows:
        zero_shot = estimate_zero_shot_potential(build_zone4_text(symbol, event_ts, rows), str(rows[0].get("source_class", "UNKNOWN")))
        avg_potential = max(avg_potential, zero_shot / 10.0)

    base_features = [
        clamp01(avg_source),
        clamp01(avg_keyword_strength),
        clamp01(avg_sector),
        clamp01(avg_shock),
        clamp01((avg_sentiment + 1.0) / 2.0),
        clamp01(quality),
        clamp01(avg_potential),
        clamp01(keyword_count / 40.0),
        clamp01(impact_count / 15.0),
        clamp01(tempo_hist["HIGH_QUALITY"] / max(1.0, len(rows))),
        clamp01(tempo_hist["MID_QUALITY"] / max(1.0, len(rows))),
        clamp01(tempo_hist["LOW_QUALITY"] / max(1.0, len(rows))),
        clamp01(tempo_hist["NO_SPIKE"] / max(1.0, len(rows))),
    ]

    features: list[float] = []
    for idx in range(Z4_NUMERIC_DIM):
        a = base_features[idx % len(base_features)]
        b = base_features[(idx * 3 + 2) % len(base_features)]
        c = base_features[(idx * 5 + 1) % len(base_features)]
        harmonic = math.sin((idx + 1) * 0.173) * 0.07 + math.cos((idx + 1) * 0.119) * 0.05
        mixed = a * 0.52 + b * 0.33 + c * 0.15 + harmonic
        features.append(float(max(-1.0, min(1.0, mixed))))
    return features


def search_z4_semantic_cases(conn: Any, z4_vec: list[float], top_k: int) -> dict[str, Any]:
    safe_top_k = int(max(1, min(40, top_k)))
    query = f"""
        select
          event_id,
          symbol,
          event_ts,
          profit_rate,
          (1 - vector_distance(z4_sent_vec, to_vector(:z4_vec), COSINE)) as sim_z4,
          (
            (1 - vector_distance(z4_sent_vec, to_vector(:z4_vec), COSINE))
            * (1 + greatest(nvl(profit_rate, 0), 0) / 10)
          ) as weighted_score
        from TB_INTEGRATED_VECTOR_STATION
        order by weighted_score desc
        fetch first {safe_top_k} rows only
    """
    with conn.cursor() as cursor:
        cursor.execute(query, {"z4_vec": to_oracle_vector_text(z4_vec)})
        rows = cursor.fetchall()

    cases: list[dict[str, Any]] = []
    weighted_profit_sum = 0.0
    weighted_sum = 0.0
    for row in rows:
        event_id = int(row[0]) if row[0] is not None else 0
        profit = float(row[3]) if row[3] is not None else None
        sim_z4 = float(row[4]) if row[4] is not None else 0.0
        weighted_score = float(row[5]) if row[5] is not None else 0.0
        cases.append(
            {
                "event_id": event_id,
                "symbol": str(row[1]) if row[1] is not None else "UNKNOWN",
                "event_ts": str(row[2]) if row[2] is not None else "",
                "profit_rate": profit,
                "sim_z4": round(sim_z4, 6),
                "weighted_score": round(weighted_score, 6),
            }
        )
        if profit is not None and weighted_score > 0:
            weighted_profit_sum += profit * weighted_score
            weighted_sum += weighted_score

    expected_profit = (weighted_profit_sum / weighted_sum) if weighted_sum > 0 else 0.0
    return {
        "top_k": safe_top_k,
        "cases": cases,
        "expected_profit_rate": round(expected_profit, 4),
    }

def insert_integrated_row(
    conn: Any,
    *,
    symbol: str,
    event_ts: datetime,
    z1_vec: list[float],
    z2_vec: list[float],
    z3_vec: list[float],
    z4_vec: list[float],
    profit_rate: float | None,
) -> int:
    with conn.cursor() as cursor:
        event_id_var = cursor.var(oracledb.NUMBER)
        cursor.execute(
            """
            insert into TB_INTEGRATED_VECTOR_STATION
              (symbol, event_ts, z1_tech_vec, z2_fund_vec, z3_chart_vec, z4_sent_vec, profit_rate, created_at, updated_at)
            values
              (
                :symbol,
                :event_ts,
                to_vector(:z1_vec),
                to_vector(:z2_vec),
                to_vector(:z3_vec),
                to_vector(:z4_vec),
                :profit_rate,
                systimestamp,
                systimestamp
              )
            returning event_id into :event_id
            """,
            {
                "symbol": symbol,
                "event_ts": event_ts,
                "z1_vec": to_oracle_vector_text(z1_vec),
                "z2_vec": to_oracle_vector_text(z2_vec),
                "z3_vec": to_oracle_vector_text(z3_vec),
                "z4_vec": to_oracle_vector_text(z4_vec),
                "profit_rate": profit_rate,
                "event_id": event_id_var,
            },
        )
    conn.commit()

    value = event_id_var.getvalue()
    if isinstance(value, list) and value:
        return int(value[0])
    return int(value)


def run(args: argparse.Namespace) -> dict[str, Any]:
    if np is None:
        raise RuntimeError("numpy is required")
    if oracledb is None:
        raise RuntimeError("oracledb is required")

    started = time.perf_counter()
    user, password, connect_string = read_oracle_env()

    station = GpuEmbeddingStation(
        allow_cpu_fallback=bool(args.allow_cpu_fallback),
        skip_gpu_name_check=bool(args.skip_gpu_name_check),
    )

    requested_ts = parse_event_ts(str(args.event_ts or ""))
    with oracledb.connect(user=user, password=password, dsn=connect_string) as conn:
        trigger = resolve_trigger(conn, symbol=str(args.symbol), event_ts=requested_ts)

        query_started = time.perf_counter()
        zone1_rows = fetch_zone1_raw(
            conn,
            symbol=trigger.symbol,
            event_ts=trigger.event_ts,
            lookback_sec=int(args.tick_lookback_sec),
            max_rows=int(args.tick_max_rows),
        )
        zone2_row = fetch_zone2_row(conn, symbol=trigger.symbol)
        zone3_rows = fetch_zone3_raw(
            conn,
            symbol=trigger.symbol,
            event_ts=trigger.event_ts,
            lookback_min=int(args.candle_lookback_min),
            max_rows=int(args.candle_max_rows),
        )
        zone4_rows = fetch_zone4_raw(
            conn,
            symbol=trigger.symbol,
            event_ts=trigger.event_ts,
            lookback_min=int(args.news_lookback_min),
            max_rows=int(args.news_max_rows),
        )
        query_ms = (time.perf_counter() - query_started) * 1000.0

        zone_text = {
            "z1": build_zone1_text(trigger.symbol, trigger.event_ts, zone1_rows),
            "z2": build_zone2_text(trigger.symbol, zone2_row),
            "z3": build_zone3_text(trigger.symbol, trigger.event_ts, zone3_rows),
            "z4": build_zone4_text(trigger.symbol, trigger.event_ts, zone4_rows),
        }
        z4_numeric_features = build_zone4_numeric_features(trigger.symbol, trigger.event_ts, zone4_rows)

        embed_started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {zone: executor.submit(station.embed_zone, zone, zone_text[zone]) for zone in ("z1", "z2", "z3")}
            z1_vec = futures["z1"].result()
            z2_vec = futures["z2"].result()
            z3_vec = futures["z3"].result()
        z4_vec = station.embed_zone4_hybrid(zone_text["z4"], z4_numeric_features)
        embed_ms = (time.perf_counter() - embed_started) * 1000.0

        event_id: int | None = None
        insert_ms = 0.0
        semantic_search: dict[str, Any] | None = None
        if not args.dry_run:
            insert_started = time.perf_counter()
            event_id = insert_integrated_row(
                conn,
                symbol=trigger.symbol,
                event_ts=trigger.event_ts,
                z1_vec=z1_vec,
                z2_vec=z2_vec,
                z3_vec=z3_vec,
                z4_vec=z4_vec,
                profit_rate=float(args.profit_rate) if args.profit_rate is not None else None,
            )
            insert_ms = (time.perf_counter() - insert_started) * 1000.0
            semantic_search = search_z4_semantic_cases(
                conn,
                z4_vec,
                int(getattr(args, "z4_search_top_k", 12)),
            )
        else:
            semantic_search = {
                "top_k": int(getattr(args, "z4_search_top_k", 12)),
                "cases": [],
                "expected_profit_rate": 0.0,
            }

    total_ms = (time.perf_counter() - started) * 1000.0
    return {
        "status": "ok",
        "symbol": str(args.symbol).strip().upper(),
        "event_ts": format_ts(trigger.event_ts),
        "event_id": event_id,
        "dry_run": bool(args.dry_run),
        "device": station.device,
        "device_name": station.device_name,
        "models": {
            zone: os.getenv(ZONE_MODEL_ENV[zone], ZONE_MODEL_DEFAULT[zone]).strip() for zone in ("z1", "z2", "z3", "z4")
        },
        "raw_rows": {
            "z1_ticks": len(zone1_rows),
            "z2_fundamental_exists": zone2_row is not None,
            "z3_candles": len(zone3_rows),
            "z4_news": len(zone4_rows),
        },
        "vector_dims": {
            "z1": len(z1_vec),
            "z2": len(z2_vec),
            "z3": len(z3_vec),
            "z4": len(z4_vec),
        },
        "z4_hybrid": {
            "text_dim": Z4_TEXT_DIM,
            "numeric_dim": Z4_NUMERIC_DIM,
            "numeric_head": [round(float(v), 6) for v in z4_numeric_features[:12]],
            "target_latency_ms": 30.0,
            "actual_embedding_ms": round(embed_ms, 3),
            "within_target": embed_ms <= 30.0,
        },
        "z4_semantic_search": semantic_search,
        "latency_ms": {
            "query": round(query_ms, 3),
            "embedding": round(embed_ms, 3),
            "insert": round(insert_ms, 3),
            "total": round(total_ms, 3),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Integrated Miner: RAW query -> GPU vectorization(Z1~Z4) -> single-row insert into TB_INTEGRATED_VECTOR_STATION"
    )
    parser.add_argument("--symbol", required=True, help="Target symbol, e.g. 005930")
    parser.add_argument(
        "--event-ts",
        default="",
        help="Trigger timestamp ISO8601 (default: latest TB_ZONE1_TICK_RAW.event_ts for symbol)",
    )
    parser.add_argument("--profit-rate", type=float, default=None)

    parser.add_argument("--tick-lookback-sec", type=int, default=120)
    parser.add_argument("--tick-max-rows", type=int, default=240)
    parser.add_argument("--candle-lookback-min", type=int, default=30)
    parser.add_argument("--candle-max-rows", type=int, default=120)
    parser.add_argument("--news-lookback-min", type=int, default=120)
    parser.add_argument("--news-max-rows", type=int, default=80)
    parser.add_argument("--z4-search-top-k", type=int, default=12)

    parser.add_argument("--dry-run", action="store_true", help="Run full pipeline without DB insert")
    parser.add_argument("--allow-cpu-fallback", action="store_true", help="Allow CPU mode when CUDA is unavailable")
    parser.add_argument("--skip-gpu-name-check", action="store_true", help="Skip RTX 3090 device name validation")
    args = parser.parse_args()

    try:
        result = run(args)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:  # pragma: no cover
        fallback = {
            "status": "error",
            "error": f"{type(exc).__name__}: {exc}",
            "symbol": str(getattr(args, "symbol", "")).strip().upper() or "UNKNOWN",
            "event_ts": str(getattr(args, "event_ts", "")),
            "occurred_at": format_ts(now_utc_naive()),
        }
        print(json.dumps(fallback, ensure_ascii=False))


if __name__ == "__main__":
    main()
