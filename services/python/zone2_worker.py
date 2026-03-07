from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any

import requests
from common.contracts import Zone2Fundamental

try:
    import oracledb  # type: ignore
except Exception:  # pragma: no cover
    oracledb = None


DISCLOSURE_VECTOR_DIM = max(128, int(os.getenv("ZONE2_DISCLOSURE_VECTOR_DIM", "768")))
FINANCIAL_VECTOR_DIM = max(8, int(os.getenv("ZONE2_FINANCIAL_VECTOR_DIM", "16")))

NEGATIVE_TERMS = (
    "상장폐지",
    "관리종목",
    "횡령",
    "배임",
    "불성실공시",
    "유상증자",
    "전환사채",
    "신주인수권부사채",
    "채무불이행",
    "감사의견 거절",
)
POSITIVE_TERMS = (
    "수주",
    "흑자전환",
    "자사주",
    "실적개선",
    "배당확대",
    "신사업",
    "특허",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_bool(raw: str) -> bool:
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def parse_optional_float(raw: str) -> float | None:
    text = raw.strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def symbol_hash(symbol: str) -> int:
    h = 17
    for ch in symbol:
        h = (h * 31 + ord(ch)) % 1_000_003
    return h


def deterministic_unit(symbol: str, salt: str) -> float:
    hashed = hashlib.sha256(f"{symbol}|{salt}".encode("utf-8")).hexdigest()
    as_int = int(hashed[:12], 16)
    return as_int / float(16**12 - 1)


def normalize_feature(value: float | None, min_v: float, max_v: float, *, invert: bool = False, default: float = 0.5) -> float:
    if value is None:
        return default
    if max_v <= min_v:
        return default
    normalized = clamp((value - min_v) / (max_v - min_v), 0.0, 1.0)
    return 1.0 - normalized if invert else normalized


def normalize_vector(values: list[float], dim: int) -> list[float]:
    vec = [float(v) for v in values]
    if len(vec) < dim:
        vec.extend([0.0] * (dim - len(vec)))
    if len(vec) > dim:
        vec = vec[:dim]

    norm_sq = sum(v * v for v in vec)
    if norm_sq <= 0:
        return [0.0] * dim
    norm = norm_sq**0.5
    return [round(v / norm, 6) for v in vec]


def deterministic_embedding(text: str, dim: int) -> list[float]:
    seed = text.strip() or "EMPTY"
    raw: list[float] = []
    for idx in range(dim):
        digest = hashlib.sha256(f"{seed}|{idx}".encode("utf-8")).digest()
        value = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF
        raw.append(value * 2.0 - 1.0)
    return normalize_vector(raw, dim)


def fetch_dart_disclosure_text(symbol: str, corp_code: str, dart_api_key: str, timeout_s: float) -> str:
    if not dart_api_key or not corp_code:
        return ""

    endpoint = "https://opendart.fss.or.kr/api/list.json"
    params = {
        "crtfc_key": dart_api_key,
        "corp_code": corp_code,
        "bgn_de": datetime.now(timezone.utc).strftime("%Y0101"),
        "end_de": datetime.now(timezone.utc).strftime("%Y%m%d"),
        "last_reprt_at": "Y",
        "page_no": 1,
        "page_count": 10,
    }

    response = requests.get(endpoint, params=params, timeout=timeout_s)
    response.raise_for_status()
    payload = response.json()

    if payload.get("status") not in {"000"}:
        return ""

    items = payload.get("list") or []
    if not isinstance(items, list):
        return ""

    lines: list[str] = []
    for item in items[:5]:
        if not isinstance(item, dict):
            continue
        report_nm = str(item.get("report_nm", "")).strip()
        rcept_dt = str(item.get("rcept_dt", "")).strip()
        if report_nm:
            lines.append(f"{rcept_dt} {report_nm}".strip())

    if not lines:
        return ""
    return f"{symbol} 최근 공시: " + " / ".join(lines)


def call_local_llm_summary(input_text: str, symbol: str, timeout_s: float) -> tuple[str, bool]:
    text = input_text.strip()
    if not text:
        return f"{symbol} 관련 최근 공시 원문이 없어 요약 생략", True

    provider = os.getenv("ZONE2_LLM_PROVIDER", "OLLAMA").strip().upper()
    model = os.getenv("ZONE2_LLM_MODEL", "qwen2.5:7b").strip()

    prompt = (
        "너는 단타 리스크 분석가다. 아래 공시 문장을 읽고 "
        "'주주 가치 훼손 가능성'을 3줄 이내로 요약해라. "
        "출력은 핵심 위험 요인 중심으로 작성하고 한국어로 답하라.\n\n"
        f"[종목] {symbol}\n"
        f"[공시 텍스트]\n{text}\n"
    )

    try:
        if provider == "OLLAMA":
            base_url = os.getenv("ZONE2_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
            response = requests.post(
                f"{base_url}/api/generate",
                json={
                    "model": model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": 0.1, "num_predict": 180},
                },
                timeout=timeout_s,
            )
            response.raise_for_status()
            data = response.json()
            summary = str(data.get("response", "")).strip()
            if summary:
                return summary, False

        if provider in {"VLLM", "OPENAI"}:
            base_url = os.getenv("ZONE2_VLLM_URL", "http://127.0.0.1:8000").rstrip("/")
            response = requests.post(
                f"{base_url}/v1/chat/completions",
                json={
                    "model": model,
                    "temperature": 0.1,
                    "max_tokens": 180,
                    "messages": [
                        {"role": "system", "content": "한국어 금융 리스크 요약가"},
                        {"role": "user", "content": prompt},
                    ],
                },
                timeout=timeout_s,
            )
            response.raise_for_status()
            data = response.json()
            choices = data.get("choices") or []
            if choices and isinstance(choices[0], dict):
                message = choices[0].get("message") or {}
                summary = str(message.get("content", "")).strip()
                if summary:
                    return summary, False
    except Exception:
        pass

    heuristic = text[:240]
    return f"LLM 요약 실패로 휴리스틱 사용: {heuristic}", True


def embed_text_with_local_model(text: str, timeout_s: float) -> tuple[list[float], bool]:
    source_text = text.strip() or "empty disclosure"
    provider = os.getenv("ZONE2_EMBED_PROVIDER", "OLLAMA").strip().upper()
    model = os.getenv("ZONE2_EMBED_MODEL", "nomic-embed-text").strip()

    try:
        if provider == "OLLAMA":
            base_url = os.getenv("ZONE2_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
            response = requests.post(
                f"{base_url}/api/embeddings",
                json={"model": model, "prompt": source_text},
                timeout=timeout_s,
            )
            response.raise_for_status()
            data = response.json()
            embedding = data.get("embedding")
            if isinstance(embedding, list) and embedding:
                vector = [float(x) for x in embedding]
                return normalize_vector(vector, DISCLOSURE_VECTOR_DIM), False

        if provider in {"VLLM", "OPENAI"}:
            base_url = os.getenv("ZONE2_VLLM_URL", "http://127.0.0.1:8000").rstrip("/")
            response = requests.post(
                f"{base_url}/v1/embeddings",
                json={"model": model, "input": source_text},
                timeout=timeout_s,
            )
            response.raise_for_status()
            data = response.json()
            rows = data.get("data") or []
            if rows and isinstance(rows[0], dict):
                embedding = rows[0].get("embedding")
                if isinstance(embedding, list) and embedding:
                    vector = [float(x) for x in embedding]
                    return normalize_vector(vector, DISCLOSURE_VECTOR_DIM), False
    except Exception:
        pass

    return deterministic_embedding(source_text, DISCLOSURE_VECTOR_DIM), True


def build_financial_signature_vector(symbol: str, metrics: dict[str, float]) -> list[float]:
    pbr = normalize_feature(metrics.get("pbr"), 0.2, 5.0, invert=True, default=0.45)
    per = normalize_feature(metrics.get("per"), 2.0, 80.0, invert=True, default=0.45)
    debt_ratio = normalize_feature(metrics.get("debt_ratio"), 20.0, 400.0, default=0.6)
    reserve_ratio = normalize_feature(metrics.get("reserve_ratio"), 0.0, 3_000.0, invert=True, default=0.4)
    roe = normalize_feature(metrics.get("roe"), -30.0, 40.0, invert=True, default=0.5)
    roa = normalize_feature(metrics.get("roa"), -20.0, 20.0, invert=True, default=0.5)
    current_ratio = normalize_feature(metrics.get("current_ratio"), 30.0, 300.0, invert=True, default=0.5)
    quick_ratio = normalize_feature(metrics.get("quick_ratio"), 20.0, 250.0, invert=True, default=0.5)
    interest_coverage = normalize_feature(metrics.get("interest_coverage"), -5.0, 20.0, invert=True, default=0.5)
    operating_margin = normalize_feature(metrics.get("operating_margin"), -30.0, 35.0, invert=True, default=0.5)
    net_margin = normalize_feature(metrics.get("net_margin"), -40.0, 30.0, invert=True, default=0.5)
    sales_growth = normalize_feature(metrics.get("sales_growth"), -40.0, 80.0, invert=True, default=0.5)

    quality = clamp((roe + roa + operating_margin + net_margin) / 4.0, 0.0, 1.0)
    leverage_stress = clamp((debt_ratio + (1.0 - reserve_ratio)) / 2.0, 0.0, 1.0)
    liquidity_stress = clamp((current_ratio + quick_ratio) / 2.0, 0.0, 1.0)
    valuation_stress = clamp((pbr + per) / 2.0, 0.0, 1.0)

    seed = deterministic_unit(symbol, "tail")
    tail_a = clamp(0.3 + seed * 0.4 + leverage_stress * 0.3, 0.0, 1.0)
    tail_b = clamp(0.2 + (1.0 - quality) * 0.6 + valuation_stress * 0.2, 0.0, 1.0)
    tail_c = clamp(0.2 + liquidity_stress * 0.5 + (1.0 - sales_growth) * 0.3, 0.0, 1.0)
    tail_d = clamp((tail_a + tail_b + tail_c) / 3.0, 0.0, 1.0)

    vector = [
        pbr,
        per,
        debt_ratio,
        reserve_ratio,
        roe,
        roa,
        current_ratio,
        quick_ratio,
        interest_coverage,
        operating_margin,
        net_margin,
        sales_growth,
        quality,
        leverage_stress,
        liquidity_stress,
        valuation_stress + tail_a * 0.15 + tail_b * 0.15 + tail_c * 0.1 + tail_d * 0.1,
    ]
    return normalize_vector(vector, FINANCIAL_VECTOR_DIM)


def collect_metric_inputs(symbol: str, args: argparse.Namespace) -> dict[str, float]:
    defaults = {
        "pbr": 0.7 + deterministic_unit(symbol, "pbr") * 2.2,
        "per": 4.0 + deterministic_unit(symbol, "per") * 30.0,
        "debt_ratio": 40.0 + deterministic_unit(symbol, "debt_ratio") * 220.0,
        "reserve_ratio": 200.0 + deterministic_unit(symbol, "reserve_ratio") * 1_200.0,
        "roe": -3.0 + deterministic_unit(symbol, "roe") * 18.0,
        "roa": -2.0 + deterministic_unit(symbol, "roa") * 10.0,
        "current_ratio": 70.0 + deterministic_unit(symbol, "current_ratio") * 120.0,
        "quick_ratio": 60.0 + deterministic_unit(symbol, "quick_ratio") * 100.0,
        "interest_coverage": 1.0 + deterministic_unit(symbol, "interest_coverage") * 7.0,
        "operating_margin": -5.0 + deterministic_unit(symbol, "operating_margin") * 18.0,
        "net_margin": -8.0 + deterministic_unit(symbol, "net_margin") * 15.0,
        "sales_growth": -6.0 + deterministic_unit(symbol, "sales_growth") * 22.0,
    }

    parsed = {
        "pbr": parse_optional_float(args.pbr),
        "per": parse_optional_float(args.per),
        "debt_ratio": parse_optional_float(args.debt_ratio),
        "reserve_ratio": parse_optional_float(args.reserve_ratio),
        "roe": parse_optional_float(args.roe),
        "roa": parse_optional_float(args.roa),
        "current_ratio": parse_optional_float(args.current_ratio),
        "quick_ratio": parse_optional_float(args.quick_ratio),
        "interest_coverage": parse_optional_float(args.interest_coverage),
        "operating_margin": parse_optional_float(args.operating_margin),
        "net_margin": parse_optional_float(args.net_margin),
        "sales_growth": parse_optional_float(args.sales_growth),
    }

    metrics: dict[str, float] = {}
    for key, default_value in defaults.items():
        metrics[key] = parsed[key] if parsed[key] is not None else default_value
    return metrics


def compute_disclosure_toxicity(summary: str, original_text: str) -> float:
    text = f"{summary} {original_text}".lower()
    neg_hits = sum(1 for token in NEGATIVE_TERMS if token.lower() in text)
    pos_hits = sum(1 for token in POSITIVE_TERMS if token.lower() in text)
    score = 0.5 + neg_hits * 0.12 - pos_hits * 0.08
    return round(clamp(score, 0.0, 1.0), 4)


def build_rule_risk_score(
    toxicity: float,
    metrics: dict[str, float],
    has_cb_bw_issue: bool,
    has_krx_warning: bool,
    has_capital_impairment: bool,
) -> float:
    score = toxicity * 0.45
    if has_cb_bw_issue:
        score += 0.22
    if has_krx_warning:
        score += 0.2
    if has_capital_impairment:
        score += 0.25

    if metrics["debt_ratio"] >= 260:
        score += 0.12
    if metrics["reserve_ratio"] <= 50:
        score += 0.08
    if metrics["roe"] <= -8:
        score += 0.08
    if metrics["operating_margin"] <= -10:
        score += 0.08

    return round(clamp(score, 0.0, 1.0), 4)


def read_oracle_env() -> tuple[str, str, str] | None:
    user = os.getenv("ORACLE_USER", "").strip()
    password = os.getenv("ORACLE_PASSWORD", "").strip()
    connect_string = os.getenv("ORACLE_CONNECTION_STRING", "").strip()
    if not user or not password or not connect_string:
        return None
    return user, password, connect_string


def persist_zone2_vectors(payload: dict[str, Any]) -> bool:
    if oracledb is None:
        return False
    env = read_oracle_env()
    if not env:
        return False

    user, password, connect_string = env
    conn = None
    try:
        conn = oracledb.connect(user=user, password=password, dsn=connect_string)
        with conn.cursor() as cursor:
            cursor.execute(
                """
                merge into TB_ZONE2_FUNDAMENTAL tgt
                using (
                  select
                    :symbol as symbol,
                    :risk_flag as risk_flag,
                    :issues_json as issues_json,
                    :has_cb_bw_issue as has_cb_bw_issue,
                    :has_krx_warning as has_krx_warning,
                    :has_capital_impairment as has_capital_impairment,
                    :source as source,
                    :disclosure_vector as disclosure_vector,
                    :financial_vector as financial_vector
                  from dual
                ) src
                on (tgt.symbol = src.symbol)
                when matched then
                  update set
                    tgt.risk_flag = src.risk_flag,
                    tgt.issues_json = src.issues_json,
                    tgt.has_cb_bw_issue = src.has_cb_bw_issue,
                    tgt.has_krx_warning = src.has_krx_warning,
                    tgt.has_capital_impairment = src.has_capital_impairment,
                    tgt.checked_at = systimestamp,
                    tgt.source = src.source,
                    tgt.disclosure_vector = case when src.disclosure_vector is null then tgt.disclosure_vector else to_vector(src.disclosure_vector) end,
                    tgt.financial_signature_vector = case when src.financial_vector is null then tgt.financial_signature_vector else to_vector(src.financial_vector) end
                when not matched then
                  insert (
                    symbol, risk_flag, issues_json, has_cb_bw_issue, has_krx_warning, has_capital_impairment, checked_at, source,
                    disclosure_vector, financial_signature_vector
                  )
                  values (
                    src.symbol, src.risk_flag, src.issues_json, src.has_cb_bw_issue, src.has_krx_warning, src.has_capital_impairment, systimestamp, src.source,
                    case when src.disclosure_vector is null then null else to_vector(src.disclosure_vector) end,
                    case when src.financial_vector is null then null else to_vector(src.financial_vector) end
                  )
                """,
                {
                    "symbol": payload["symbol"],
                    "risk_flag": payload["risk_flag"],
                    "issues_json": json.dumps(payload.get("issues", []), ensure_ascii=False),
                    "has_cb_bw_issue": 1 if payload.get("has_cb_bw_issue") else 0,
                    "has_krx_warning": 1 if payload.get("has_krx_warning") else 0,
                    "has_capital_impairment": 1 if payload.get("has_capital_impairment") else 0,
                    "source": "PYTHON_WORKER",
                    "disclosure_vector": json.dumps(payload.get("disclosure_vector"), ensure_ascii=False)
                    if payload.get("disclosure_vector")
                    else None,
                    "financial_vector": json.dumps(payload.get("financial_signature_vector"), ensure_ascii=False)
                    if payload.get("financial_signature_vector")
                    else None,
                },
            )
        conn.commit()
        return True
    except Exception:
        return False
    finally:
        if conn is not None:
            conn.close()


def run(args: argparse.Namespace) -> dict[str, Any]:
    symbol = str(args.symbol).strip() or "005930"
    timeout_s = max(0.2, float(os.getenv("ZONE2_LOCAL_LLM_TIMEOUT_SEC", "0.9")))
    dart_timeout_s = max(0.3, float(os.getenv("ZONE2_DART_TIMEOUT_SEC", "1.2")))
    safe_reasons: list[str] = []

    metrics = collect_metric_inputs(symbol, args)
    financial_signature_vector = build_financial_signature_vector(symbol, metrics)

    dart_text = str(args.dart_text or "").strip()
    if not dart_text:
        dart_api_key = os.getenv("DART_API_KEY", "").strip()
        corp_code = str(args.corp_code or "").strip()
        try:
            dart_text = fetch_dart_disclosure_text(symbol, corp_code, dart_api_key, dart_timeout_s)
        except Exception:
            safe_reasons.append("dart_fetch_failed")
            dart_text = ""

    disclosure_summary, llm_degraded = call_local_llm_summary(dart_text, symbol, timeout_s)
    if llm_degraded:
        safe_reasons.append("llm_summary_fallback")

    disclosure_vector, embedding_degraded = embed_text_with_local_model(disclosure_summary, timeout_s)
    if embedding_degraded:
        safe_reasons.append("embedding_fallback")

    toxicity = compute_disclosure_toxicity(disclosure_summary, dart_text)

    has_cb_bw_issue = parse_bool(args.has_cb_bw) if args.has_cb_bw != "" else ("cb" in disclosure_summary.lower() or "bw" in disclosure_summary.lower())
    has_krx_warning = parse_bool(args.has_krx_warning) if args.has_krx_warning != "" else ("경고" in disclosure_summary or "위험" in disclosure_summary)
    has_capital_impairment = (
        parse_bool(args.has_capital_impairment)
        if args.has_capital_impairment != ""
        else (metrics["debt_ratio"] >= 260 or metrics["reserve_ratio"] <= 30 or metrics["roe"] <= -12)
    )

    issues: list[str] = []
    if has_cb_bw_issue:
        issues.append("최근 3개월 내 CB/BW/유상증자 이력")
    if has_krx_warning:
        issues.append("KRX 투자경고/투자위험/관리종목 지정")
    if has_capital_impairment:
        issues.append("완전자본잠식 또는 재무 불건전성 신호")
    if toxicity >= 0.7:
        issues.append("공시 뉘앙스 고위험")

    rule_risk_score = build_rule_risk_score(
        toxicity=toxicity,
        metrics=metrics,
        has_cb_bw_issue=has_cb_bw_issue,
        has_krx_warning=has_krx_warning,
        has_capital_impairment=has_capital_impairment,
    )
    vector_risk_score = 0.5
    risk_score = round(clamp(rule_risk_score, 0.0, 1.0), 4)
    safe_mode = len(safe_reasons) > 0
    if safe_mode:
        risk_score = max(risk_score, 0.75)

    blocked = (
        has_cb_bw_issue
        or has_krx_warning
        or has_capital_impairment
        or toxicity >= 0.75
        or safe_mode
        or risk_score >= 0.65
    )

    model = Zone2Fundamental(
        symbol=symbol,
        risk_flag="BLOCKED" if blocked else "CLEAR",
        risk_score=risk_score,
        rule_risk_score=rule_risk_score,
        vector_risk_score=vector_risk_score,
        similar_pump_score=0.0,
        similar_delist_score=0.0,
        disclosure_toxicity_score=toxicity,
        vector_latency_ms=0.0,
        safe_mode=safe_mode,
        issues=issues,
        has_cb_bw_issue=has_cb_bw_issue,
        has_krx_warning=has_krx_warning,
        has_capital_impairment=has_capital_impairment,
    )

    payload = model.model_dump()
    payload["disclosure_summary"] = disclosure_summary
    payload["disclosure_vector"] = disclosure_vector
    payload["financial_signature_vector"] = financial_signature_vector
    payload["metrics"] = metrics
    payload["safe_mode_reasons"] = safe_reasons

    persisted = persist_zone2_vectors(payload)
    payload["vector_persisted"] = persisted
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Zone2 fundamental risk worker with vector enrichment")
    parser.add_argument("--symbol", default="005930")
    parser.add_argument("--corp-code", default="")
    parser.add_argument("--dart-text", default="")

    parser.add_argument("--has-cb-bw", default="")
    parser.add_argument("--has-krx-warning", default="")
    parser.add_argument("--has-capital-impairment", default="")

    parser.add_argument("--pbr", default="")
    parser.add_argument("--per", default="")
    parser.add_argument("--debt-ratio", default="")
    parser.add_argument("--reserve-ratio", default="")
    parser.add_argument("--roe", default="")
    parser.add_argument("--roa", default="")
    parser.add_argument("--current-ratio", default="")
    parser.add_argument("--quick-ratio", default="")
    parser.add_argument("--interest-coverage", default="")
    parser.add_argument("--operating-margin", default="")
    parser.add_argument("--net-margin", default="")
    parser.add_argument("--sales-growth", default="")

    args = parser.parse_args()

    try:
        result = run(args)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:  # pragma: no cover
        fallback = Zone2Fundamental(
            symbol=str(args.symbol).strip() or "005930",
            risk_flag="BLOCKED",
            risk_score=1.0,
            rule_risk_score=1.0,
            vector_risk_score=1.0,
            similar_pump_score=0.0,
            similar_delist_score=1.0,
            disclosure_toxicity_score=1.0,
            vector_latency_ms=0.0,
            safe_mode=True,
            issues=[f"zone2_worker_exception:{type(exc).__name__}"],
            has_cb_bw_issue=True,
            has_krx_warning=True,
            has_capital_impairment=True,
        )
        payload = fallback.model_dump()
        payload["disclosure_summary"] = "worker 예외로 safe-mode 진입"
        payload["disclosure_vector"] = deterministic_embedding("exception", DISCLOSURE_VECTOR_DIM)
        payload["financial_signature_vector"] = deterministic_embedding("exception-fin", FINANCIAL_VECTOR_DIM)
        payload["safe_mode_reasons"] = ["worker_exception"]
        payload["vector_persisted"] = False
        print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
