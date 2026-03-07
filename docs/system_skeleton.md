# System Skeleton Mapping

`docs/ui.md`, `docs/zone0~6.md`를 실제 코드 구조로 매핑한 기본 뼈대입니다.

DB 생성/운영 관련 내용은 `docs/db.md`를 기준으로 관리합니다.

## Zone -> Code
- Zone 0 (Raw Data): `apps/orchestrator/src/zones/zone0/ingest.ts` (KIS tick/10호가 + 동적 심볼풀 + 뉴스/종토방/텔레그램 수집, 버퍼, 이벤트 발행)
- Zone 1 (Technical): `apps/orchestrator/src/zones/zone1/technical.ts` (1분 spike, 3/5분 MA, imbalance, support/resistance 상태 계산)
- Zone 2 (Fundamental): `apps/orchestrator/src/zones/zone2/fundamental.ts`, `services/python/zone2_worker.py` (provider/cache/fallback 기반 리스크 필터)
- Zone 3 (Pattern Match): `apps/orchestrator/src/zones/zone3/pattern.ts`, `services/python/zone3_worker.py` (30분 OHLVC 벡터화 + 코사인 매칭)
- Zone 4 (Madness): `apps/orchestrator/src/zones/zone4/madness.ts`, `services/python/zone4_worker.py` (sentiment/social-rate 기반 stage 산출)
- Zone 5 (Decision): `apps/orchestrator/src/zones/zone5/decision.ts` (LLM/RULE provider + action order/state archive 생성)
- Zone 6 (History Feedback): `apps/orchestrator/src/zones/zone6/history.ts`, `services/python/zone6_worker.py` (vector 유사 이력 조회 + 청산 결과 아카이브 적재)

## Runtime Flow
1. Orchestrator는 Zone0의 `zone0:raw` 이벤트를 트리거로 Zone 0 -> 1 -> 2 -> 3 -> 4 -> 6 -> 5 순서로 계산
2. Zone 5 결과를 `BUY/SELL/PASS`로 변환해 가상 주문 체결
3. 상태 스냅샷을 Socket.io로 대시보드에 push
4. 대시보드에서 Kill-Switch/Manual Override 명령을 API로 역전송

## DB Bootstrap
- SQL: `db/oracle/init_schema.sql`
- Runner: `scripts/db-init.ps1`
- Command: `npm run db:init`
- Zone table mapping:
  - Zone0: `TB_ZONE0_EVENT_RAW`
  - Zone1: `TB_ZONE1_TICK_RAW`
  - Zone2: `TB_ZONE2_FUNDAMENTAL`
  - Zone3: `TB_ZONE3_CANDLE_RAW`
  - Zone4: `TB_ZONE4_NEWS_RAW`
  - Zone5: `TB_ZONE5_DECISION_LOG`
  - Zone6: `TB_TRADE_HISTORY`
  - Integrated vectors: `TB_INTEGRATED_VECTOR_STATION` (`IX_IVS_Z1_TECH_HNSW`, `IX_IVS_Z2_FUND_HNSW`, `IX_IVS_Z3_CHART_HNSW`, `IX_IVS_Z4_SENT_HNSW`)
- Partition policy:
  - 대용량 로그 테이블(Zone0/1/4/5/6)은 RANGE + INTERVAL 파티셔닝
  - 일반 인덱스는 LOCAL 우선
  - 벡터 인덱스는 예외 허용

## Integration Check
- Command: `npm run verify:zones`
- 검증 항목:
  - `/health`, `/api/snapshot`, `/api/zone0~6/state` 응답 확인
  - snapshot timestamp 증가 확인
  - kill-switch + manual buy 시나리오로 주문/피드백 루프 확인
  - Zone6 `recordCount` 증가 확인

## Zone 0 Runtime Details
- Zone 0 Gateway lifecycle: `createRuntimeState()`에서 생성 후 런타임 동안 재사용
- Raw frame pull: `stepRuntime()`에서 `zone0.consumeFrame()` 호출
- Trigger: `zone0:raw` 이벤트 발생 시 runtime step 스케줄링
- EventEmitter channels:
  - `zone1:tick`
  - `zone4:context`
  - `zone0:raw`
- Buffer API: `GET /api/zone0/buffer`
- Health summary: `GET /health` 응답에 zone0 buffer metrics 포함
- Dynamic symbol pool:
  - KIS 핫리스트 기반 감시 종목 자동 갱신
  - `updateSymbols()`로 웹소켓 증분 subscribe/unsubscribe 반영
- Config:
  - 버퍼/큐: `ZONE0_BUFFER_SIZE`, `ZONE0_FRAME_QUEUE_SIZE`
  - 심볼풀: `ZONE0_SYMBOL_DISCOVERY_ENABLED`, `ZONE0_SYMBOL_POOL_SIZE`, `ZONE0_SYMBOL_POOL_REFRESH_MS`

## Zone 1 Runtime Details
- Zone 1 Engine lifecycle: `createRuntimeState()`에서 생성 후 런타임 동안 재사용
- Input: `stepRuntime()`에서 Zone0 frame의 `tick + orderBook` 전달
- Core windows:
  - 최근 1분 거래대금 윈도우
  - 직전 1분 거래대금 윈도우
  - 3분/5분 가격 이동평균 윈도우
- Output metrics:
  - `volumePower`
  - `spikeRatio`
  - `maDivergence`
  - `orderImbalance`
  - `support`, `resistance`
- Debug API: `GET /api/zone1/state`

## Zone 2 Runtime Details
- Zone 2 Engine lifecycle: `createRuntimeState()`에서 생성 후 런타임 동안 재사용
- Input: `stepRuntime()`에서 `symbol`, `tickCount`, 이전 zone2 결과 전달
- Provider model:
  - `PYTHON`: `services/python/zone2_worker.py` 호출
  - `MOCK`: deterministic fallback
  - `AUTO`: python 시도 후 실패 시 mock fallback
- Cache strategy:
  - tick 기반 refresh (`ZONE2_REFRESH_TICKS`)
  - 시간 기반 stale (`ZONE2_STALE_SECONDS`)
- Output: `Zone2Fundamental` (`riskFlag`, `issues`, `checkedAt`)
- Debug API: `GET /api/zone2/state`

## Zone 3 Runtime Details
- Zone 3 Engine lifecycle: `createRuntimeState()`에서 생성 후 런타임 동안 재사용
- Input: `stepRuntime()`에서 `symbol`, `tick`, `Zone1Technical` 전달
- Candle pipeline:
  - 1초 tick -> 1분 OHLVC 캔들 집계
  - 최근 N분(`ZONE3_CANDLE_WINDOW_MINUTES`) 유지
- Vector pipeline:
  - 30분 궤적을 `ZONE3_VECTOR_DIM` 차원으로 벡터화
  - cosine similarity로 reference pattern 탐색
- Provider model:
  - `PYTHON`: `services/python/zone3_worker.py` 호출
  - `LOCAL_VECTOR`: 로컬 벡터 매칭
  - `AUTO`: python 시도 후 실패 시 local fallback
- Output: `Zone3PatternMatch` (`klass`, `similarity`, `matchedPatternId`)
- Debug API: `GET /api/zone3/state`

## Zone 4 Runtime Details
- Zone 4 Engine lifecycle: `createRuntimeState()`에서 생성 후 런타임 동안 재사용
- Input: `stepRuntime()`에서 `symbol`, `Zone1Technical`, `Zone3PatternMatch`, `Zone0SentimentPulse` 전달
- Core scoring:
  - sentiment pulse score/velocity/signalCount 반영
  - 1분 social signal rate 계산
  - technical/pattern 결합 점수 + EMA smoothing
- Provider model:
  - `PYTHON`: `services/python/zone4_worker.py` 호출
  - `LOCAL`: 로컬 스코어링
  - `AUTO`: python 시도 후 실패 시 local fallback
- Output: `Zone4Madness` (`score`, `stage`, `sentiment`, `newsVelocity`)
- Debug API: `GET /api/zone4/state`

## Zone 5 Runtime Details
- Zone 5 Engine lifecycle: `createRuntimeState()`에서 생성 후 런타임 동안 재사용
- Input: `stepRuntime()`에서 `DashboardSnapshot` skeleton + `Zone3PatternMatch` + `Zone4Madness` + `Zone6HistoryFeedback` 전달
- Provider model:
  - `LLM`: OpenAI-compatible `/chat/completions` 호출
  - `RULE`: deterministic 로컬 룰 의사결정
  - `AUTO`: LLM 시도 후 실패 시 RULE fallback
- Core outputs:
  - `Zone5Decision` (`BUY/SELL/PASS`, confidence, reasoning)
  - `Zone5ActionOrderTemplate` (시장가 주문 템플릿)
  - `Zone5StateArchive` (결정 시점 상태 JSON)
- Runtime integration:
  - `stepRuntime()`가 비동기 Zone5 평가를 기다린 후 의사결정을 주문으로 변환
  - `/health`에 zone5 provider/source/model/last decision 요약 포함
- Debug API: `GET /api/zone5/state`

## Zone 6 Runtime Details
- Zone 6 Engine lifecycle: `createRuntimeState()`에서 생성 후 런타임 동안 재사용
- Input (query): `stepRuntime()`에서 `symbol`, `Zone3PatternMatch`, `Zone4Madness` 전달
- Input (archive): AI `SELL` 주문으로 타겟 포지션 완전 청산 시 Zone5 archive + realized pnl 전달
- Provider model:
  - `PYTHON`: `services/python/zone6_worker.py` 호출
  - `LOCAL_VECTOR`: 로컬 벡터 조회/요약
  - `AUTO`: python 시도 후 실패 시 local fallback
- Core outputs:
  - `Zone6HistoryFeedback` (`similarTradeId`, `winRate`, `summary`)
  - 내부 history record store (최대 `ZONE6_MAX_RECORDS`)
- Runtime integration:
  - `stepRuntime()` 계산 순서에서 `Zone4 -> Zone6 -> Zone5` 유지
  - 매 tick 조회 + 청산 시점 적재를 동일 엔진에서 처리
- Debug API: `GET /api/zone6/state`

## Shared Contracts
- TypeScript 공통 스키마: `packages/contracts/src/index.ts`
- Python 공통 스키마: `services/python/common/contracts.py`
