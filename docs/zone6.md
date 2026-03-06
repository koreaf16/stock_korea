# Zone 6: History & Feedback Loop (진화 아카이브)

## 1. 개요 (Overview)
매매 종료 시점의 의사결정 맥락과 최종 손익을 기록하고, 다음 매매에서 현재 상황과 가장 유사한 과거 이력을 찾아 승률 피드백으로 되돌려주는 구역.
즉, Zone5가 판단하기 직전에 "과거의 나"를 참조하게 만드는 자기 진화 루프이다.

## 2. 기술 스택 (Tech Stack)
* **Runtime**: Node.js (TypeScript)
* **Worker (옵션)**: Python 3.x (`zone6_worker.py`)
* **Embedding/DB 목표**: `text-embedding-bge-m3` + Oracle 26ai Vector Search (현재 skeleton 단계)

## 3. 핵심 로직 (Logic)
1. **피드백 조회 (Before Decision)**
   * Zone3 패턴/Zone4 광기 상태를 벡터화
   * 과거 기록과 유사도 비교 후 예상 승률(`winRate`) 반환
2. **결과 적재 (After Trade Close)**
   * Zone5의 `state archive` + 실제 청산 손익(%)를 결합해 히스토리 레코드 생성
   * 레코드를 로컬 메모리 벡터 스토어에 적재 (최대 보관 수 제한)
3. **다음 의사결정 반영**
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
* `getStateSnapshot()`
  * provider/source, 레코드 수, 최근 조회/적재 상태, 에러 정보 반환

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

### 5.7 현재 한계
* Oracle `TB_TRADE_HISTORY` 실테이블 write/read 로직은 아직 엔진에 미연결 (현재 인메모리 스토어)
* `text-embedding-bge-m3` 실임베딩 호출 대신 해시 기반 임베딩 사용
* Python worker는 deterministic skeleton 단계

### 5.8 DB 매핑 (생성 완료)
* 히스토리 저장 테이블: `TB_TRADE_HISTORY`
* 파티셔닝: 월 단위 RANGE + INTERVAL
* 인덱스:
  * `IX_Z6_TRADE_SYM_TS` (LOCAL)
  * `IX_Z6_TRADE_VEC` (VECTOR)
* DDL: `db/oracle/init_schema.sql`

## 대용량 테이블들은 처음부터 오라클 파티셔닝을 감안해서 만들어 가능하면 global index는 쓰지 않도록 해줘
## 벡터인덱스는 어쩔수 없는경우에는 그냥 global index를 써도 되
