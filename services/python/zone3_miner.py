from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import math
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import oracledb
import pandas as pd
import requests
try:
    import FinanceDataReader as fdr
except ModuleNotFoundError:
    fdr = None

try:
    from pykrx import stock as pykrx_stock
except ModuleNotFoundError:
    pykrx_stock = None


ZONE3_VECTOR_DIM = max(128, int(os.getenv("ZONE3_VECTOR_DIM", "1024")))
KIS_TIMEOUT_SEC = max(3, int(os.getenv("ZONE3_KIS_TIMEOUT_SEC", "10")))
REQUEST_DELAY_SEC = max(0.2, float(os.getenv("ZONE3_MINE_REQUEST_DELAY_SEC", "0.2")))
RETRY_MAX_ATTEMPTS = max(2, int(os.getenv("ZONE3_MINE_RETRY_MAX_ATTEMPTS", "5")))
BACKOFF_MIN_SEC = max(10.0, float(os.getenv("ZONE3_MINE_BACKOFF_MIN_SEC", "10")))
BACKOFF_MAX_SEC = max(BACKOFF_MIN_SEC, float(os.getenv("ZONE3_MINE_BACKOFF_MAX_SEC", "30")))
EVENT_UP_PCT = 15.0
EVENT_DOWN_PCT = -10.0
WINDOW_MINUTES = 30
UPSERT_BATCH_SIZE = max(1, int(os.getenv("ZONE3_UPSERT_BATCH_SIZE", "100")))
RAW_BASE_DIR = Path(os.getenv("ZONE3_RAW_BASE_DIR", "data/zone3/raw"))
RAW_DAILY_DIR = RAW_BASE_DIR / "daily"
RAW_MINUTE_DIR = RAW_BASE_DIR / "minute"
TOKEN_THROTTLE_WAIT_SEC = max(10, int(os.getenv("KIS_TOKEN_THROTTLE_WAIT_SEC", "60")))


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


def emit(event_type: str, message: str, **extra: Any) -> None:
    payload: dict[str, Any] = {
        "type": event_type,
        "message": message,
        "timestamp": dt.datetime.now(dt.UTC).isoformat()
    }
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False), flush=True)


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


def daily_raw_path(symbol: str) -> Path:
    return RAW_DAILY_DIR / f"{symbol}.csv"


def minute_raw_path(symbol: str, event_date: dt.date) -> Path:
    return RAW_MINUTE_DIR / symbol / f"{event_date.strftime('%Y%m%d')}.csv"


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
    out = out[["timestamp", "open", "high", "low", "close", "volume"]]
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

    required = ["timestamp", "open", "high", "low", "close", "volume"]
    for col in required:
        if col not in df.columns:
            df[col] = 0.0 if col != "timestamp" else ""
    return preprocess_minute_df(df)


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
    ) -> dict[str, Any]:
        last_exc: Exception | None = None
        for attempt in range(1, RETRY_MAX_ATTEMPTS + 1):
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
                if attempt >= RETRY_MAX_ATTEMPTS:
                    break
                if isinstance(exc, requests.HTTPError) and exc.response is not None and exc.response.status_code < 429:
                    break

                wait = min(BACKOFF_MAX_SEC, BACKOFF_MIN_SEC * (2 ** (attempt - 1)))
                wait = max(BACKOFF_MIN_SEC, wait)
                emit(
                    "log",
                    f"[retry] {retry_context} attempt={attempt}/{RETRY_MAX_ATTEMPTS} wait={wait:.1f}s",
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

    def fetch_event_day_minutes(self, symbol: str, event_date: dt.date) -> pd.DataFrame:
        if not self.enabled:
            return pd.DataFrame()

        try:
            # 참고: API 특성상 과거일 지원이 제한될 수 있어 반환 데이터에서 event_date만 필터링한다.
            data = self.http.request_json(
                method="GET",
                url=f"{self.rest_url}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice",
                headers=self._headers("FHKST03010200"),
                params={
                    "FID_ETC_CLS_CODE": "",
                    "FID_COND_MRKT_DIV_CODE": "J",
                    "FID_INPUT_ISCD": symbol,
                    "FID_INPUT_HOUR_1": "153000",
                    "FID_PW_DATA_INCU_YN": "Y",
                },
                retry_context=f"kis:minute:{symbol}",
            )
        except Exception as exc:
            emit("log", f"[KIS] minute failed symbol={symbol}: {exc}", level="warn")
            return pd.DataFrame()

        rows: list[dict[str, Any]] = []
        for item in data.get("output2") or data.get("output") or []:
            d = str(item.get("stck_bsop_date", "")).strip()
            t = str(item.get("stck_cntg_hour", "")).strip()
            if len(d) != 8 or len(t) < 6:
                continue
            ts = dt.datetime.strptime(d + t[:6], "%Y%m%d%H%M%S")
            if ts.date() != event_date:
                continue
            rows.append(
                {
                    "timestamp": ts,
                    "open": to_float(item.get("stck_oprc")),
                    "high": to_float(item.get("stck_hgpr")),
                    "low": to_float(item.get("stck_lwpr")),
                    "close": to_float(item.get("stck_prpr")),
                    "volume": to_float(item.get("cntg_vol")),
                }
            )

        if not rows:
            return pd.DataFrame()

        df = pd.DataFrame(rows)
        return preprocess_minute_df(df)

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
    if df.empty:
        return df
    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    df = df.dropna(subset=["timestamp"])
    df = df.sort_values("timestamp")
    # 요구사항: 타임스탬프 중복 제거
    df = df.drop_duplicates(subset=["timestamp"], keep="first")
    return df.reset_index(drop=True)


def to_float(value: Any) -> float:
    token = str(value or "").replace(",", "").strip()
    if not token:
        return 0.0
    try:
        return float(token)
    except Exception:
        return 0.0


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

    df = daily_df.copy()
    df["prev_close"] = df["Close"].shift(1)
    df = df.dropna(subset=["prev_close"])
    df["high_pct_change"] = ((df["High"] - df["prev_close"]) / df["prev_close"]) * 100.0
    df["low_pct_change"] = ((df["Low"] - df["prev_close"]) / df["prev_close"]) * 100.0

    events: list[EventCandidate] = []
    for row in df.itertuples(index=False):
        high_pct = float(row.high_pct_change)
        low_pct = float(row.low_pct_change)
        if high_pct >= EVENT_UP_PCT:
            events.append(EventCandidate(symbol=symbol, klass="CLASS_A", event_date=row.Date, pct_change=high_pct))
        if low_pct <= EVENT_DOWN_PCT:
            events.append(EventCandidate(symbol=symbol, klass="CLASS_C", event_date=row.Date, pct_change=low_pct))
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
    s_min = float(np.min(series))
    s_max = float(np.max(series))
    if math.isclose(s_min, s_max, rel_tol=1e-9, abs_tol=1e-9):
        return np.zeros_like(series, dtype=np.float32)
    return ((series - s_min) / (s_max - s_min)).astype(np.float32)


def vectorize_ohlvc(minute_window_df: pd.DataFrame, dim: int) -> list[float]:
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
        return cached

    if kis.enabled:
        df = kis.fetch_daily_df(symbol, start_date, end_date)
        if not df.empty:
            save_daily_raw(symbol, df)
            emit("log", f"[RAW] daily saved symbol={symbol} path={daily_raw_path(symbol)}", level="info")
            return load_daily_raw(symbol)

    df = fetch_daily_df_with_fdr(symbol, start_date, end_date)
    if not df.empty:
        save_daily_raw(symbol, df)
        emit("log", f"[RAW] daily saved symbol={symbol} path={daily_raw_path(symbol)}", level="info")
        return load_daily_raw(symbol)

    return pd.DataFrame()


def load_or_fetch_minute(symbol: str, event_date: dt.date, kis: KisClient) -> pd.DataFrame:
    cached = load_minute_raw(symbol, event_date)
    if not cached.empty:
        return cached

    # KIS 분봉 API(FHKST03010200)는 실질적으로 당일 분봉 위주로 반환된다.
    # 캐시가 없는 과거 날짜는 호출해도 빈 결과일 가능성이 높아 API 호출을 생략한다.
    if event_date != dt.date.today():
        return pd.DataFrame()

    if not kis.enabled:
        return pd.DataFrame()

    df = kis.fetch_event_day_minutes(symbol, event_date)
    if df.empty:
        return pd.DataFrame()

    save_minute_raw(symbol, event_date, df)
    emit("log", f"[RAW] minute saved symbol={symbol} date={event_date} path={minute_raw_path(symbol, event_date)}", level="info")
    return load_minute_raw(symbol, event_date)


def sync_raw_data(
    *,
    listing: pd.DataFrame,
    kis: KisClient,
    start_date: dt.date,
    end_date: dt.date,
    symbol_limit: int,
    max_events_per_symbol: int,
) -> None:
    today = dt.date.today()
    for idx, total, symbol, name in iter_symbols(listing, symbol_limit):
        emit("log", f"[SYNC {idx}/{total}] {symbol} {name} raw 수집", level="info")

        daily_df = load_or_fetch_daily(symbol, start_date, end_date, kis)
        if daily_df.empty:
            emit("log", f"[SYNC] {symbol} 일봉 수집 실패/없음", level="warn")
            continue

        events = extract_daily_events(symbol, daily_df)
        if not events:
            continue

        events = sorted(events, key=lambda e: abs(e.pct_change), reverse=True)[: max(1, max_events_per_symbol)]
        if not kis.enabled:
            emit("log", f"[SYNC] {symbol} KIS 비활성화로 분봉 raw 수집 생략", level="warn")
            continue

        minute_saved = 0
        skipped_historical_minute = 0
        for event in events:
            minute_df = load_or_fetch_minute(symbol, event.event_date, kis)
            if not minute_df.empty:
                minute_saved += 1
                continue
            if event.event_date != today and not minute_raw_path(symbol, event.event_date).exists():
                skipped_historical_minute += 1

        if skipped_historical_minute > 0:
            emit(
                "log",
                f"[SYNC] {symbol} 과거 이벤트 {skipped_historical_minute}건은 KIS 분봉 제한(당일 위주)으로 raw 미수집",
                level="warn",
            )
        emit(
            "log",
            f"[SYNC] {symbol} 분봉 raw 저장 {minute_saved}/{len(events)}",
            level="info",
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

        events = sorted(events, key=lambda e: abs(e.pct_change), reverse=True)[: max(1, max_events_per_symbol)]

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
    parser.add_argument("--vector-dim", type=int, default=ZONE3_VECTOR_DIM)
    parser.add_argument("--symbol-limit", type=int, default=int(os.getenv("ZONE3_MINE_SYMBOL_LIMIT", "2000")))
    parser.add_argument("--max-events-per-symbol", type=int, default=int(os.getenv("ZONE3_MINE_MAX_EVENTS_PER_SYMBOL", "6")))
    parser.add_argument("--exclude-keywords", default="ETF,ETN,스팩,SPAC,우선주,우B,우C,리츠")
    args = parser.parse_args()

    ensure_raw_dirs()

    today = dt.date.today()
    start_date = today - dt.timedelta(days=365 * 2)
    end_date = today

    exclude_keywords = [token.strip() for token in str(args.exclude_keywords).split(",") if token.strip()]
    listing = get_market_symbols(exclude_keywords=exclude_keywords)
    if listing.empty:
        raise RuntimeError("종목 마스터 리스트 수집 실패(FDR/PYKRX/KIND)")
    try:
        existing_symbols = fetch_existing_symbols_from_db()
    except Exception as exc:
        emit("log", f"[DB] 기존 적재 종목 조회 실패, 전체 스캔으로 진행: {exc}", level="warn")
        existing_symbols = set()

    if existing_symbols:
        listing = listing[~listing["Symbol"].isin(existing_symbols)].reset_index(drop=True)

    if listing.empty:
        emit(
            "completed",
            "이미 모든 종목이 적재되어 있어 작업할 대상이 없습니다.",
            running=False,
            progress=100,
            inserted=0,
        )
        return

    http = HttpClient()
    kis = KisClient(http=http)

    emit(
        "status",
        "Zone3 마이닝 시작",
        running=True,
        progress=0,
        start_date=str(start_date),
        end_date=str(end_date),
        symbols_total=min(args.symbol_limit, len(listing)),
        resume_skip_symbols=len(existing_symbols),
        raw_base_dir=str(RAW_BASE_DIR.resolve()),
        upsert_batch_size=UPSERT_BATCH_SIZE,
        kis_enabled=kis.enabled,
    )

    sync_raw_data(
        listing=listing,
        kis=kis,
        start_date=start_date,
        end_date=end_date,
        symbol_limit=args.symbol_limit,
        max_events_per_symbol=args.max_events_per_symbol,
    )

    generated, merged, class_a, class_c = transform_and_upsert(
        listing=listing,
        symbol_limit=args.symbol_limit,
        max_events_per_symbol=args.max_events_per_symbol,
        vector_dim=args.vector_dim,
    )

    if generated <= 0:
        emit("completed", "생성된 패턴이 없어 DB 적재를 건너뜀", running=False, progress=100, inserted=0)
        return

    emit(
        "completed",
        f"Zone3 마이닝 완료 records={generated} merged={merged}",
        running=False,
        progress=100,
        processed=generated,
        inserted=merged,
        class_a=class_a,
        class_c=class_c,
    )


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:
        emit("error", f"Zone3 마이닝 실패: {exc}", running=False, progress=100)
        raise
