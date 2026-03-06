from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import re
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd
import requests


TR_ID = "FHKST03010230"  # 주식일별분봉조회
DEFAULT_MARKET_CODE = "J"
DEFAULT_TIMEOUT_SEC = 15
DEFAULT_RETRY = 5
DEFAULT_DAYS = 365
DEFAULT_SYMBOL_LIMIT = 2000
DEFAULT_TPS = 0.8
DEFAULT_MAX_WORKERS = 1
DEFAULT_LIMIT_COOLDOWN_SEC = 20
DEFAULT_MAX_PAGES = 20
PAGE_ROW_LIMIT = 120


@dataclass(frozen=True)
class SymbolInfo:
    symbol: str
    name: str
    market: str


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


class KisApiError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, rt_cd: str | None = None, msg1: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.rt_cd = rt_cd
        self.msg1 = msg1


class KisRateLimitError(KisApiError):
    pass


def _safe_json(resp: requests.Response) -> dict[str, Any]:
    try:
        payload = resp.json()
        if isinstance(payload, dict):
            return payload
        return {}
    except Exception:
        return {}


def _is_rate_limit_message(text: str) -> bool:
    msg = str(text or "").strip()
    if not msg:
        return False
    tokens = [
        "초당 거래건수를 초과",
        "1초당",
        "rate limit",
        "too many requests",
        "egw00133",
        "egw00201",
    ]
    lower = msg.lower()
    return any(token in lower for token in [t.lower() for t in tokens])


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
                json={
                    "grant_type": "client_credentials",
                    "appkey": self.app_key,
                    "appsecret": self.app_secret,
                },
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

    def fetch_minute_by_day(self, *, symbol: str, ymd: str, market_code: str, input_hour: str) -> list[dict[str, Any]]:
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
                "tr_id": TR_ID,
                "custtype": "P",
            },
            timeout=self.timeout_sec,
        )
        payload = _safe_json(resp)
        rt_cd = str(payload.get("rt_cd") or "")
        msg1 = str(payload.get("msg1") or "").strip()
        status = resp.status_code
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
    parser = argparse.ArgumentParser(description="Zone3 minute data backfill")
    parser.add_argument("--days", type=int, default=int(os.getenv("ZONE3_BACKFILL_DAYS", str(DEFAULT_DAYS))))
    parser.add_argument("--symbol-limit", type=int, default=int(os.getenv("ZONE3_BACKFILL_SYMBOL_LIMIT", str(DEFAULT_SYMBOL_LIMIT))))
    parser.add_argument("--max-workers", type=int, default=int(os.getenv("ZONE3_BACKFILL_CONCURRENCY", str(DEFAULT_MAX_WORKERS))))
    parser.add_argument("--tps", type=float, default=float(os.getenv("ZONE3_BACKFILL_TPS", str(DEFAULT_TPS))))
    parser.add_argument("--retry", type=int, default=int(os.getenv("ZONE3_BACKFILL_RETRY", str(DEFAULT_RETRY))))
    parser.add_argument("--timeout-sec", type=int, default=int(os.getenv("ZONE3_BACKFILL_TIMEOUT_SEC", str(DEFAULT_TIMEOUT_SEC))))
    parser.add_argument(
        "--limit-cooldown-sec",
        type=int,
        default=int(os.getenv("ZONE3_BACKFILL_LIMIT_COOLDOWN_SEC", str(DEFAULT_LIMIT_COOLDOWN_SEC))),
    )
    parser.add_argument("--max-pages", type=int, default=int(os.getenv("ZONE3_BACKFILL_MAX_PAGES", str(DEFAULT_MAX_PAGES))))
    parser.add_argument("--market-code", default=os.getenv("ZONE3_KIS_MARKET_CODE", DEFAULT_MARKET_CODE).strip())
    parser.add_argument("--resume", action="store_true", default=True)
    parser.add_argument("--no-resume", action="store_false", dest="resume")
    parser.add_argument("--from-date", default="", help="YYYYMMDD")
    parser.add_argument("--to-date", default="", help="YYYYMMDD")
    return parser.parse_args()


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip().strip("'").strip('"')
        if key not in os.environ:
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
    log_path = log_dir / f"minute_backfill_{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

    logger = logging.getLogger("zone3-minute-backfill")
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
    market_map = {
        "stockMkt": "KOSPI",
        "kosdaqMkt": "KOSDAQ",
    }
    session = requests.Session()
    rows: list[SymbolInfo] = []

    for market_type, market_name in market_map.items():
        url = f"https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&marketType={market_type}"
        logger.info(f"[LISTING] fetch {market_name} {url}")
        resp = session.get(url, timeout=timeout_sec, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        tables = pd.read_html(resp.text)
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


def enumerate_weekdays(start: dt.date, end: dt.date) -> list[dt.date]:
    out: list[dt.date] = []
    cur = start
    while cur <= end:
        if cur.weekday() < 5:
            out.append(cur)
        cur += dt.timedelta(days=1)
    return out


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
        timestamp = f"{d[0:4]}-{d[4:6]}-{d[6:8]}T{t[0:2]}:{t[2:4]}:{t[4:6]}"
        if d != ymd:
            continue
        out.append(
            {
                "timestamp": timestamp,
                "open": to_num(item.get("stck_oprc")),
                "high": to_num(item.get("stck_hgpr")),
                "low": to_num(item.get("stck_lwpr")),
                "close": to_num(item.get("stck_prpr")),
                "volume": to_num(item.get("cntg_vol")),
            }
        )
    if not out:
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])
    df = pd.DataFrame(out)
    df = df.sort_values("timestamp")
    df = df.drop_duplicates(subset=["timestamp"], keep="first")
    return df


def save_minute_df(path: Path, df: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False, encoding="utf-8")


def retry_fetch(
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
            return client.fetch_minute_by_day(symbol=symbol, ymd=ymd, market_code=market_code, input_hour=input_hour)
        except KisRateLimitError as exc:
            last_err = exc
            cool = max(5, int(limit_cooldown_sec))
            client.rate_limiter.cooldown(cool)
            if attempt >= max_retry:
                break
            logger.warning(
                f"[retry-limit] kis:minute:{symbol}:{ymd}:{input_hour} attempt={attempt}/{max_retry} cooldown={cool}s "
                f"status={exc.status_code} rt_cd={exc.rt_cd} msg={exc.msg1}"
            )
            time.sleep(cool)
        except KisApiError as exc:
            last_err = exc
            if attempt >= max_retry:
                break
            wait_sec = min(20, 2 ** (attempt - 1))
            logger.warning(
                f"[retry-api] kis:minute:{symbol}:{ymd}:{input_hour} attempt={attempt}/{max_retry} wait={wait_sec:.1f}s "
                f"status={exc.status_code} rt_cd={exc.rt_cd} msg={exc.msg1}"
            )
            time.sleep(wait_sec)
        except Exception as exc:
            last_err = exc if isinstance(exc, Exception) else RuntimeError(str(exc))
            if attempt >= max_retry:
                break
            wait_sec = min(30, 2 ** (attempt - 1))
            logger.warning(f"[retry] kis:minute:{symbol}:{ymd}:{input_hour} attempt={attempt}/{max_retry} wait={wait_sec:.1f}s")
            time.sleep(wait_sec)
    raise RuntimeError(f"minute fetch failed symbol={symbol} date={ymd}: {last_err}") from last_err


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


def extract_oldest_hhmmss(rows: list[dict[str, Any]], ymd: str) -> str | None:
    times: list[str] = []
    for item in rows:
        d = str(item.get("stck_bsop_date") or "").strip()
        t = str(item.get("stck_cntg_hour") or "").strip()[:6]
        if d != ymd or len(t) != 6 or not t.isdigit():
            continue
        times.append(t)
    if not times:
        return None
    return min(times)


def fetch_full_day_minutes(
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
    row_map: dict[str, dict[str, Any]] = {}
    cursor = "153000"

    for page in range(1, max(1, max_pages) + 1):
        rows = retry_fetch(
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
            if page == 1:
                return page_df
            break

        before = len(row_map)
        for rec in page_df.to_dict(orient="records"):
            row_map[str(rec["timestamp"])] = rec
        added = len(row_map) - before
        logger.info(f"[PAGE] {symbol} {ymd} page={page} cursor={cursor} fetched={len(page_df)} added={added} total={len(row_map)}")

        oldest = extract_oldest_hhmmss(rows, ymd)
        if not oldest:
            break
        if len(page_df) < PAGE_ROW_LIMIT:
            break
        if oldest <= "090000":
            break

        next_cursor = hhmmss_minus_one_second(oldest)
        if next_cursor >= cursor:
            break
        cursor = next_cursor

    if not row_map:
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])
    out = pd.DataFrame(list(row_map.values()))
    out = out.sort_values("timestamp")
    return out[["timestamp", "open", "high", "low", "close", "volume"]]


def validate_kis_env() -> tuple[str, str, str]:
    rest_url = os.getenv("KIS_REST_URL", "").strip()
    app_key = os.getenv("KIS_APP_KEY", "").strip()
    app_secret = os.getenv("KIS_APP_SECRET", "").strip()
    if not rest_url or not app_key or not app_secret:
        raise RuntimeError("KIS_REST_URL/KIS_APP_KEY/KIS_APP_SECRET 환경변수 필요")
    return rest_url, app_key, app_secret


def resolve_date_range(args: argparse.Namespace) -> tuple[dt.date, dt.date]:
    today = dt.date.today()
    if args.from_date and args.to_date:
        start = dt.datetime.strptime(args.from_date, "%Y%m%d").date()
        end = dt.datetime.strptime(args.to_date, "%Y%m%d").date()
        if start > end:
            raise ValueError("--from-date must be <= --to-date")
        return start, end
    end = today
    start = today - dt.timedelta(days=max(1, int(args.days)))
    return start, end


def process_symbol(
    *,
    info: SymbolInfo,
    days: list[dt.date],
    minute_root: Path,
    client: KisClient,
    market_code: str,
    max_retry: int,
    limit_cooldown_sec: int,
    max_pages: int,
    resume: bool,
    logger: logging.Logger,
) -> tuple[int, int, int]:
    saved_days = 0
    empty_days = 0
    error_days = 0

    for day in days:
        ymd = day.strftime("%Y%m%d")
        out_path = minute_root / info.symbol / f"{ymd}.csv"
        if resume and out_path.exists():
            logger.info(f"[SKIP] {info.symbol} {ymd} exists")
            continue

        try:
            df = fetch_full_day_minutes(
                client=client,
                symbol=info.symbol,
                ymd=ymd,
                market_code=market_code,
                max_retry=max_retry,
                limit_cooldown_sec=limit_cooldown_sec,
                max_pages=max_pages,
                logger=logger,
            )
            if df.empty:
                empty_days += 1
                logger.info(f"[EMPTY] {info.symbol} {ymd} rows=0")
                continue
            save_minute_df(out_path, df)
            saved_days += 1
            logger.info(f"[SAVED] {info.symbol} {ymd} rows={len(df)} path={out_path}")
        except Exception as exc:
            error_days += 1
            logger.error(f"[FAIL] {info.symbol} {ymd} {exc}")

    return saved_days, empty_days, error_days


def main() -> int:
    repo_root = resolve_repo_root()
    load_env_file(repo_root / ".env.local")
    load_env_file(repo_root / "apps" / "orchestrator" / ".env.local")
    args = parse_args()

    raw_base_dir = resolve_raw_base_dir(repo_root)
    minute_root = raw_base_dir / "minute"
    log_dir = minute_root / "_logs"
    logger, log_path = setup_logging(log_dir)

    logger.info("[START] zone3 minute backfill")
    logger.info(f"[CONFIG] raw_base_dir={raw_base_dir}")
    logger.info(f"[CONFIG] log_path={log_path}")

    try:
        rest_url, app_key, app_secret = validate_kis_env()
    except Exception as exc:
        logger.error(f"[ERR] {exc}")
        return 1

    start_date, end_date = resolve_date_range(args)
    days = enumerate_weekdays(start_date, end_date)
    logger.info(
        f"[CONFIG] date_range={start_date.isoformat()}..{end_date.isoformat()} weekdays={len(days)} "
        f"symbol_limit={args.symbol_limit} tps={args.tps} retry={args.retry} market_code={args.market_code} "
        f"resume={args.resume} limit_cooldown_sec={args.limit_cooldown_sec} max_pages={args.max_pages}"
    )

    try:
        symbols = fetch_krx_symbols(timeout_sec=max(3, args.timeout_sec), logger=logger)
    except Exception as exc:
        logger.error(f"[ERR] symbol listing failed: {exc}")
        return 1

    if not symbols:
        logger.error("[ERR] no symbols")
        return 1

    symbols = symbols[: max(1, int(args.symbol_limit))]
    logger.info(f"[RUN] symbols={len(symbols)}")

    rate_limiter = RateLimiter(args.tps)
    client = KisClient(
        rest_url=rest_url,
        app_key=app_key,
        app_secret=app_secret,
        timeout_sec=max(3, int(args.timeout_sec)),
        rate_limiter=rate_limiter,
    )

    # KIS 한도 안정성을 위해 전종목 처리 기본은 직렬로 두고, 필요 시 --max-workers로 확장한다.
    workers = max(1, int(args.max_workers))
    if workers == 1:
        total_saved = 0
        total_empty = 0
        total_error = 0
        for idx, info in enumerate(symbols, start=1):
            logger.info(f"[SYMBOL {idx}/{len(symbols)}] {info.symbol} {info.name}")
            saved, empty, error = process_symbol(
                info=info,
                days=days,
                minute_root=minute_root,
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
            total_error += error
            logger.info(
                f"[PROGRESS] symbol={info.symbol} saved_days={saved} empty_days={empty} error_days={error} "
                f"acc_saved={total_saved} acc_empty={total_empty} acc_error={total_error}"
            )
    else:
        from concurrent.futures import ThreadPoolExecutor, as_completed

        total_saved = 0
        total_empty = 0
        total_error = 0
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = []
            for info in symbols:
                futures.append(
                    executor.submit(
                        process_symbol,
                        info=info,
                        days=days,
                        minute_root=minute_root,
                        client=client,
                        market_code=args.market_code,
                        max_retry=max(1, int(args.retry)),
                        limit_cooldown_sec=max(5, int(args.limit_cooldown_sec)),
                        max_pages=max(1, int(args.max_pages)),
                        resume=bool(args.resume),
                        logger=logger,
                    )
                )
            done = 0
            for future in as_completed(futures):
                done += 1
                try:
                    saved, empty, error = future.result()
                    total_saved += saved
                    total_empty += empty
                    total_error += error
                except Exception as exc:
                    total_error += 1
                    logger.error(f"[FUTURE_FAIL] {exc}")
                logger.info(
                    f"[PROGRESS] {done}/{len(symbols)} acc_saved={total_saved} acc_empty={total_empty} acc_error={total_error}"
                )

    summary = {
        "symbols": len(symbols),
        "weekdays": len(days),
        "saved_days": total_saved,
        "empty_days": total_empty,
        "error_days": total_error,
        "raw_base_dir": str(raw_base_dir),
        "log_path": str(log_path),
        "finished_at": dt.datetime.now(dt.UTC).isoformat(),
    }
    logger.info(f"[DONE] {json.dumps(summary, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
