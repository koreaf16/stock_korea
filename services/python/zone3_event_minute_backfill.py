from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import re
import sys
import threading
import time
from dataclasses import dataclass
from io import StringIO
from pathlib import Path
from typing import Any

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


TR_ID_MINUTE = "FHKST03010230"  # 주식일별분봉조회
TR_ID_DAILY = "FHKST03010100"  # 일봉
DEFAULT_DAYS = 365
DEFAULT_SYMBOL_LIMIT = 2000
DEFAULT_TPS = 0.8
DEFAULT_RETRY = 5
DEFAULT_TIMEOUT_SEC = 15
DEFAULT_LIMIT_COOLDOWN_SEC = 20
DEFAULT_MAX_PAGES = 20
DEFAULT_MARKET_CODE = "J"
PAGE_ROW_LIMIT = 120


@dataclass(frozen=True)
class SymbolInfo:
    symbol: str
    name: str
    market: str


class KisApiError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, rt_cd: str | None = None, msg1: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.rt_cd = rt_cd
        self.msg1 = msg1


class KisRateLimitError(KisApiError):
    pass


class RateLimiter:
    def __init__(self, tps: float) -> None:
        self.interval = max(0.05, 1.0 / max(0.1, tps))
        self._lock = threading.Lock()
        self._next_at = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            target = max(now, self._next_at)
            self._next_at = target + self.interval
        delay = target - now
        if delay > 0:
            time.sleep(delay)

    def cooldown(self, seconds: float) -> None:
        cool = max(0.0, float(seconds))
        with self._lock:
            now = time.monotonic()
            self._next_at = max(self._next_at, now + cool)


def _safe_json(resp: requests.Response) -> dict[str, Any]:
    try:
        payload = resp.json()
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _is_rate_limit_message(text: str) -> bool:
    msg = str(text or "").strip().lower()
    if not msg:
        return False
    tokens = ["초당 거래건수를 초과", "1분당 1회", "rate limit", "too many requests", "egw00133", "egw00201"]
    return any(token.lower() in msg for token in tokens)


class KisClient:
    def __init__(self, *, rest_url: str, app_key: str, app_secret: str, timeout_sec: int, rate_limiter: RateLimiter) -> None:
        self.rest_url = rest_url.rstrip("/")
        self.app_key = app_key.strip()
        self.app_secret = app_secret.strip()
        self.timeout_sec = max(3, timeout_sec)
        self.rate_limiter = rate_limiter
        self.session = requests.Session()
        self._token_lock = threading.Lock()
        self._token = ""
        self._token_expire_at = dt.datetime.now(dt.UTC)

    def _get_token(self) -> str:
        now = dt.datetime.now(dt.UTC)
        with self._token_lock:
            if self._token and now < self._token_expire_at - dt.timedelta(seconds=60):
                return self._token

            self.rate_limiter.wait()
            resp = self.session.post(
                f"{self.rest_url}/oauth2/tokenP",
                json={"grant_type": "client_credentials", "appkey": self.app_key, "appsecret": self.app_secret},
                timeout=self.timeout_sec,
            )
            payload = _safe_json(resp)
            status = resp.status_code
            if status >= 400:
                msg1 = str(payload.get("msg1") or resp.text or "").strip()
                if _is_rate_limit_message(msg1):
                    raise KisRateLimitError(
                        f"KIS token rate-limited: {msg1 or f'HTTP {status}'}",
                        status_code=status,
                        rt_cd=str(payload.get("rt_cd") or ""),
                        msg1=msg1,
                    )
                raise KisApiError(
                    f"KIS token request failed: {msg1 or f'HTTP {status}'}",
                    status_code=status,
                    rt_cd=str(payload.get("rt_cd") or ""),
                    msg1=msg1,
                )
            token = str(payload.get("access_token") or "").strip()
            if not token:
                raise RuntimeError("KIS token empty")
            expires_in = int(payload.get("expires_in") or 3600)
            self._token = token
            self._token_expire_at = now + dt.timedelta(seconds=max(60, expires_in))
            return self._token

    def fetch_daily(self, *, symbol: str, start_date: dt.date, end_date: dt.date, market_code: str) -> pd.DataFrame:
        rows: list[dict[str, Any]] = []
        current = start_date
        while current <= end_date:
            chunk_end = min(end_date, current + dt.timedelta(days=120))
            token = self._get_token()
            self.rate_limiter.wait()
            resp = self.session.get(
                f"{self.rest_url}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
                params={
                    "FID_COND_MRKT_DIV_CODE": market_code,
                    "FID_INPUT_ISCD": symbol,
                    "FID_INPUT_DATE_1": current.strftime("%Y%m%d"),
                    "FID_INPUT_DATE_2": chunk_end.strftime("%Y%m%d"),
                    "FID_PERIOD_DIV_CODE": "D",
                    "FID_ORG_ADJ_PRC": "0",
                },
                headers={
                    "authorization": f"Bearer {token}",
                    "appkey": self.app_key,
                    "appsecret": self.app_secret,
                    "tr_id": TR_ID_DAILY,
                    "custtype": "P",
                },
                timeout=self.timeout_sec,
            )
            payload = _safe_json(resp)
            status = resp.status_code
            rt_cd = str(payload.get("rt_cd") or "")
            msg1 = str(payload.get("msg1") or "").strip()
            if status >= 400 or (rt_cd and rt_cd != "0"):
                message = msg1 or f"HTTP {status}"
                if _is_rate_limit_message(message):
                    raise KisRateLimitError(
                        f"KIS daily rate-limited symbol={symbol}: {message}",
                        status_code=status,
                        rt_cd=rt_cd,
                        msg1=msg1,
                    )
                raise KisApiError(
                    f"KIS daily failed symbol={symbol}: {message}",
                    status_code=status,
                    rt_cd=rt_cd,
                    msg1=msg1,
                )

            for item in payload.get("output2") or payload.get("output") or []:
                d = str(item.get("stck_bsop_date") or "").strip()
                if len(d) != 8:
                    continue
                rows.append(
                    {
                        "Date": dt.datetime.strptime(d, "%Y%m%d").date(),
                        "Open": to_num(item.get("stck_oprc")),
                        "High": to_num(item.get("stck_hgpr")),
                        "Low": to_num(item.get("stck_lwpr")),
                        "Close": to_num(item.get("stck_clpr")),
                        "Volume": to_num(item.get("acml_vol")),
                    }
                )
            current = chunk_end + dt.timedelta(days=1)

        if not rows:
            return pd.DataFrame()
        df = pd.DataFrame(rows)
        return normalize_daily_df(df)

    def fetch_minute_page(self, *, symbol: str, ymd: str, market_code: str, input_hour: str) -> list[dict[str, Any]]:
        token = self._get_token()
        self.rate_limiter.wait()
        resp = self.session.get(
            f"{self.rest_url}/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice",
            params={
                "FID_ETC_CLS_CODE": "",
                "FID_COND_MRKT_DIV_CODE": market_code,
                "FID_INPUT_ISCD": symbol,
                "FID_INPUT_DATE_1": ymd,
                "FID_INPUT_HOUR_1": input_hour,
                "FID_PW_DATA_INCU_YN": "Y",
                "FID_FAKE_TICK_INCU_YN": "N",
            },
            headers={
                "authorization": f"Bearer {token}",
                "appkey": self.app_key,
                "appsecret": self.app_secret,
                "tr_id": TR_ID_MINUTE,
                "custtype": "P",
            },
            timeout=self.timeout_sec,
        )
        payload = _safe_json(resp)
        status = resp.status_code
        rt_cd = str(payload.get("rt_cd") or "")
        msg1 = str(payload.get("msg1") or "").strip()
        if status >= 400 or (rt_cd and rt_cd != "0"):
            message = msg1 or f"HTTP {status}"
            if _is_rate_limit_message(message):
                raise KisRateLimitError(
                    f"KIS minute rate-limited symbol={symbol} date={ymd}: {message}",
                    status_code=status,
                    rt_cd=rt_cd,
                    msg1=msg1,
                )
            raise KisApiError(
                f"KIS minute failed symbol={symbol} date={ymd}: {message}",
                status_code=status,
                rt_cd=rt_cd,
                msg1=msg1,
            )
        rows = payload.get("output2") if isinstance(payload.get("output2"), list) else payload.get("output")
        return rows if isinstance(rows, list) else []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Daily all + event-minute backfill for Zone3")
    parser.add_argument("--days", type=int, default=int(os.getenv("ZONE3_BACKFILL_DAYS", str(DEFAULT_DAYS))))
    parser.add_argument("--from-date", default="", help="YYYYMMDD")
    parser.add_argument("--to-date", default="", help="YYYYMMDD")
    parser.add_argument("--symbol-limit", type=int, default=int(os.getenv("ZONE3_BACKFILL_SYMBOL_LIMIT", str(DEFAULT_SYMBOL_LIMIT))))
    parser.add_argument("--tps", type=float, default=float(os.getenv("ZONE3_BACKFILL_TPS", str(DEFAULT_TPS))))
    parser.add_argument("--retry", type=int, default=int(os.getenv("ZONE3_BACKFILL_RETRY", str(DEFAULT_RETRY))))
    parser.add_argument("--timeout-sec", type=int, default=int(os.getenv("ZONE3_BACKFILL_TIMEOUT_SEC", str(DEFAULT_TIMEOUT_SEC))))
    parser.add_argument("--limit-cooldown-sec", type=int, default=int(os.getenv("ZONE3_BACKFILL_LIMIT_COOLDOWN_SEC", str(DEFAULT_LIMIT_COOLDOWN_SEC))))
    parser.add_argument("--max-pages", type=int, default=int(os.getenv("ZONE3_BACKFILL_MAX_PAGES", str(DEFAULT_MAX_PAGES))))
    parser.add_argument("--market-code", default=os.getenv("ZONE3_KIS_MARKET_CODE", DEFAULT_MARKET_CODE).strip())
    parser.add_argument("--up-pct", type=float, default=float(os.getenv("ZONE3_EVENT_UP_PCT", "15.0")))
    parser.add_argument("--down-pct", type=float, default=float(os.getenv("ZONE3_EVENT_DOWN_PCT", "-10.0")))
    parser.add_argument("--daily-source", choices=["AUTO", "FDR", "PYKRX", "KIS"], default=os.getenv("ZONE3_DAILY_SOURCE", "AUTO").upper())
    parser.add_argument("--resume", action="store_true", default=True)
    parser.add_argument("--no-resume", action="store_false", dest="resume")
    return parser.parse_args()


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        key, value = s.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = value


def to_symbol(raw: Any) -> str:
    text = str(raw or "").strip().upper()
    if re.fullmatch(r"[A-Z0-9]{6}", text):
        return text
    if re.fullmatch(r"[A-Z][A-Z0-9]{6}", text):
        return text[1:]
    return ""


def resolve_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def resolve_raw_base_dir(repo_root: Path) -> Path:
    from_env = os.getenv("ZONE3_RAW_BASE_DIR", "").strip()
    if from_env:
        return Path(from_env).resolve()
    return (repo_root / "apps" / "orchestrator" / "data" / "zone3" / "raw").resolve()


def setup_logging(log_dir: Path) -> tuple[logging.Logger, Path]:
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"event_minute_backfill_{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

    logger = logging.getLogger("zone3-event-minute-backfill")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    logger.propagate = False
    fmt = logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)
    return logger, log_path


def fetch_krx_symbols(timeout_sec: int, logger: logging.Logger) -> list[SymbolInfo]:
    market_map = {"stockMkt": "KOSPI", "kosdaqMkt": "KOSDAQ"}
    session = requests.Session()
    rows: list[SymbolInfo] = []
    for market_type, market_name in market_map.items():
        url = f"https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&marketType={market_type}"
        logger.info(f"[LISTING] fetch {market_name} {url}")
        resp = session.get(url, timeout=timeout_sec, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        tables = pd.read_html(StringIO(resp.text))
        if not tables:
            continue
        df = tables[0]
        symbol_col = "종목코드" if "종목코드" in df.columns else None
        name_col = "회사명" if "회사명" in df.columns else None
        if not symbol_col or not name_col:
            continue
        for _, row in df.iterrows():
            symbol = to_symbol(row.get(symbol_col))
            if not re.fullmatch(r"[A-Z0-9]{6}", symbol):
                continue
            rows.append(SymbolInfo(symbol=symbol, name=str(row.get(name_col) or "").strip(), market=market_name))
    uniq: dict[str, SymbolInfo] = {}
    for row in rows:
        if row.symbol not in uniq:
            uniq[row.symbol] = row
    out = sorted(uniq.values(), key=lambda x: x.symbol)
    logger.info(f"[LISTING] symbols={len(out)}")
    return out


def normalize_daily_df(df: pd.DataFrame) -> pd.DataFrame:
    required = ["Date", "Open", "High", "Low", "Close", "Volume"]
    if df is None or df.empty:
        return pd.DataFrame(columns=required)
    out = df.copy()
    if "Date" not in out.columns and "index" in out.columns:
        out = out.rename(columns={"index": "Date"})
    for col in required:
        if col not in out.columns:
            out[col] = 0.0 if col != "Date" else ""
    out["Date"] = pd.to_datetime(out["Date"], errors="coerce").dt.date
    out = out.dropna(subset=["Date"])
    for col in ["Open", "High", "Low", "Close", "Volume"]:
        out[col] = pd.to_numeric(out[col], errors="coerce").fillna(0.0)
    out = out[required].sort_values("Date").drop_duplicates(subset=["Date"], keep="first")
    return out


def save_daily_csv(path: Path, df: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False, encoding="utf-8")


def load_daily_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        return pd.DataFrame()
    try:
        df = pd.read_csv(path)
    except Exception:
        return pd.DataFrame()
    return normalize_daily_df(df)


def fetch_daily_fdr(symbol: str, start_date: dt.date, end_date: dt.date) -> pd.DataFrame:
    if fdr is None:
        return pd.DataFrame()
    try:
        time.sleep(0.1)
        df = fdr.DataReader(symbol, start_date, end_date)
        return normalize_daily_df(df.reset_index() if df is not None else pd.DataFrame())
    except Exception:
        return pd.DataFrame()


def fetch_daily_pykrx(symbol: str, start_date: dt.date, end_date: dt.date) -> pd.DataFrame:
    if pykrx_stock is None:
        return pd.DataFrame()
    try:
        time.sleep(0.1)
        df = pykrx_stock.get_market_ohlcv_by_date(
            fromdate=start_date.strftime("%Y%m%d"),
            todate=end_date.strftime("%Y%m%d"),
            ticker=symbol,
        )
        if df is None or df.empty:
            return pd.DataFrame()
        out = df.reset_index().rename(
            columns={"날짜": "Date", "시가": "Open", "고가": "High", "저가": "Low", "종가": "Close", "거래량": "Volume"}
        )
        return normalize_daily_df(out)
    except Exception:
        return pd.DataFrame()


def extract_event_dates(daily_df: pd.DataFrame, *, up_pct: float, down_pct: float) -> list[dt.date]:
    if daily_df.empty or len(daily_df) < 2:
        return []
    df = daily_df.copy()
    df["prev_close"] = df["Close"].shift(1)
    df = df.dropna(subset=["prev_close"])

    # CLASS_A: 장중 고가가 전일 종가 대비 up_pct 이상 상승한 날.
    df["high_pct_change"] = ((df["High"] - df["prev_close"]) / df["prev_close"]) * 100.0
    # CLASS_C: 장중 저가가 전일 종가 대비 down_pct 이하 하락한 날.
    df["low_pct_change"] = ((df["Low"] - df["prev_close"]) / df["prev_close"]) * 100.0

    mask = (df["high_pct_change"] >= up_pct) | (df["low_pct_change"] <= down_pct)
    dates = df.loc[mask, "Date"].dropna().tolist()
    uniq = sorted({d for d in dates if isinstance(d, dt.date)})
    return uniq


def to_num(value: Any) -> float:
    text = str(value or "0").replace(",", "").strip()
    try:
        n = float(text)
    except Exception:
        return 0.0
    return n if n == n else 0.0


def rows_to_minute_df(rows: list[dict[str, Any]], ymd: str) -> pd.DataFrame:
    out: list[dict[str, Any]] = []
    for item in rows:
        d = str(item.get("stck_bsop_date") or "").strip()
        t = str(item.get("stck_cntg_hour") or "").strip()[:6]
        if len(d) != 8 or len(t) != 6:
            continue
        if d != ymd:
            continue
        ts = f"{d[0:4]}-{d[4:6]}-{d[6:8]}T{t[0:2]}:{t[2:4]}:{t[4:6]}"
        out.append(
            {
                "timestamp": ts,
                "open": to_num(item.get("stck_oprc")),
                "high": to_num(item.get("stck_hgpr")),
                "low": to_num(item.get("stck_lwpr")),
                "close": to_num(item.get("stck_prpr")),
                "volume": to_num(item.get("cntg_vol")),
            }
        )
    if not out:
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])
    df = pd.DataFrame(out).sort_values("timestamp").drop_duplicates(subset=["timestamp"], keep="first")
    return df


def hhmmss_minus_one_second(hhmmss: str) -> str:
    token = str(hhmmss or "").strip()
    if len(token) != 6 or not token.isdigit():
        return "090000"
    h = int(token[0:2])
    m = int(token[2:4])
    s = int(token[4:6])
    total = max(0, h * 3600 + m * 60 + s - 1)
    hh = total // 3600
    mm = (total % 3600) // 60
    ss = total % 60
    return f"{hh:02d}{mm:02d}{ss:02d}"


def extract_oldest_hhmmss(rows: list[dict[str, Any]], ymd: str) -> str | None:
    times: list[str] = []
    for item in rows:
        d = str(item.get("stck_bsop_date") or "").strip()
        t = str(item.get("stck_cntg_hour") or "").strip()[:6]
        if d == ymd and len(t) == 6 and t.isdigit():
            times.append(t)
    return min(times) if times else None


def retry_minute_page(
    *,
    client: KisClient,
    symbol: str,
    ymd: str,
    input_hour: str,
    market_code: str,
    max_retry: int,
    limit_cooldown_sec: int,
    logger: logging.Logger,
) -> list[dict[str, Any]]:
    last_err: Exception | None = None
    for attempt in range(1, max(1, max_retry) + 1):
        try:
            return client.fetch_minute_page(symbol=symbol, ymd=ymd, market_code=market_code, input_hour=input_hour)
        except KisRateLimitError as exc:
            last_err = exc
            cool = max(5, int(limit_cooldown_sec))
            client.rate_limiter.cooldown(cool)
            if attempt >= max_retry:
                break
            logger.warning(
                f"[retry-limit] {symbol} {ymd} cursor={input_hour} attempt={attempt}/{max_retry} cooldown={cool}s "
                f"status={exc.status_code} rt_cd={exc.rt_cd} msg={exc.msg1}"
            )
            time.sleep(cool)
        except KisApiError as exc:
            last_err = exc
            if attempt >= max_retry:
                break
            wait_sec = min(20, 2 ** (attempt - 1))
            logger.warning(
                f"[retry-api] {symbol} {ymd} cursor={input_hour} attempt={attempt}/{max_retry} wait={wait_sec:.1f}s "
                f"status={exc.status_code} rt_cd={exc.rt_cd} msg={exc.msg1}"
            )
            time.sleep(wait_sec)
        except Exception as exc:
            last_err = exc if isinstance(exc, Exception) else RuntimeError(str(exc))
            if attempt >= max_retry:
                break
            wait_sec = min(20, 2 ** (attempt - 1))
            logger.warning(f"[retry] {symbol} {ymd} cursor={input_hour} attempt={attempt}/{max_retry} wait={wait_sec:.1f}s")
            time.sleep(wait_sec)
    raise RuntimeError(f"minute fetch failed symbol={symbol} date={ymd}: {last_err}") from last_err


def fetch_full_day_minute_df(
    *,
    client: KisClient,
    symbol: str,
    ymd: str,
    market_code: str,
    max_retry: int,
    limit_cooldown_sec: int,
    max_pages: int,
    logger: logging.Logger,
) -> pd.DataFrame:
    cursor = "153000"
    row_map: dict[str, dict[str, Any]] = {}
    for page in range(1, max(1, max_pages) + 1):
        rows = retry_minute_page(
            client=client,
            symbol=symbol,
            ymd=ymd,
            input_hour=cursor,
            market_code=market_code,
            max_retry=max_retry,
            limit_cooldown_sec=limit_cooldown_sec,
            logger=logger,
        )
        page_df = rows_to_minute_df(rows, ymd)
        if page_df.empty:
            break
        before = len(row_map)
        for rec in page_df.to_dict(orient="records"):
            row_map[str(rec["timestamp"])] = rec
        added = len(row_map) - before
        logger.info(f"[PAGE] {symbol} {ymd} page={page} cursor={cursor} fetched={len(page_df)} added={added} total={len(row_map)}")

        oldest = extract_oldest_hhmmss(rows, ymd)
        if len(page_df) < PAGE_ROW_LIMIT or not oldest or oldest <= "090000":
            break
        next_cursor = hhmmss_minus_one_second(oldest)
        if next_cursor >= cursor:
            break
        cursor = next_cursor

    if not row_map:
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])
    return pd.DataFrame(list(row_map.values())).sort_values("timestamp")


def resolve_date_range(args: argparse.Namespace) -> tuple[dt.date, dt.date]:
    if args.from_date and args.to_date:
        start = dt.datetime.strptime(args.from_date, "%Y%m%d").date()
        end = dt.datetime.strptime(args.to_date, "%Y%m%d").date()
        if start > end:
            raise ValueError("--from-date must be <= --to-date")
        return start, end
    end = dt.date.today()
    start = end - dt.timedelta(days=max(1, int(args.days)))
    return start, end


def validate_kis_env() -> tuple[str, str, str]:
    rest_url = os.getenv("KIS_REST_URL", "").strip()
    app_key = os.getenv("KIS_APP_KEY", "").strip()
    app_secret = os.getenv("KIS_APP_SECRET", "").strip()
    if not rest_url or not app_key or not app_secret:
        raise RuntimeError("KIS_REST_URL/KIS_APP_KEY/KIS_APP_SECRET 필요")
    return rest_url, app_key, app_secret


def fetch_daily_auto(symbol: str, start_date: dt.date, end_date: dt.date, kis: KisClient | None, market_code: str, source: str) -> pd.DataFrame:
    src = source.upper()
    if src == "FDR":
        return fetch_daily_fdr(symbol, start_date, end_date)
    if src == "PYKRX":
        return fetch_daily_pykrx(symbol, start_date, end_date)
    if src == "KIS":
        return kis.fetch_daily(symbol=symbol, start_date=start_date, end_date=end_date, market_code=market_code) if kis else pd.DataFrame()

    for fn in (
        lambda: fetch_daily_fdr(symbol, start_date, end_date),
        lambda: fetch_daily_pykrx(symbol, start_date, end_date),
        lambda: kis.fetch_daily(symbol=symbol, start_date=start_date, end_date=end_date, market_code=market_code) if kis else pd.DataFrame(),
    ):
        df = fn()
        if df is not None and not df.empty:
            return df
    return pd.DataFrame()


def process_symbol(
    *,
    info: SymbolInfo,
    daily_dir: Path,
    minute_dir: Path,
    start_date: dt.date,
    end_date: dt.date,
    up_pct: float,
    down_pct: float,
    daily_source: str,
    client: KisClient,
    market_code: str,
    max_retry: int,
    limit_cooldown_sec: int,
    max_pages: int,
    resume: bool,
    logger: logging.Logger,
) -> tuple[int, int, int]:
    daily_path = daily_dir / f"{info.symbol}.csv"
    daily_df = load_daily_csv(daily_path)
    if daily_df.empty or not resume:
        fetched = fetch_daily_auto(info.symbol, start_date, end_date, client, market_code, daily_source)
        if not fetched.empty:
            daily_df = fetched
            save_daily_csv(daily_path, daily_df)
            logger.info(f"[DAILY] saved {info.symbol} rows={len(daily_df)} path={daily_path}")
    if daily_df.empty:
        logger.warning(f"[DAILY] empty {info.symbol}")
        return 0, 0, 1

    events = [d for d in extract_event_dates(daily_df, up_pct=up_pct, down_pct=down_pct) if start_date <= d <= end_date]
    logger.info(f"[EVENT] {info.symbol} events={len(events)}")
    if not events:
        return 0, 0, 0

    saved_days = 0
    empty_days = 0
    error_days = 0
    for event_date in events:
        ymd = event_date.strftime("%Y%m%d")
        out_path = minute_dir / info.symbol / f"{ymd}.csv"
        if resume and out_path.exists():
            logger.info(f"[SKIP] minute exists {info.symbol} {ymd}")
            continue
        try:
            minute_df = fetch_full_day_minute_df(
                client=client,
                symbol=info.symbol,
                ymd=ymd,
                market_code=market_code,
                max_retry=max_retry,
                limit_cooldown_sec=limit_cooldown_sec,
                max_pages=max_pages,
                logger=logger,
            )
            if minute_df.empty:
                empty_days += 1
                logger.info(f"[EMPTY] minute {info.symbol} {ymd}")
                continue
            out_path.parent.mkdir(parents=True, exist_ok=True)
            minute_df.to_csv(out_path, index=False, encoding="utf-8")
            saved_days += 1
            logger.info(f"[SAVED] minute {info.symbol} {ymd} rows={len(minute_df)} path={out_path}")
        except Exception as exc:
            error_days += 1
            logger.error(f"[FAIL] minute {info.symbol} {ymd} {exc}")
    return saved_days, empty_days, error_days


def main() -> int:
    repo_root = resolve_repo_root()
    load_env_file(repo_root / ".env.local")
    load_env_file(repo_root / "apps" / "orchestrator" / ".env.local")
    args = parse_args()
    start_date, end_date = resolve_date_range(args)
    raw_base = resolve_raw_base_dir(repo_root)
    daily_dir = raw_base / "daily"
    minute_dir = raw_base / "minute"
    logger, log_path = setup_logging(minute_dir / "_logs")

    logger.info("[START] daily-all + event-minute backfill")
    logger.info(
        f"[CONFIG] raw_base={raw_base} range={start_date}..{end_date} symbols={args.symbol_limit} "
        f"up_pct={args.up_pct} down_pct={args.down_pct} daily_source={args.daily_source} "
        f"tps={args.tps} retry={args.retry} max_pages={args.max_pages} resume={args.resume}"
    )
    logger.info(f"[CONFIG] log_path={log_path}")

    try:
        rest_url, app_key, app_secret = validate_kis_env()
    except Exception as exc:
        logger.error(f"[ERR] {exc}")
        return 1

    try:
        symbols = fetch_krx_symbols(max(3, int(args.timeout_sec)), logger)
    except Exception as exc:
        logger.error(f"[ERR] listing failed: {exc}")
        return 1
    if not symbols:
        logger.error("[ERR] no symbols")
        return 1
    symbols = symbols[: max(1, int(args.symbol_limit))]

    rate_limiter = RateLimiter(args.tps)
    client = KisClient(
        rest_url=rest_url,
        app_key=app_key,
        app_secret=app_secret,
        timeout_sec=max(3, int(args.timeout_sec)),
        rate_limiter=rate_limiter,
    )

    total_saved = 0
    total_empty = 0
    total_error = 0
    for idx, info in enumerate(symbols, start=1):
        logger.info(f"[SYMBOL {idx}/{len(symbols)}] {info.symbol} {info.name}")
        saved, empty, err = process_symbol(
            info=info,
            daily_dir=daily_dir,
            minute_dir=minute_dir,
            start_date=start_date,
            end_date=end_date,
            up_pct=float(args.up_pct),
            down_pct=float(args.down_pct),
            daily_source=args.daily_source,
            client=client,
            market_code=args.market_code,
            max_retry=max(1, int(args.retry)),
            limit_cooldown_sec=max(5, int(args.limit_cooldown_sec)),
            max_pages=max(1, int(args.max_pages)),
            resume=bool(args.resume),
            logger=logger,
        )
        total_saved += saved
        total_empty += empty
        total_error += err
        logger.info(
            f"[PROGRESS] {idx}/{len(symbols)} saved_days={saved} empty_days={empty} error_days={err} "
            f"acc_saved={total_saved} acc_empty={total_empty} acc_error={total_error}"
        )

    logger.info(
        f"[DONE] symbols={len(symbols)} saved_days={total_saved} empty_days={total_empty} error_days={total_error}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
