# Zone 6: History & Feedback Loop (진화 아카이브)

## 1. 개요 (Overview)
매매 종료 시점의 결과를 통합 벡터 이벤트(`TB_INTEGRATED_VECTOR_STATION`)에 라벨링하고, 성공/실패 사례를 `TB_PATTERN_LIBRARY`로 지식화하는 구역.
즉, Zone5가 판단한 스냅샷을 손익 레이블과 복기 일기로 되돌려, 다음 판단의 학습 재료로 누적한다.

## 2. 기술 스택 (Tech Stack)
* **Runtime**: Node.js (TypeScript)
* **Worker (옵션)**: Python 3.x (`zone6_worker.py`)
* **DB**: Oracle 26ai (`TB_INTEGRATED_VECTOR_STATION`, `TB_PATTERN_LIBRARY`)
* **LLM 복기(옵션)**: OpenAI-compatible API

## 3. 핵심 로직 (Logic)
1. **피드백 조회 (Before Decision)**
   * Zone3 패턴/Zone4 광기 상태를 벡터화
   * 과거 기록과 유사도 비교 후 예상 승률(`winRate`) 반환
2. **결과 적재 (After Trade Close)**
   * Zone5의 `state archive` + 실제 청산 손익(%)를 결합해 히스토리 레코드 생성
   * 레코드를 로컬 메모리 벡터 스토어에 적재 (최대 보관 수 제한)
3. **통합 이벤트 라벨링**
   * 종료 거래를 `TB_INTEGRATED_VECTOR_STATION` 이벤트로 매핑
   * 해당 `EVENT_ID`의 `PROFIT_RATE`를 업데이트
4. **패턴 지식화 + 복기**
   * 통합 이벤트의 Z1~Z4 벡터를 `TB_PATTERN_LIBRARY`로 복사하여 성공/실패 라벨 저장
   * 매매 결과 + 벡터 digest를 LLM에 전달해 복기 일기(`review_diary`) 생성
5. **다음 의사결정 반영**
   * Zone5 입력인 `Zone6HistoryFeedback`에 `similarTradeId`, `winRate`, `summary` 제공

## 4. 입출력 (I/O)
* **Input (조회)**: `symbol`, `Zone3PatternMatch`, `Zone4Madness`
* **Input (적재)**: `Zone5StateArchive JSON`, `realizedPnlPct`
* **Output**: `Zone6HistoryFeedback`

## 5. 현재 구현 상태 (v0 Skeleton)
아래 항목은 현재 코드에 반영된 Zone 6 구현 범위입니다.

### 5.1 구현 파일
* `apps/orchestrator/src/zones/zone6/history.ts`
* `apps/orchestrator/src/state/store.ts`
* `apps/orchestrator/src/pipeline.ts`
* `apps/orchestrator/src/index.ts`
* `services/python/zone6_worker.py`

### 5.2 엔진 구조 (`Zone6Engine`)
`createZone6Engine()` 기반 상태형 엔진으로 동작합니다.
* `evaluate(input)`
  * provider(`AUTO`/`PYTHON`/`LOCAL_VECTOR`) 기준 피드백 생성
  * 기본 로컬 벡터 조회 결과를 만들고, Python 결과가 있으면 override
* `recordTradeOutcome(input)`
  * Zone5 archive + 청산 손익을 레코드로 적재
  * `ZONE6_MAX_RECORDS` 초과 시 오래된 기록부터 제거
  * Oracle 연결 시 비동기 큐로 아래 순서 실행
    * 통합 이벤트 매핑(`EVENT_ID`)
    * `TB_INTEGRATED_VECTOR_STATION.PROFIT_RATE` 업데이트
    * `TB_PATTERN_LIBRARY` 업서트(벡터/라벨/archive/review)
    * LLM 복기 생성(실패 시 RULE 복기 fallback)
* `getStateSnapshot()`
  * provider/source, DB provider, 큐 상태, 최근 매핑/패턴/복기 상태 반환

### 5.3 조회/적재 타이밍
* **조회**: `stepRuntime()` 내 `Zone4 -> Zone6 -> Zone5` 순서에서 매 tick 수행
* **적재**: AI `SELL` 주문으로 타겟 포지션이 완전 청산된 시점에 수행

### 5.4 Provider 모델
* `ZONE6_PROVIDER=LOCAL_VECTOR`: 로컬 벡터 조회만 사용
* `ZONE6_PROVIDER=PYTHON`: Python worker 결과 우선 사용
* `ZONE6_PROVIDER=AUTO`: Python 시도 후 실패 시 로컬 결과 사용

### 5.5 운영 확인 API
* `GET /api/zone6/state`: zone6 내부 상태(provider/source/recordCount/최근 조회·적재 결과)
* `GET /health`: zone6 요약(provider/source/recordCount/lastWinRate 등) 포함

### 5.6 환경변수
* `ZONE6_PROVIDER` (`AUTO` | `PYTHON` | `LOCAL_VECTOR`)
* `ZONE6_VECTOR_DIM`
* `ZONE6_MAX_RECORDS`
* `ZONE6_MIN_SIMILARITY`
* `ZONE6_PYTHON_CMD`
* `ZONE6_EVENT_MATCH_WINDOW_SEC` (통합 이벤트 매핑 허용 오차)
* `ZONE6_DB_CALL_TIMEOUT_MS`
* `ZONE6_REVIEW_PROVIDER` (`AUTO` | `LLM` | `RULE`)
* `ZONE6_LLM_BASE_URL` (`ZONE5_LLM_BASE_URL`/`LLM_BASE_URL` fallback)
* `ZONE6_LLM_MODEL`
* `ZONE6_LLM_TIMEOUT_MS`
* `ZONE6_REVIEW_MAX_CHARS`
* `ZONE6_REVIEW_VECTOR_HEAD` (LLM에 전달할 벡터 head 길이)

### 5.7 현재 한계
* `text-embedding-bge-m3` 실임베딩 호출 대신 해시 기반 임베딩 사용
* Zone6 조회 피드백은 아직 인메모리 벡터 기반이며, `TB_PATTERN_LIBRARY` 직접 검색 로직은 후속 단계

### 5.8 DB 매핑 (Step 1: Raw/Vector 분리)
* 히스토리 저장 테이블: `TB_TRADE_HISTORY` (벡터 컬럼 없음)
* 파티셔닝: 월 단위 RANGE + INTERVAL
* 인덱스: `IX_Z6_TRADE_SYM_TS` (LOCAL)
* 이벤트 벡터 저장: `TB_INTEGRATED_VECTOR_STATION` (HNSW 벡터 인덱스 4종)
* 지식 패턴 저장: `TB_PATTERN_LIBRARY` (Z1~Z4 벡터 + `PROFIT_RATE` + `REVIEW_DIARY`)
* DDL:
  * `db/oracle/init_schema.sql`
  * `db/oracle/step1_integrated_vector_schema.sql`

## 대용량 테이블들은 처음부터 오라클 파티셔닝을 감안해서 만들어 가능하면 global index는 쓰지 않도록 해줘
## 벡터인덱스는 어쩔수 없는경우에는 그냥 global index를 써도 되
