from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import math
import os
import re
import sys
import time
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    import numpy as np
except ModuleNotFoundError:
    np = None
try:
    import oracledb
except ModuleNotFoundError:
    oracledb = None
import pandas as pd
import requests
try:
    import FinanceDataReader as fdr
except ModuleNotFoundError:
    fdr = None

try:
    warnings.filterwarnings(
        "ignore",
        message=".*pkg_resources is deprecated as an API.*",
        category=UserWarning,
    )
    from pykrx import stock as pykrx_stock
except ModuleNotFoundError:
    pykrx_stock = None


ZONE3_VECTOR_DIM = max(128, int(os.getenv("ZONE3_VECTOR_DIM", "1024")))
KIS_TIMEOUT_SEC = max(3, int(os.getenv("ZONE3_KIS_TIMEOUT_SEC", "10")))
REQUEST_DELAY_SEC = max(0.2, float(os.getenv("ZONE3_MINE_REQUEST_DELAY_SEC", "0.2")))
RETRY_MAX_ATTEMPTS = max(2, int(os.getenv("ZONE3_MINE_RETRY_MAX_ATTEMPTS", "5")))
BACKOFF_MIN_SEC = max(10.0, float(os.getenv("ZONE3_MINE_BACKOFF_MIN_SEC", "10")))
BACKOFF_MAX_SEC = max(BACKOFF_MIN_SEC, float(os.getenv("ZONE3_MINE_BACKOFF_MAX_SEC", "30")))
SIMPLE_LOG = os.getenv("ZONE3_MINER_SIMPLE_LOG", "1").strip().lower() not in {"0", "false", "no"}
# 분봉 수집은 지연 체감이 커서 별도 저재시도/짧은 백오프 기본값을 사용한다.
MINUTE_TIMEOUT_SEC = max(3, int(os.getenv("ZONE3_MINUTE_TIMEOUT_SEC", "5")))
# 분봉은 API 불안정(500) 빈도가 있어 기본 재시도를 늘려 전량 수집을 우선시한다.
MINUTE_RETRY_MAX_ATTEMPTS = max(2, int(os.getenv("ZONE3_MINUTE_RETRY_MAX_ATTEMPTS", "3")))
MINUTE_BACKOFF_MIN_SEC = max(0.5, float(os.getenv("ZONE3_MINUTE_BACKOFF_MIN_SEC", "1")))
MINUTE_BACKOFF_MAX_SEC = max(MINUTE_BACKOFF_MIN_SEC, float(os.getenv("ZONE3_MINUTE_BACKOFF_MAX_SEC", "3")))
MAX_MINUTE_FAIL_STREAK_PER_SYMBOL = max(0, int(os.getenv("ZONE3_MAX_MINUTE_FAIL_STREAK_PER_SYMBOL", "0")))
MINUTE_PAST_MAX_PAGES = max(1, int(os.getenv("ZONE3_MINUTE_PAST_MAX_PAGES", "20")))
MINUTE_PAST_PAGE_ROW_LIMIT = 120
# 2페이지 미만은 과거분봉이 불완전할 가능성이 높아 캐시 재수집 기준으로 사용한다.
MINUTE_MIN_ACCEPTED_ROWS = max(1, int(os.getenv("ZONE3_MINUTE_MIN_ACCEPTED_ROWS", str(MINUTE_PAST_PAGE_ROW_LIMIT * 2))))
EVENT_MIN_AMPLITUDE_PCT = max(0.1, float(os.getenv("ZONE3_EVENT_MIN_AMPLITUDE_PCT", "7.0")))
EVENT_MIN_VOLUME_BURST_MULTIPLE = max(1.0, float(os.getenv("ZONE3_EVENT_MIN_VOLUME_BURST_MULTIPLE", "3.0")))
WINDOW_MINUTES = 30
UPSERT_BATCH_SIZE = max(1, int(os.getenv("ZONE3_UPSERT_BATCH_SIZE", "100")))
LOOKBACK_DAYS = max(30, int(os.getenv("ZONE3_LOOKBACK_DAYS", "365")))
RAW_BASE_DIR = Path(os.getenv("ZONE3_RAW_BASE_DIR", "data/zone3/raw"))
RAW_DAILY_DIR = RAW_BASE_DIR / "daily"
RAW_MINUTE_DIR = RAW_BASE_DIR / "minute"
RAW_INDEX_DIR = RAW_BASE_DIR / "index"
RAW_LOG_DIR = RAW_BASE_DIR / "_logs"
TOKEN_THROTTLE_WAIT_SEC = max(10, int(os.getenv("KIS_TOKEN_THROTTLE_WAIT_SEC", "60")))
PREV_TRADING_DAY_TAIL_MINUTES = max(1, int(os.getenv("ZONE3_PREV_TRADING_DAY_TAIL_MINUTES", "30")))
INDEX_MARKET_DIV_CODE = str(os.getenv("ZONE3_INDEX_MARKET_DIV_CODE", "U") or "U").strip().upper()
PREV_TRADING_DAY_LOOKBACK_DAYS = max(7, int(os.getenv("ZONE3_PREV_TRADING_DAY_LOOKBACK_DAYS", "45")))
RUN_LOG_FILE_ENV = os.getenv("ZONE3_MINER_LOG_FILE", "").strip()
RUN_LOG_PATH: Path | None = None
RUN_LOG_WRITE_WARNED = False


@dataclass(frozen=True)
class EventCandidate:
    symbol: str
    klass: str
    event_date: dt.date
    pct_change: float


@dataclass
class PatternRecord:
    pattern_id: str
    klass: str
    symbol: str
    pattern_vector: list[float]
    sample_ohlvc_json: str


def ensure_staging_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def pattern_record_to_dict(record: PatternRecord) -> dict[str, Any]:
    return {
        "pattern_id": record.pattern_id,
        "klass": record.klass,
        "symbol": record.symbol,
        "pattern_vector": record.pattern_vector,
        "sample_ohlvc_json": record.sample_ohlvc_json,
    }


def pattern_record_from_dict(payload: dict[str, Any]) -> PatternRecord:
    return PatternRecord(
        pattern_id=str(payload.get("pattern_id") or "").strip(),
        klass=str(payload.get("klass") or "").strip(),
        symbol=to_symbol(payload.get("symbol")),
        pattern_vector=[float(v) for v in payload.get("pattern_vector") or []],
        sample_ohlvc_json=str(payload.get("sample_ohlvc_json") or ""),
    )


def write_pattern_record_file(staging_dir: Path, record: PatternRecord) -> Path:
    ensure_staging_dir(staging_dir)
    path = staging_dir / f"{record.pattern_id}.json"
    with path.open("w", encoding="utf-8") as fp:
        json.dump(pattern_record_to_dict(record), fp, ensure_ascii=False, indent=2)
    return path


def iter_staged_record_files(staging_dir: Path) -> Iterable[Path]:
    if not staging_dir.exists():
        return []
    return sorted(staging_dir.glob("*.json"))


def has_local_record_for_symbol(staging_dir: Path, symbol: str) -> bool:
    token = f"_{symbol}_"
    for path in iter_staged_record_files(staging_dir):
        if token in path.stem:
            return True
    return False


def checkpoint_dir(staging_dir: Path) -> Path:
    path = staging_dir / "_checkpoints"
    path.mkdir(parents=True, exist_ok=True)
    return path


def checkpoint_path(staging_dir: Path, symbol: str) -> Path:
    return checkpoint_dir(staging_dir) / f"{symbol}.json"


def was_symbol_processed_today(staging_dir: Path, symbol: str, today: dt.date) -> bool:
    path = checkpoint_path(staging_dir, symbol)
    if not path.exists():
        return False
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False
    processed_date = str(payload.get("processed_date") or "").strip()
    return processed_date == today.isoformat()


def mark_symbol_processed_today(staging_dir: Path, symbol: str, reason: str, event_count: int) -> None:
    path = checkpoint_path(staging_dir, symbol)
    payload = {
        "symbol": symbol,
        "processed_date": dt.date.today().isoformat(),
        "processed_at": dt.datetime.now(dt.UTC).isoformat(),
        "reason": reason,
        "event_count": event_count,
    }
    with path.open("w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, indent=2)


def replay_local_staged_records(staging_dir: Path, batch_size: int) -> int:
    files = list(iter_staged_record_files(staging_dir))
    if not files:
        return 0

    total_merged = 0
    batch: list[PatternRecord] = []
    for file_path in files:
        try:
            payload = json.loads(file_path.read_text(encoding="utf-8"))
            record = pattern_record_from_dict(payload)
            if not record.pattern_id or not record.symbol:
                continue
            batch.append(record)
        except Exception as exc:
            emit("log", f"[LOCAL] staged file parse failed file={file_path.name}: {exc}", level="warn")
            continue

        if len(batch) >= batch_size:
            total_merged += upsert_patterns(batch)
            batch.clear()

    if batch:
        total_merged += upsert_patterns(batch)
        batch.clear()

    return total_merged


def resolve_run_log_path() -> Path | None:
    global RUN_LOG_PATH
    if RUN_LOG_PATH is not None:
        return RUN_LOG_PATH

    if RUN_LOG_FILE_ENV:
        path = Path(RUN_LOG_FILE_ENV)
        if not path.is_absolute():
            path = Path.cwd() / path
    else:
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        path = RAW_LOG_DIR / f"zone3_miner_{stamp}.jsonl"

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None

    RUN_LOG_PATH = path
    return RUN_LOG_PATH


def append_run_log_payload(payload: dict[str, Any]) -> None:
    global RUN_LOG_WRITE_WARNED
    path = resolve_run_log_path()
    if path is None:
        return
    try:
        with path.open("a", encoding="utf-8") as fp:
            fp.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception as exc:
        if RUN_LOG_WRITE_WARNED:
            return
        RUN_LOG_WRITE_WARNED = True
        warn_payload = {
            "type": "log",
            "message": f"[LOG] 파일 기록 실패: {exc}",
            "timestamp": dt.datetime.now(dt.UTC).isoformat(),
            "level": "warn",
        }
        print(json.dumps(warn_payload, ensure_ascii=False), flush=True)


def emit(event_type: str, message: str, **extra: Any) -> None:
    payload: dict[str, Any] = {
        "type": event_type,
        "message": message,
        "timestamp": dt.datetime.now(dt.UTC).isoformat(),
    }
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    append_run_log_payload(payload)


def log_status_line(
    idx: int,
    total: int,
    symbol: str,
    name: str,
    target_count: int,
    received_count: int,
) -> None:
    # 요구사항: 종목별로 4개 항목(종목,받아야하는 개수,총 받은개수,성공/실패)만 출력한다.
    success = target_count > 0 and received_count == target_count
    status = "성공" if success else "실패"
    level = "info" if success else "warn"
    message = (
        f"{idx}/{total} {symbol}({name}) | "
        f"받아야하는 개수={target_count} | "
        f"총 받은개수={received_count} | "
        f"{status}"
    )

    # 성공은 녹색, 실패는 빨간색으로 강조한다.
    if SIMPLE_LOG and sys.stdout.isatty():
        color = "\033[92m" if success else "\033[91m"
        reset = "\033[0m"
        print(f"{color}{message}{reset}", flush=True)
        append_run_log_payload(
            {
                "type": "log",
                "message": message,
                "timestamp": dt.datetime.now(dt.UTC).isoformat(),
                "level": level,
            }
        )
        return

    if success:
        message = f"[성공] {message}"
        emit("log", message, level=level)
    else:
        message = f"[실패] {message}"
        emit("log", message, level=level)


def to_symbol(raw: Any) -> str:
    text = str(raw or "").strip().upper()
    if not text:
        return ""
    if re.fullmatch(r"[A-Z0-9]{6}", text):
        return text
    # Some providers prepend market prefix like A005930.
    if re.fullmatch(r"[A-Z][A-Z0-9]{6}", text):
        return text[1:]
    # Reject unsupported symbol formats.
    return ""


def ensure_raw_dirs() -> None:
    RAW_DAILY_DIR.mkdir(parents=True, exist_ok=True)
    RAW_MINUTE_DIR.mkdir(parents=True, exist_ok=True)
    RAW_INDEX_DIR.mkdir(parents=True, exist_ok=True)
    RAW_LOG_DIR.mkdir(parents=True, exist_ok=True)


def daily_raw_path(symbol: str) -> Path:
    return RAW_DAILY_DIR / f"{symbol}.csv"


def minute_raw_path(symbol: str, event_date: dt.date) -> Path:
    return RAW_MINUTE_DIR / symbol / f"{event_date.strftime('%Y%m%d')}.csv"


def index_raw_path(index_code: str, event_date: dt.date) -> Path:
    return RAW_INDEX_DIR / index_code / f"{event_date.strftime('%Y%m%d')}.csv"


def save_daily_raw(symbol: str, df: pd.DataFrame) -> None:
    path = daily_raw_path(symbol)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = df.copy()
    out["Date"] = pd.to_datetime(out["Date"], errors="coerce").dt.date
    out = out.dropna(subset=["Date"])
    out = out[["Date", "Open", "High", "Low", "Close", "Volume"]]
    out = out.sort_values("Date")
    out = out.drop_duplicates(subset=["Date"], keep="first")
    out.to_csv(path, index=False, encoding="utf-8")


def load_daily_raw(symbol: str) -> pd.DataFrame:
    path = daily_raw_path(symbol)
    if not path.exists():
        return pd.DataFrame()
    try:
        df = pd.read_csv(path)
    except Exception as exc:
        emit("log", f"[RAW] daily read failed symbol={symbol}: {exc}", level="warn")
        return pd.DataFrame()

    required = ["Date", "Open", "High", "Low", "Close", "Volume"]
    for col in required:
        if col not in df.columns:
            df[col] = 0.0 if col != "Date" else ""

    df["Date"] = pd.to_datetime(df["Date"], errors="coerce").dt.date
    df = df.dropna(subset=["Date"])
    for col in ["Open", "High", "Low", "Close", "Volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)

    return df[required].sort_values("Date").drop_duplicates(subset=["Date"], keep="first")


def save_minute_raw(symbol: str, event_date: dt.date, df: pd.DataFrame) -> None:
    path = minute_raw_path(symbol, event_date)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = preprocess_minute_df(df)
    if out.empty:
        return
    out = out[["timestamp", "open", "high", "low", "close", "volume", "buy_vol", "sell_vol"]]
    out.to_csv(path, index=False, encoding="utf-8")


def load_minute_raw(symbol: str, event_date: dt.date) -> pd.DataFrame:
    path = minute_raw_path(symbol, event_date)
    if not path.exists():
        return pd.DataFrame()
    try:
        df = pd.read_csv(path)
    except Exception as exc:
        emit("log", f"[RAW] minute read failed symbol={symbol} date={event_date}: {exc}", level="warn")
        return pd.DataFrame()

    required = ["timestamp", "open", "high", "low", "close", "volume", "buy_vol", "sell_vol"]
    # 과거 파일 호환을 위해 누락 컬럼은 기본값으로 보강한다.
    for col in required:
        if col not in df.columns:
            df[col] = 0.0 if col != "timestamp" else ""
    return preprocess_minute_df(df)


def save_index_raw(index_code: str, event_date: dt.date, df: pd.DataFrame) -> None:
    path = index_raw_path(index_code, event_date)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = preprocess_minute_df(df)
    if out.empty:
        return
    out = out[["timestamp", "open", "high", "low", "close", "volume", "buy_vol", "sell_vol"]]
    out.to_csv(path, index=False, encoding="utf-8")


def load_index_raw(index_code: str, event_date: dt.date) -> pd.DataFrame:
    path = index_raw_path(index_code, event_date)
    if not path.exists():
        return pd.DataFrame()
    try:
        df = pd.read_csv(path)
    except Exception as exc:
        emit("log", f"[RAW] index read failed code={index_code} date={event_date}: {exc}", level="warn")
        return pd.DataFrame()

    required = ["timestamp", "open", "high", "low", "close", "volume", "buy_vol", "sell_vol"]
    for col in required:
        if col not in df.columns:
            df[col] = 0.0 if col != "timestamp" else ""
    return preprocess_minute_df(df)


def csv_has_columns(path: Path, required_cols: set[str]) -> bool:
    if not path.exists():
        return False
    try:
        header_df = pd.read_csv(path, nrows=0)
    except Exception:
        return False
    header_cols = {str(col).strip() for col in header_df.columns}
    return required_cols.issubset(header_cols)


class HttpClient:
    def __init__(self) -> None:
        self.session = requests.Session()

    def request_json(
        self,
        *,
        method: str,
        url: str,
        headers: dict[str, str] | None = None,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        timeout: int = KIS_TIMEOUT_SEC,
        retry_context: str = "http",
        max_attempts: int | None = None,
        backoff_min_sec: float | None = None,
        backoff_max_sec: float | None = None,
    ) -> dict[str, Any]:
        attempts = RETRY_MAX_ATTEMPTS if max_attempts is None else max(1, int(max_attempts))
        wait_min = BACKOFF_MIN_SEC if backoff_min_sec is None else max(0.1, float(backoff_min_sec))
        wait_max = BACKOFF_MAX_SEC if backoff_max_sec is None else max(wait_min, float(backoff_max_sec))
        last_exc: Exception | None = None
        for attempt in range(1, attempts + 1):
            time.sleep(REQUEST_DELAY_SEC)
            try:
                response = self.session.request(
                    method=method,
                    url=url,
                    headers=headers,
                    params=params,
                    json=json_body,
                    timeout=timeout,
                )
                if response.status_code == 429 or response.status_code >= 500:
                    raise requests.HTTPError(f"HTTP {response.status_code}", response=response)
                response.raise_for_status()
                return response.json()
            except (requests.Timeout, requests.ConnectionError, requests.HTTPError) as exc:
                last_exc = exc
                if attempt >= attempts:
                    break
                if isinstance(exc, requests.HTTPError) and exc.response is not None and exc.response.status_code < 429:
                    break

                wait = min(wait_max, wait_min * (2 ** (attempt - 1)))
                wait = max(wait_min, wait)
                emit(
                    "log",
                    f"[retry] {retry_context} attempt={attempt}/{attempts} wait={wait:.1f}s",
                    level="warn",
                    url=url,
                )
                time.sleep(wait)

        raise RuntimeError(f"{retry_context} request failed: {url} ({last_exc})") from last_exc


class KisClient:
    def __init__(self, http: HttpClient) -> None:
        self.http = http
        self.app_key = os.getenv("KIS_APP_KEY", "").strip()
        self.app_secret = os.getenv("KIS_APP_SECRET", "").strip()
        self.rest_url = os.getenv("KIS_REST_URL", "").strip().rstrip("/")
        self.enabled = bool(self.app_key and self.app_secret and self.rest_url)
        self.disabled_reason: str | None = None
        self._disable_emitted = False
        self._token: str | None = None
        self._token_expires = dt.datetime.now(dt.UTC)
        self._token_retry_not_before: dt.datetime | None = None

    def _ensure_token(self) -> str:
        if not self.enabled:
            raise RuntimeError(self.disabled_reason or "KIS env missing")
        now = dt.datetime.now(dt.UTC)
        if self._token and now < self._token_expires - dt.timedelta(minutes=1):
            return self._token

        if self._token_retry_not_before and now < self._token_retry_not_before:
            wait_sec = max(1.0, (self._token_retry_not_before - now).total_seconds())
            emit("log", f"[KIS] token throttle cooldown wait={wait_sec:.1f}s", level="warn")
            time.sleep(wait_sec)
            now = dt.datetime.now(dt.UTC)

        data: dict[str, Any] | None = None
        for attempt in range(1, 3):
            try:
                data = self.http.request_json(
                    method="POST",
                    url=f"{self.rest_url}/oauth2/tokenP",
                    json_body={
                        "grant_type": "client_credentials",
                        "appkey": self.app_key,
                        "appsecret": self.app_secret,
                    },
                    retry_context="kis:token",
                )
                self._token_retry_not_before = None
                break
            except Exception as exc:
                if is_kis_token_throttle_error(exc):
                    if attempt >= 2:
                        raise RuntimeError("KIS 토큰 발급 제한(EGW00133): 잠시 후 재시도 필요") from exc
                    self._token_retry_not_before = dt.datetime.now(dt.UTC) + dt.timedelta(seconds=TOKEN_THROTTLE_WAIT_SEC)
                    emit("log", f"[KIS] token throttle 감지, {TOKEN_THROTTLE_WAIT_SEC}초 대기 후 재시도", level="warn")
                    time.sleep(TOKEN_THROTTLE_WAIT_SEC)
                    continue
                if is_kis_auth_forbidden_error(exc):
                    self.disable("KIS 토큰 인증 401/403: KIS_APP_KEY/KIS_APP_SECRET/KIS_REST_URL 조합 확인 필요")
                raise

        if not data:
            raise RuntimeError("KIS token response empty")
        token = str(data.get("access_token", "")).strip()
        if not token:
            raise RuntimeError("KIS token empty")
        expires_in = int(data.get("expires_in", 3600) or 3600)
        self._token = token
        self._token_expires = now + dt.timedelta(seconds=expires_in)
        return token

    def _headers(self, tr_id: str) -> dict[str, str]:
        token = self._ensure_token()
        return {
            "authorization": f"Bearer {token}",
            "appkey": self.app_key,
            "appsecret": self.app_secret,
            "tr_id": tr_id,
            "custtype": "P",
        }

    def fetch_daily_df(self, symbol: str, start_date: dt.date, end_date: dt.date) -> pd.DataFrame:
        if not self.enabled:
            return pd.DataFrame()

        rows: list[dict[str, Any]] = []
        current = start_date
        while current <= end_date:
            chunk_end = min(end_date, current + dt.timedelta(days=120))
            try:
                data = self.http.request_json(
                    method="GET",
                    url=f"{self.rest_url}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
                    headers=self._headers("FHKST03010100"),
                    params={
                        "FID_COND_MRKT_DIV_CODE": "J",
                        "FID_INPUT_ISCD": symbol,
                        "FID_INPUT_DATE_1": current.strftime("%Y%m%d"),
                        "FID_INPUT_DATE_2": chunk_end.strftime("%Y%m%d"),
                        "FID_PERIOD_DIV_CODE": "D",
                        "FID_ORG_ADJ_PRC": "0",
                    },
                    retry_context=f"kis:daily:{symbol}",
                )
                for item in data.get("output2") or data.get("output") or []:
                    date_token = str(item.get("stck_bsop_date", "")).strip()
                    if len(date_token) != 8:
                        continue
                    rows.append(
                        {
                            "Date": dt.datetime.strptime(date_token, "%Y%m%d").date(),
                            "Open": to_float(item.get("stck_oprc")),
                            "High": to_float(item.get("stck_hgpr")),
                            "Low": to_float(item.get("stck_lwpr")),
                            "Close": to_float(item.get("stck_clpr")),
                            "Volume": to_float(item.get("acml_vol")),
                        }
                    )
            except Exception as exc:
                emit("log", f"[KIS] daily failed symbol={symbol}: {exc}", level="warn")
                if not self.enabled:
                    break
            current = chunk_end + dt.timedelta(days=1)

        if not rows:
            return pd.DataFrame()
        df = pd.DataFrame(rows)
        df = df.sort_values("Date")
        df = df.drop_duplicates(subset=["Date"], keep="first")
        return df

    def _fetch_day_minute_df(self, symbol: str, target_date: dt.date, market_div_code: str = "J") -> pd.DataFrame:
        if not self.enabled:
            return pd.DataFrame()

        target_ymd = target_date.strftime("%Y%m%d")

        def _fetch_page(cursor_time: str, page: int, reason: str) -> dict[str, Any]:
            return self.http.request_json(
                method="GET",
                url=f"{self.rest_url}/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice",
                headers=self._headers("FHKST03010230"),
                params={
                    "FID_ETC_CLS_CODE": "",
                    "FID_COND_MRKT_DIV_CODE": market_div_code,
                    "FID_INPUT_ISCD": symbol,
                    "FID_INPUT_DATE_1": target_ymd,
                    "FID_INPUT_HOUR_1": cursor_time,
                    "FID_PW_DATA_INCU_YN": "Y",
                    "FID_FAKE_TICK_INCU_YN": "N",
                },
                retry_context=f"kis:minute:{symbol}:{target_ymd}:{reason}",
                timeout=MINUTE_TIMEOUT_SEC,
                max_attempts=MINUTE_RETRY_MAX_ATTEMPTS,
                backoff_min_sec=MINUTE_BACKOFF_MIN_SEC,
                backoff_max_sec=MINUTE_BACKOFF_MAX_SEC,
            )

        row_map: dict[str, dict[str, Any]] = {}
        cursor = "153000"
        for page in range(1, MINUTE_PAST_MAX_PAGES + 1):
            parsed_rows: list[dict[str, Any]] = []
            data: dict[str, Any] | None = None
            try:
                data = _fetch_page(cursor, page, f"p{page}:c{cursor}")
            except Exception as exc:
                fallback_attempts: list[str] = []
                if page == 1:
                    emit(
                        "log",
                        f"[KIS] minute 최초 페이지 실패 symbol={symbol} date={target_ymd} cursor={cursor}: {exc}",
                        level="warn",
                    )
                    fallback_attempts = ["120000", "090000"]
                else:
                    emit(
                        "log",
                        f"[KIS] minute 페이지 실패 symbol={symbol} date={target_ymd} page={page} cursor={cursor}: {exc}",
                        level="warn",
                    )
                    # 분봉 일부 누락을 줄이기 위해 커서를 낮춘 우회 요청을 재시도한다.
                    fallback_attempts = [hhmmss_minus_one_second(cursor), "090000"]

                for fallback_cursor in fallback_attempts:
                    if not fallback_cursor or fallback_cursor == cursor:
                        continue
                    if fallback_cursor >= cursor and cursor > "090000":
                        continue
                    try:
                        data = _fetch_page(fallback_cursor, page, f"fallback:{page}:{fallback_cursor}")
                        cursor = fallback_cursor
                        break
                    except Exception:
                        continue

                if data is None:
                    if page == 1:
                        return pd.DataFrame()
                    break

            if data is None:
                break

            rows_payload = data.get("output2") or data.get("output") or []
            for item in rows_payload:
                parsed = parse_kis_minute_row(item, target_ymd)
                if parsed is None:
                    continue
                parsed_rows.append(parsed)

            if not parsed_rows:
                if page == 1:
                    emit(
                        "log",
                        f"[KIS] minute empty symbol={symbol} date={target_ymd} market={market_div_code}",
                        level="warn",
                    )
                break

            for rec in parsed_rows:
                row_map[str(rec["timestamp"])] = rec

            oldest = min((r["timestamp"] for r in parsed_rows), default=None)
            if oldest is None:
                break
            if len(parsed_rows) < MINUTE_PAST_PAGE_ROW_LIMIT:
                break

            oldest_hhmmss = oldest.strftime("%H%M%S")
            if oldest_hhmmss <= "090000":
                break

            next_cursor = hhmmss_minus_one_second(oldest_hhmmss)
            if next_cursor >= cursor:
                break
            cursor = next_cursor

        if not row_map:
            return pd.DataFrame()
        return preprocess_minute_df(pd.DataFrame(list(row_map.values())))

    def _fetch_previous_trading_day_tail(self, symbol: str, event_date: dt.date) -> pd.DataFrame:
        # 요구사항: 휴장 캘린더 기준의 "직전 영업일 1일"만 조회한다.
        prev_date = resolve_previous_trading_day(event_date)
        if prev_date is None:
            return pd.DataFrame()

        prev_df = self._fetch_day_minute_df(symbol=symbol, target_date=prev_date, market_div_code="J")
        if prev_df.empty:
            return pd.DataFrame()

        # 요구사항: "마지막 30개 행"이 아니라 "마지막 30분 구간"을 시간 기준으로 추출한다.
        last_ts = pd.to_datetime(prev_df["timestamp"], errors="coerce").max()
        if pd.isna(last_ts):
            return pd.DataFrame()
        cutoff_ts = last_ts - dt.timedelta(minutes=PREV_TRADING_DAY_TAIL_MINUTES)
        tail_df = prev_df[prev_df["timestamp"] >= cutoff_ts].copy()
        if tail_df.empty:
            # 비정상 데이터 방어: 시간 필터 결과가 비면 기존 방식으로 최소 데이터는 유지한다.
            tail_df = prev_df.tail(PREV_TRADING_DAY_TAIL_MINUTES).copy()
        return tail_df

    def fetch_event_day_minutes(self, symbol: str, event_date: dt.date) -> pd.DataFrame:
        if not self.enabled:
            return pd.DataFrame()

        # 요구사항: 이벤트 당일 + 직전 영업일 마지막 30분을 하나의 프레임으로 결합한다.
        event_df = self._fetch_day_minute_df(symbol=symbol, target_date=event_date, market_div_code="J")
        if event_df.empty:
            return pd.DataFrame()

        prev_tail_df = self._fetch_previous_trading_day_tail(symbol=symbol, event_date=event_date)
        if prev_tail_df.empty:
            return event_df

        merged = pd.concat([prev_tail_df, event_df], ignore_index=True)
        return preprocess_minute_df(merged)

    def fetch_index_day_minutes(self, index_code: str, event_date: dt.date) -> pd.DataFrame:
        if not self.enabled:
            return pd.DataFrame()

        # 지수는 INDEX_MARKET_DIV_CODE(U 기본값)로 조회하고 실패 시 J로 재시도한다.
        index_df = self._fetch_day_minute_df(
            symbol=index_code,
            target_date=event_date,
            market_div_code=INDEX_MARKET_DIV_CODE,
        )
        if index_df.empty and INDEX_MARKET_DIV_CODE != "J":
            index_df = self._fetch_day_minute_df(
                symbol=index_code,
                target_date=event_date,
                market_div_code="J",
            )
        return index_df

    def disable(self, reason: str) -> None:
        self.enabled = False
        self.disabled_reason = reason
        if not self._disable_emitted:
            emit("log", f"[KIS] disabled: {reason}", level="warn")
            self._disable_emitted = True


def is_kis_auth_forbidden_error(exc: Exception) -> bool:
    current: BaseException | None = exc
    while current is not None:
        if isinstance(current, requests.HTTPError):
            status_code = current.response.status_code if current.response is not None else None
            if status_code == 401:
                return True
            if status_code == 403 and current.response is not None:
                body = current.response.text or ""
                if "EGW00133" in body or "1분당 1회" in body:
                    return False
                return True
        current = current.__cause__

    message = str(exc)
    if "EGW00133" in message or "1분당 1회" in message:
        return False
    return "401" in message or "403" in message


def is_kis_token_throttle_error(exc: Exception) -> bool:
    current: BaseException | None = exc
    while current is not None:
        if isinstance(current, requests.HTTPError) and current.response is not None:
            body = current.response.text or ""
            if "EGW00133" in body or "1분당 1회" in body or "잠시 후 다시 시도" in body:
                return True
        current = current.__cause__
    message = str(exc)
    return "EGW00133" in message or "1분당 1회" in message or "잠시 후 다시 시도" in message


def preprocess_minute_df(df: pd.DataFrame) -> pd.DataFrame:
    required_out = ["timestamp", "open", "high", "low", "close", "volume", "buy_vol", "sell_vol"]
    if df.empty:
        return pd.DataFrame(columns=required_out)

    df = df.copy()
    if "timestamp" not in df.columns:
        return pd.DataFrame(columns=required_out)

    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    df = df.dropna(subset=["timestamp"])
    if df.empty:
        return pd.DataFrame(columns=required_out)

    df = df.sort_values("timestamp")
    # 요구사항: 타임스탬프 중복 제거
    df = df.drop_duplicates(subset=["timestamp"], keep="first")

    # 내부 계산용 누적 컬럼까지 포함해 숫자형 변환을 통일한다.
    numeric_cols = ["open", "high", "low", "close", "volume", "buy_vol", "sell_vol", "buy_cum", "sell_cum"]
    for col in numeric_cols:
        if col not in df.columns:
            df[col] = math.nan
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # 누적 매수/매도만 있을 때는 1분 차분으로 minute buy/sell을 구성한다.
    if df["buy_vol"].isna().all() and df["buy_cum"].notna().any():
        buy_diff = df["buy_cum"].diff()
        if not buy_diff.empty:
            buy_diff.iloc[0] = df["buy_cum"].iloc[0]
        df["buy_vol"] = buy_diff
    if df["sell_vol"].isna().all() and df["sell_cum"].notna().any():
        sell_diff = df["sell_cum"].diff()
        if not sell_diff.empty:
            sell_diff.iloc[0] = df["sell_cum"].iloc[0]
        df["sell_vol"] = sell_diff

    # 요구사항: 결측치는 직전값으로 보간(ffill) 후 남는 값은 0으로 보정한다.
    fill_cols = ["open", "high", "low", "close", "volume", "buy_vol", "sell_vol"]
    df[fill_cols] = df[fill_cols].ffill().fillna(0.0)
    for col in ["volume", "buy_vol", "sell_vol"]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0).clip(lower=0.0)

    return df[required_out].reset_index(drop=True)


def hhmmss_minus_one_second(hhmmss: str) -> str:
    token = str(hhmmss or "").strip()
    if len(token) != 6 or not token.isdigit():
        return "090000"
    h = int(token[0:2])
    m = int(token[2:4])
    s = int(token[4:6])
    total = h * 3600 + m * 60 + s
    total = max(0, total - 1)
    hh = total // 3600
    mm = (total % 3600) // 60
    ss = total % 60
    return f"{hh:02d}{mm:02d}{ss:02d}"


_PREV_TRADING_DAY_CACHE: dict[dt.date, dt.date | None] = {}


def resolve_previous_trading_day(event_date: dt.date) -> dt.date | None:
    if event_date in _PREV_TRADING_DAY_CACHE:
        return _PREV_TRADING_DAY_CACHE[event_date]

    # 요구사항: 휴장 캘린더(거래소 영업일) 기준으로 "직전 영업일 1일"을 계산한다.
    prev_day: dt.date | None = None
    if pykrx_stock is not None:
        try:
            from_ymd = (event_date - dt.timedelta(days=PREV_TRADING_DAY_LOOKBACK_DAYS)).strftime("%Y%m%d")
            to_ymd = event_date.strftime("%Y%m%d")
            business_days = pykrx_stock.get_previous_business_days(fromdate=from_ymd, todate=to_ymd)
            candidates: list[dt.date] = []
            for token in business_days or []:
                day = pd.to_datetime(token, errors="coerce")
                if pd.isna(day):
                    continue
                d = day.date()
                if d < event_date:
                    candidates.append(d)
            if candidates:
                prev_day = max(candidates)
        except Exception as exc:
            emit("log", f"[CAL] previous business day resolve failed date={event_date}: {exc}", level="warn")

    # 캘린더 소스 불가 시 최소한의 안전장치(주말 제외)로 다운그레이드한다.
    if prev_day is None:
        for day_offset in range(1, 10):
            d = event_date - dt.timedelta(days=day_offset)
            if d.weekday() < 5:
                prev_day = d
                break

    _PREV_TRADING_DAY_CACHE[event_date] = prev_day
    return prev_day


def to_float(value: Any) -> float:
    token = str(value or "").replace(",", "").strip()
    if not token:
        return 0.0
    try:
        return float(token)
    except Exception:
        return 0.0


BUY_VOL_KEYS = (
    "cntg_buy_vol",
    "buy_cntg_vol",
    "buy_vol",
    "tday_buy_qty",
)
SELL_VOL_KEYS = (
    "cntg_sell_vol",
    "sell_cntg_vol",
    "sell_vol",
    "tday_sell_qty",
)
BUY_CUM_KEYS = (
    "acml_buy_cntg_vol",
    "acml_buy_vol",
    "acml_buy_qty",
    "acml_buy_tr_qty",
)
SELL_CUM_KEYS = (
    "acml_sell_cntg_vol",
    "acml_sell_vol",
    "acml_sell_qty",
    "acml_sell_tr_qty",
)


def to_optional_float(value: Any) -> float | None:
    if value is None:
        return None
    token = str(value).replace(",", "").strip()
    if not token:
        return None
    try:
        val = float(token)
    except Exception:
        return None
    if math.isnan(val):
        return None
    return val


def pick_first_optional_float(item: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for key in keys:
        if key not in item:
            continue
        parsed = to_optional_float(item.get(key))
        if parsed is not None:
            return parsed
    return None


def parse_kis_minute_row(item: dict[str, Any], ymd: str) -> dict[str, Any] | None:
    d = str(item.get("stck_bsop_date", "")).strip()
    t = str(item.get("stck_cntg_hour", "")).strip()[:6]
    if len(d) != 8 or len(t) != 6 or d != ymd:
        return None
    try:
        ts = dt.datetime.strptime(d + t, "%Y%m%d%H%M%S")
    except ValueError:
        return None

    buy_vol = pick_first_optional_float(item, BUY_VOL_KEYS)
    sell_vol = pick_first_optional_float(item, SELL_VOL_KEYS)
    buy_cum = pick_first_optional_float(item, BUY_CUM_KEYS)
    sell_cum = pick_first_optional_float(item, SELL_CUM_KEYS)

    return {
        "timestamp": ts,
        "open": to_float(item.get("stck_oprc")),
        "high": to_float(item.get("stck_hgpr")),
        "low": to_float(item.get("stck_lwpr")),
        "close": to_float(item.get("stck_prpr")),
        "volume": to_float(item.get("cntg_vol")),
        "buy_vol": buy_vol if buy_vol is not None else math.nan,
        "sell_vol": sell_vol if sell_vol is not None else math.nan,
        "buy_cum": buy_cum if buy_cum is not None else math.nan,
        "sell_cum": sell_cum if sell_cum is not None else math.nan,
    }


def index_code_for_market(market: str) -> str:
    token = str(market or "").strip().upper()
    if token == "KOSDAQ":
        return "1001"
    return "0001"


def get_market_symbols(exclude_keywords: list[str]) -> pd.DataFrame:
    listing = fetch_market_listing_df()
    if listing.empty:
        return listing

    listing = listing.copy()
    if "Symbol" in listing.columns:
        listing["Symbol"] = listing["Symbol"].map(to_symbol)
    else:
        listing["Symbol"] = ""
    listing = listing[listing["Symbol"].str.match(r"^[A-Z0-9]{6}$", na=False)]

    if "Market" in listing.columns:
        listing = listing[listing["Market"].isin(["KOSPI", "KOSDAQ"])]

    name_col = "Name" if "Name" in listing.columns else None
    if name_col:
        listing[name_col] = listing[name_col].astype(str)
        mask = pd.Series(True, index=listing.index)
        for keyword in exclude_keywords:
            mask &= ~listing[name_col].str.contains(keyword, case=False, na=False)
        listing = listing[mask]

    listing = listing.drop_duplicates(subset=["Symbol"], keep="first")
    listing = listing.sort_values("Symbol")
    return listing.reset_index(drop=True)


def fetch_market_listing_df() -> pd.DataFrame:
    if fdr is not None:
        try:
            listing = fdr.StockListing("KRX")
            if listing is not None and not listing.empty:
                return listing
            emit("log", "[FDR] StockListing('KRX') empty, fallback to pykrx", level="warn")
        except Exception as exc:
            emit("log", f"[FDR] StockListing('KRX') failed: {exc}", level="warn")

    if pykrx_stock is not None:
        try:
            listing = fetch_market_listing_with_pykrx()
            if listing is not None and not listing.empty:
                return listing
            emit("log", "[PYKRX] listing empty", level="warn")
        except Exception as exc:
            emit("log", f"[PYKRX] listing failed: {exc}", level="warn")

    try:
        listing = fetch_market_listing_with_kind()
        if listing is not None and not listing.empty:
            return listing
        emit("log", "[KIND] listing empty", level="warn")
    except Exception as exc:
        emit("log", f"[KIND] listing failed: {exc}", level="warn")

    raise RuntimeError(
        "종목 마스터 리스트 수집 실패(FDR/PYKRX/KIND). "
        "네트워크/접속 제한 또는 데이터 소스 응답 상태를 확인하세요."
    )


def fetch_market_listing_with_pykrx() -> pd.DataFrame:
    if pykrx_stock is None:
        return pd.DataFrame()

    for day_offset in range(0, 14):
        rows: list[dict[str, str]] = []
        ymd = (dt.date.today() - dt.timedelta(days=day_offset)).strftime("%Y%m%d")
        for market in ("KOSPI", "KOSDAQ"):
            tickers = pykrx_stock.get_market_ticker_list(date=ymd, market=market)
            for symbol in tickers:
                rows.append(
                    {
                        "Symbol": to_symbol(symbol),
                        "Name": str(pykrx_stock.get_market_ticker_name(symbol) or ""),
                        "Market": market,
                    }
                )
        if rows:
            emit("log", f"[PYKRX] listing date={ymd} rows={len(rows)}", level="info")
            return pd.DataFrame(rows)

    return pd.DataFrame()


def fetch_market_listing_with_kind() -> pd.DataFrame:
    market_map = {
        "stockMkt": "KOSPI",
        "kosdaqMkt": "KOSDAQ",
    }
    rows: list[dict[str, str]] = []
    session = requests.Session()

    for market_type, market_name in market_map.items():
        url = f"https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&marketType={market_type}"
        response = session.get(url, timeout=KIS_TIMEOUT_SEC, headers={"User-Agent": "Mozilla/5.0"})
        response.raise_for_status()

        tables = pd.read_html(io.StringIO(response.text))
        if not tables:
            continue
        df = tables[0].copy()

        symbol_col = "종목코드" if "종목코드" in df.columns else None
        name_col = "회사명" if "회사명" in df.columns else None
        if not symbol_col or not name_col:
            continue

        for _, row in df.iterrows():
            rows.append(
                {
                    "Symbol": to_symbol(row.get(symbol_col)),
                    "Name": str(row.get(name_col) or "").strip(),
                    "Market": market_name,
                }
            )

    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows)


def fetch_daily_df_with_fdr(symbol: str, start_date: dt.date, end_date: dt.date) -> pd.DataFrame:
    if fdr is None:
        return fetch_daily_df_with_pykrx(symbol, start_date, end_date)
    try:
        time.sleep(REQUEST_DELAY_SEC)
        df = fdr.DataReader(symbol, start_date, end_date)
        if df is None or df.empty:
            return pd.DataFrame()
        df = df.reset_index()
        if "Date" not in df.columns and "index" in df.columns:
            df = df.rename(columns={"index": "Date"})
        df["Date"] = pd.to_datetime(df["Date"], errors="coerce").dt.date
        df = df.dropna(subset=["Date"])
        required = ["Open", "High", "Low", "Close", "Volume"]
        for col in required:
            if col not in df.columns:
                df[col] = 0.0
        df = df[["Date", "Open", "High", "Low", "Close", "Volume"]]
        df = df.sort_values("Date")
        df = df.drop_duplicates(subset=["Date"], keep="first")
        return df
    except Exception as exc:
        emit("log", f"[FDR] daily failed symbol={symbol}: {exc}", level="warn")
        return pd.DataFrame()


def fetch_daily_df_with_pykrx(symbol: str, start_date: dt.date, end_date: dt.date) -> pd.DataFrame:
    if pykrx_stock is None:
        emit("log", f"[PYKRX] pykrx 모듈 없음 symbol={symbol}", level="warn")
        return pd.DataFrame()
    try:
        time.sleep(REQUEST_DELAY_SEC)
        df = pykrx_stock.get_market_ohlcv_by_date(
            fromdate=start_date.strftime("%Y%m%d"),
            todate=end_date.strftime("%Y%m%d"),
            ticker=symbol,
        )
        if df is None or df.empty:
            return pd.DataFrame()
        df = df.reset_index()
        df = df.rename(
            columns={
                "날짜": "Date",
                "시가": "Open",
                "고가": "High",
                "저가": "Low",
                "종가": "Close",
                "거래량": "Volume",
            }
        )
        df["Date"] = pd.to_datetime(df["Date"], errors="coerce").dt.date
        df = df.dropna(subset=["Date"])
        required = ["Open", "High", "Low", "Close", "Volume"]
        for col in required:
            if col not in df.columns:
                df[col] = 0.0
        df = df[["Date", "Open", "High", "Low", "Close", "Volume"]]
        df = df.sort_values("Date")
        df = df.drop_duplicates(subset=["Date"], keep="first")
        return df
    except Exception as exc:
        emit("log", f"[PYKRX] daily failed symbol={symbol}: {exc}", level="warn")
        return pd.DataFrame()


def extract_daily_events(symbol: str, daily_df: pd.DataFrame) -> list[EventCandidate]:
    if daily_df.empty or len(daily_df) < 2:
        return []

    required = ["Date", "High", "Low", "Volume"]
    if any(col not in daily_df.columns for col in required):
        emit("log", f"[EVENT] {symbol} 일봉 컬럼 누락으로 이벤트 추출 불가", level="warn")
        return []

    df = daily_df.copy()
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce").dt.date
    df = df.dropna(subset=["Date"])
    for col in ["High", "Low", "Volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["High", "Low", "Volume"])
    df = df.sort_values("Date")
    df = df.drop_duplicates(subset=["Date"], keep="first")

    # 요구사항: 장중 진폭(%) 컬럼 추가
    df["amplitude"] = (((df["High"] - df["Low"]) / df["Low"]) * 100.0).where(df["Low"] > 0)
    # 요구사항: 거래량 20일 이동평균(min_periods=1)과 직전일 기준값 계산
    df["vol_ma20"] = df["Volume"].rolling(window=20, min_periods=1).mean()
    df["vol_ma20_prev"] = df["vol_ma20"].shift(1)

    filtered = df[
        (df["amplitude"] >= EVENT_MIN_AMPLITUDE_PCT)
        & (df["vol_ma20_prev"] > 0)
        & (df["Volume"] >= (df["vol_ma20_prev"] * EVENT_MIN_VOLUME_BURST_MULTIPLE))
    ]
    if filtered.empty:
        return []

    events: list[EventCandidate] = []
    for row in filtered.itertuples(index=False):
        # 요구사항: 이벤트 클래스는 모두 CLASS_VOLATILE로 고정
        events.append(
            EventCandidate(
                symbol=symbol,
                klass="CLASS_VOLATILE",
                event_date=row.Date,
                pct_change=float(row.amplitude),
            )
        )
    return events


def find_event_start_index(minute_df: pd.DataFrame, klass: str) -> int:
    if minute_df.empty:
        return -1
    if klass == "CLASS_A":
        idx = int(minute_df["high"].idxmax())
    else:
        idx = int(minute_df["low"].idxmin())
    return idx


def cut_window_before_event(minute_df: pd.DataFrame, event_idx: int, window: int = WINDOW_MINUTES) -> pd.DataFrame:
    if minute_df.empty or event_idx < 0:
        return pd.DataFrame()
    start = max(0, event_idx - window)
    out = minute_df.iloc[start:event_idx].copy()
    out = preprocess_minute_df(out)
    return out


def minmax_scale(series: np.ndarray) -> np.ndarray:
    if np is None:
        raise RuntimeError("numpy 모듈이 없어 벡터화를 수행할 수 없습니다.")
    s_min = float(np.min(series))
    s_max = float(np.max(series))
    if math.isclose(s_min, s_max, rel_tol=1e-9, abs_tol=1e-9):
        return np.zeros_like(series, dtype=np.float32)
    return ((series - s_min) / (s_max - s_min)).astype(np.float32)


def vectorize_ohlvc(minute_window_df: pd.DataFrame, dim: int) -> list[float]:
    if np is None:
        raise RuntimeError("numpy 모듈이 없어 벡터화를 수행할 수 없습니다.")
    if minute_window_df.empty:
        return [0.0] * dim

    df = preprocess_minute_df(minute_window_df)
    if df.empty:
        return [0.0] * dim

    arr = df[["open", "high", "low", "close", "volume"]].astype("float32").to_numpy()

    if arr.shape[0] < WINDOW_MINUTES:
        pad = np.repeat(arr[-1:, :], repeats=WINDOW_MINUTES - arr.shape[0], axis=0)
        arr = np.concatenate([arr, pad], axis=0)
    arr = arr[-WINDOW_MINUTES:, :]

    features = [minmax_scale(arr[:, i]) for i in range(arr.shape[1])]
    flat = np.concatenate(features, axis=0).astype(np.float32)  # 30 * 5 = 150

    x_old = np.linspace(0.0, 1.0, num=flat.shape[0], dtype=np.float32)
    x_new = np.linspace(0.0, 1.0, num=dim, dtype=np.float32)
    vec = np.interp(x_new, x_old, flat).astype(np.float32)
    return vec.tolist()


def build_pattern_id(klass: str, symbol: str, minute_ts: dt.datetime) -> str:
    return f"{klass}_{symbol}_{minute_ts.strftime('%Y%m%d_%H%M')}"


def read_oracle_env() -> tuple[str, str, str]:
    user = os.getenv("ORACLE_USER", "").strip()
    password = os.getenv("ORACLE_PASSWORD", "").strip()
    connect_string = os.getenv("ORACLE_CONNECTION_STRING", "").strip()
    if not user or not password or not connect_string:
        raise RuntimeError("ORACLE_USER / ORACLE_PASSWORD / ORACLE_CONNECTION_STRING 필수")
    return user, password, connect_string


def fetch_existing_symbols_from_db() -> set[str]:
    if oracledb is None:
        raise RuntimeError("oracledb 모듈이 없어 DB 조회를 사용할 수 없습니다.")
    user, password, connect_string = read_oracle_env()
    symbols: set[str] = set()
    with oracledb.connect(user=user, password=password, dsn=connect_string) as conn:
        with conn.cursor() as cur:
            cur.execute("select distinct symbol from TB_ZONE3_PATTERN_LIBRARY where symbol is not null")
            for row in cur:
                if not row:
                    continue
                symbol = to_symbol(row[0])
                if symbol:
                    symbols.add(symbol)
    return symbols


def upsert_patterns(records: list[PatternRecord]) -> int:
    if not records:
        return 0
    if oracledb is None:
        raise RuntimeError("oracledb 모듈이 없어 DB 적재를 사용할 수 없습니다.")

    user, password, connect_string = read_oracle_env()
    merged = 0
    with oracledb.connect(user=user, password=password, dsn=connect_string) as conn:
        with conn.cursor() as cur:
            sql = """
                merge into TB_ZONE3_PATTERN_LIBRARY tgt
                using (
                    select
                        :pattern_id as pattern_id,
                        :klass as klass,
                        :symbol as symbol,
                        :pattern_vector as pattern_vector,
                        :sample_ohlvc_json as sample_ohlvc_json
                    from dual
                ) src
                on (tgt.pattern_id = src.pattern_id)
                when matched then
                    update set
                        tgt.klass = src.klass,
                        tgt.symbol = src.symbol,
                        tgt.pattern_vector = src.pattern_vector,
                        tgt.sample_ohlvc_json = src.sample_ohlvc_json,
                        tgt.updated_at = systimestamp
                when not matched then
                    insert (pattern_id, klass, symbol, pattern_vector, sample_ohlvc_json, created_at, updated_at)
                    values (src.pattern_id, src.klass, src.symbol, src.pattern_vector, src.sample_ohlvc_json, systimestamp, systimestamp)
            """
            for rec in records:
                try:
                    cur.execute(
                        sql,
                        pattern_id=rec.pattern_id,
                        klass=rec.klass,
                        symbol=rec.symbol,
                        pattern_vector=rec.pattern_vector,
                        sample_ohlvc_json=rec.sample_ohlvc_json,
                    )
                    merged += 1
                except Exception as exc:
                    emit("log", f"[DB] merge failed pattern_id={rec.pattern_id}: {exc}", level="warn")
                    continue
        conn.commit()
    return merged


def iter_symbols(listing_df: pd.DataFrame, limit: int) -> Iterable[tuple[int, int, str, str]]:
    total = min(limit, len(listing_df))
    for idx, row in enumerate(listing_df.head(total).itertuples(index=False), start=1):
        symbol = to_symbol(getattr(row, "Symbol", ""))
        name = str(getattr(row, "Name", "")).strip()
        if not symbol:
            continue
        yield idx, total, symbol, name


def load_or_fetch_daily(symbol: str, start_date: dt.date, end_date: dt.date, kis: KisClient) -> pd.DataFrame:
    cached = load_daily_raw(symbol)
    if not cached.empty:
        # 로컬 CSV 캐시가 이미 존재하면 전기간 데이터를 그대로 활용한다.
        return cached

    if kis.enabled:
        df = kis.fetch_daily_df(symbol, start_date, end_date)
        if not df.empty:
            save_daily_raw(symbol, df)
            if not SIMPLE_LOG:
                emit("log", f"[RAW] daily saved symbol={symbol} path={daily_raw_path(symbol)}", level="info")
            return load_daily_raw(symbol)

    df = fetch_daily_df_with_fdr(symbol, start_date, end_date)
    if not df.empty:
        save_daily_raw(symbol, df)
        if not SIMPLE_LOG:
            emit("log", f"[RAW] daily saved symbol={symbol} path={daily_raw_path(symbol)}", level="info")
        return load_daily_raw(symbol)

    return pd.DataFrame()


def load_or_fetch_index(index_code: str, event_date: dt.date, kis: KisClient) -> pd.DataFrame:
    cached = load_index_raw(index_code, event_date)
    if (
        not cached.empty
        and len(cached) >= MINUTE_MIN_ACCEPTED_ROWS
        and csv_has_columns(index_raw_path(index_code, event_date), {"buy_vol", "sell_vol"})
    ):
        return cached

    if not kis.enabled:
        return pd.DataFrame()

    index_df = kis.fetch_index_day_minutes(index_code, event_date)
    if index_df.empty:
        return pd.DataFrame()

    save_index_raw(index_code, event_date, index_df)
    if not SIMPLE_LOG:
        emit(
            "log",
            f"[RAW] index saved code={index_code} date={event_date} path={index_raw_path(index_code, event_date)}",
            level="info",
        )
    return load_index_raw(index_code, event_date)


def load_or_fetch_minute(
    symbol: str,
    event_date: dt.date,
    kis: KisClient,
    *,
    market: str,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    cached = load_minute_raw(symbol, event_date)
    # 캐시가 있어도 너무 짧으면 과거분봉이 잘린 것으로 보고 재수집해 완전한 데이터를 확보한다.
    minute_cache_path = minute_raw_path(symbol, event_date)
    has_buy_sell_cols = csv_has_columns(minute_cache_path, {"buy_vol", "sell_vol"})
    ts = pd.to_datetime(cached.get("timestamp"), errors="coerce") if not cached.empty else pd.Series(dtype="datetime64[ns]")
    ts_non_null = ts.dropna()
    prev_ts = ts_non_null[ts_non_null.dt.date < event_date]
    prev_span_ok = False
    if not prev_ts.empty:
        span = prev_ts.max() - prev_ts.min()
        prev_span_ok = span <= dt.timedelta(minutes=PREV_TRADING_DAY_TAIL_MINUTES + 1)
    expected_prev_date = resolve_previous_trading_day(event_date)
    has_expected_prev_date = bool(
        expected_prev_date is not None and (prev_ts.dt.date == expected_prev_date).any()
    )
    has_prev_tail = bool(not prev_ts.empty and prev_span_ok and has_expected_prev_date)
    if not cached.empty and len(cached) >= MINUTE_MIN_ACCEPTED_ROWS and has_buy_sell_cols and has_prev_tail:
        minute_df = cached
    else:
        if not kis.enabled:
            return pd.DataFrame(), pd.DataFrame()

        # 요구사항: 이벤트 발생일(event_date) + 전일 말미 구간까지 함께 수집한다.
        minute_df = kis.fetch_event_day_minutes(symbol, event_date)
        if minute_df.empty:
            return pd.DataFrame(), pd.DataFrame()

        save_minute_raw(symbol, event_date, minute_df)
        if not SIMPLE_LOG:
            emit("log", f"[RAW] minute saved symbol={symbol} date={event_date} path={minute_raw_path(symbol, event_date)}", level="info")
        minute_df = load_minute_raw(symbol, event_date)

    # 요구사항: 종목 분봉과 같은 날짜의 시장 지수 분봉도 동기화해 저장한다.
    index_code = index_code_for_market(market)
    index_df = load_or_fetch_index(index_code, event_date, kis)
    return minute_df, index_df


def sync_raw_data(
    *,
    listing: pd.DataFrame,
    kis: KisClient,
    start_date: dt.date,
    end_date: dt.date,
    symbol_limit: int,
    max_events_per_symbol: int,
) -> None:
    market_by_symbol: dict[str, str] = {}
    if "Symbol" in listing.columns and "Market" in listing.columns:
        for row in listing[["Symbol", "Market"]].itertuples(index=False):
            symbol_key = to_symbol(getattr(row, "Symbol", ""))
            market_val = str(getattr(row, "Market", "") or "").strip().upper()
            if symbol_key:
                market_by_symbol[symbol_key] = market_val

    for idx, total, symbol, name in iter_symbols(listing, symbol_limit):
        target_count = 0
        minute_saved = 0
        market = market_by_symbol.get(symbol, "KOSPI")
        daily_df = load_or_fetch_daily(symbol, start_date, end_date, kis)
        if daily_df.empty:
            log_status_line(idx=idx, total=total, symbol=symbol, name=name, target_count=target_count, received_count=minute_saved)
            continue
        events = extract_daily_events(symbol, daily_df)

        if not events:
            log_status_line(idx=idx, total=total, symbol=symbol, name=name, target_count=target_count, received_count=minute_saved)
            continue

        events = sorted(events, key=lambda e: abs(e.pct_change), reverse=True)
        # 요구사항: max-events-per-symbol <= 0 이면 이벤트 개수 제한을 적용하지 않는다.
        if max_events_per_symbol > 0:
            events = events[:max_events_per_symbol]
        target_count = len(events)

        if not kis.enabled:
            log_status_line(
                idx=idx,
                total=total,
                symbol=symbol,
                name=name,
                target_count=target_count,
                received_count=minute_saved,
            )
            continue

        # 종목별 대상 개수만 먼저 로그 후, 최종 합산 결과로 성공/실패를 보여준다.
        minute_saved = 0
        for event in events:
            minute_df, index_df = load_or_fetch_minute(symbol, event.event_date, kis, market=market)
            if not minute_df.empty and not index_df.empty:
                minute_saved += 1

        log_status_line(
            idx=idx,
            total=total,
            symbol=symbol,
            name=name,
            target_count=target_count,
            received_count=minute_saved,
        )


def transform_and_upsert(
    *,
    listing: pd.DataFrame,
    symbol_limit: int,
    max_events_per_symbol: int,
    vector_dim: int,
) -> tuple[int, int, int, int]:
    records: list[PatternRecord] = []
    total_generated = 0
    total_merged = 0
    class_a = 0
    class_c = 0

    def flush_batch(force: bool = False) -> None:
        nonlocal total_merged
        if not records:
            return
        if not force and len(records) < UPSERT_BATCH_SIZE:
            return

        merged = upsert_patterns(records)
        total_merged += merged
        emit(
            "log",
            f"[DB] batch upsert requested={len(records)} merged={merged} total_merged={total_merged}",
            level="info",
        )
        records.clear()

    for idx, total, symbol, name in iter_symbols(listing, symbol_limit):
        emit("log", f"[TRANSFORM {idx}/{total}] {symbol} {name}", level="info")

        daily_df = load_daily_raw(symbol)
        if daily_df.empty:
            emit("log", f"[TRANSFORM] {symbol} 일봉 raw 없음, skip", level="warn")
            continue

        events = extract_daily_events(symbol, daily_df)
        if not events:
            continue

        events = sorted(events, key=lambda e: abs(e.pct_change), reverse=True)
        if max_events_per_symbol > 0:
            events = events[:max_events_per_symbol]

        for event in events:
            minute_df = load_minute_raw(symbol, event.event_date)
            if minute_df.empty:
                emit("log", f"[TRANSFORM] {symbol} {event.event_date} 분봉 raw 없음, skip", level="warn")
                continue

            start_idx = find_event_start_index(minute_df, event.klass)
            if start_idx <= 0:
                continue

            window_df = cut_window_before_event(minute_df, start_idx, WINDOW_MINUTES)
            if window_df.empty:
                continue

            event_row = minute_df.iloc[start_idx]
            event_ts = pd.to_datetime(event_row["timestamp"]).to_pydatetime()
            vector = vectorize_ohlvc(window_df, vector_dim)
            pattern_id = build_pattern_id(event.klass, symbol, event_ts)

            sample_json = json.dumps(
                [
                    {
                        "timestamp": pd.to_datetime(r.timestamp).isoformat(),
                        "open": float(r.open),
                        "high": float(r.high),
                        "low": float(r.low),
                        "close": float(r.close),
                        "volume": float(r.volume),
                    }
                    for r in window_df.itertuples(index=False)
                ],
                ensure_ascii=False,
            )

            records.append(
                PatternRecord(
                    pattern_id=pattern_id,
                    klass=event.klass,
                    symbol=symbol,
                    pattern_vector=vector,
                    sample_ohlvc_json=sample_json,
                )
            )
            total_generated += 1
            if event.klass == "CLASS_A":
                class_a += 1
            elif event.klass == "CLASS_C":
                class_c += 1

            flush_batch(force=False)

    flush_batch(force=True)
    return total_generated, total_merged, class_a, class_c


def run() -> None:
    parser = argparse.ArgumentParser(description="Zone3 data-lake miner")
    parser.add_argument("--symbol-limit", type=int, default=int(os.getenv("ZONE3_MINE_SYMBOL_LIMIT", "2000")))
    parser.add_argument(
        "--max-events-per-symbol",
        type=int,
        default=int(os.getenv("ZONE3_MINE_MAX_EVENTS_PER_SYMBOL", "0")),
        help="종목당 이벤트 상한(0 또는 음수면 제한 없음)",
    )
    parser.add_argument("--exclude-keywords", default="ETF,ETN,스팩,SPAC,우선주,우B,우C,리츠")
    args = parser.parse_args()

    ensure_raw_dirs()
    run_log_path = resolve_run_log_path()

    today = dt.date.today()
    start_date = today - dt.timedelta(days=LOOKBACK_DAYS)
    end_date = today

    exclude_keywords = [token.strip() for token in str(args.exclude_keywords).split(",") if token.strip()]
    listing = get_market_symbols(exclude_keywords=exclude_keywords)
    if listing.empty:
        raise RuntimeError("종목 마스터 리스트 수집 실패(FDR/PYKRX/KIND)")

    http = HttpClient()
    kis = KisClient(http=http)

    emit(
        "status",
        "Zone3 raw 수집 시작",
        running=True,
        progress=0,
        start_date=str(start_date),
        end_date=str(end_date),
        symbols_total=min(args.symbol_limit, len(listing)),
        raw_base_dir=str(RAW_BASE_DIR.resolve()),
        log_file=str(run_log_path) if run_log_path is not None else "",
        lookback_days=LOOKBACK_DAYS,
        kis_enabled=kis.enabled,
        minute_timeout_sec=MINUTE_TIMEOUT_SEC,
        minute_retry_max_attempts=MINUTE_RETRY_MAX_ATTEMPTS,
        minute_backoff_min_sec=MINUTE_BACKOFF_MIN_SEC,
        minute_backoff_max_sec=MINUTE_BACKOFF_MAX_SEC,
        max_minute_fail_streak_per_symbol=MAX_MINUTE_FAIL_STREAK_PER_SYMBOL,
        mode="raw_only",
    )

    sync_raw_data(
        listing=listing,
        kis=kis,
        start_date=start_date,
        end_date=end_date,
        symbol_limit=args.symbol_limit,
        max_events_per_symbol=args.max_events_per_symbol,
    )

    # 요구사항: 현재 단계는 Raw CSV 수집기 역할만 수행하고 종료한다.
    emit(
        "completed",
        "Zone3 raw 수집 완료",
        running=False,
        progress=100,
        processed_symbols=min(args.symbol_limit, len(listing)),
        inserted=0,
        log_file=str(run_log_path) if run_log_path is not None else "",
        mode="raw_only",
    )


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:
        emit("error", f"Zone3 마이닝 실패: {exc}", running=False, progress=100)
        raise
