# stock_korea - Tactical Trading System Skeleton

`docs/*.md` 기준으로 Zone 0~6 전체를 연결하는 초기 골격입니다.

## Structure
```text
apps/
  dashboard/      # Next.js 14 tactical dashboard
  orchestrator/   # Node.js pipeline + Socket.io hub + command API
packages/
  contracts/      # Shared TypeScript data contracts (Zone I/O)
services/
  python/         # Zone2/3/4/6 worker stubs
docs/             # Original architecture notes
```

## What is implemented
- Shared contracts for Zone0~6, account, positions, order log, dashboard events
- Orchestrator tick loop (`1s`): `Zone0 -> Zone1 -> Zone2 -> Zone3 -> Zone4 -> Zone6 -> Zone5`
- AI decision to action order conversion (`BUY/SELL/PASS`)
- Kill-Switch and Manual Override APIs
- Next.js dashboard with top/left/center/right panels and live socket updates
- Python worker entrypoints that match zone contracts (stub outputs)

## Quick start
1. Install dependencies
```bash
npm install
```
2. Install Python worker dependencies (Zone2/3/4/6)
```bash
py -3 -m pip install -r services/python/requirements.txt
```
3. Run both apps
```bash
npm run dev
```
4. Open dashboard
- `http://localhost:5000`

## Database bootstrap (Oracle)
1. Initialize schema
```bash
npm run db:init
```
2. Verify zone runtime integration
```bash
npm run build -w @stock/contracts && npm run build -w @stock/orchestrator
npm run verify:zones
```

`db:init` creates Oracle tables/indexes for Zone0~6 and applies partitioning for high-volume logs.
`verify:zones` starts a local orchestrator process and checks Zone0~6 API/state flow end-to-end.

## Environment
Copy `.env.example` values into `.env` if needed.

- `DASHBOARD_PORT` (default: `5000`)
- `ORCHESTRATOR_PORT` (default: `5001`)
- `NEXT_PUBLIC_ORCHESTRATOR_URL` (default: `http://localhost:5001`)
- `ZONE0_BUFFER_SIZE` (default: `600`)
- `ZONE2_PROVIDER` (`AUTO` | `PYTHON` | `MOCK`, default: `AUTO`)
- `ZONE2_REFRESH_TICKS` (default: `15`)
- `ZONE2_STALE_SECONDS` (default: `180`)
- `ZONE2_PYTHON_CMD` (default: `python`)
- `ZONE2_FORCE_BLOCKED_SYMBOLS` (comma-separated symbols)
- `ZONE3_PROVIDER` (`AUTO` | `PYTHON` | `LOCAL_VECTOR`, default: `AUTO`)
- `ZONE3_VECTOR_DIM` (default: `1024`)
- `ZONE3_CANDLE_WINDOW_MINUTES` (default: `30`)
- `ZONE3_MIN_CANDLES` (default: `8`)
- `ZONE3_PYTHON_CMD` (default: `python`)
- `ZONE4_PROVIDER` (`AUTO` | `PYTHON` | `LOCAL`, default: `AUTO`)
- `ZONE4_STAGE2_THRESHOLD` (default: `55`)
- `ZONE4_STAGE3_THRESHOLD` (default: `75`)
- `ZONE4_EMA_ALPHA` (default: `0.35`)
- `ZONE4_PYTHON_CMD` (default: `python`)
- `ZONE5_PROVIDER` (`AUTO` | `LLM` | `RULE`, default: `AUTO`)
- `ZONE5_LLM_BASE_URL` (default: `LLM_BASE_URL`)
- `ZONE5_LLM_MODEL` (default: `LLM_MODEL`)
- `ZONE5_LLM_TIMEOUT_MS` (default: `1200`)
- `ZONE5_MIN_CASH` (default: `1000000`)
- `ZONE5_MAX_WEIGHT` (default: `20`)
- `ZONE5_MIN_PATTERN_SIMILARITY` (default: `0.9`)
- `ZONE5_REQUIRED_MADNESS_STAGE` (`STAGE_1|2|3`, default: `STAGE_2`)
- `ZONE6_PROVIDER` (`AUTO` | `PYTHON` | `LOCAL_VECTOR`, default: `AUTO`)
- `ZONE6_VECTOR_DIM` (default: `1024`)
- `ZONE6_MAX_RECORDS` (default: `2000`)
- `ZONE6_MIN_SIMILARITY` (default: `0.2`)
- `ZONE6_PYTHON_CMD` (default: `python`)

## Docs
- System mapping: `docs/system_skeleton.md`
- DB schema/runbook: `docs/db.md`
- Zone specs: `docs/zone0.md` ~ `docs/zone6.md`
