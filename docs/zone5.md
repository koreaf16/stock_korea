# Zone 5: Master Decision & State Generator (최종 매매 결단)

## 1. 개요 (Overview)
Zone 1~4의 실시간 분석 결과와 Zone 6 과거 피드백, 내 계좌 상태를 종합해 최종 `BUY/SELL/PASS` 결정을 만드는 중앙 의사결정 구역.
리스크 차단을 최우선으로 하고, 조건 충족 시 진입 비중/목표가/손절가까지 함께 산출한다.

## 2. 기술 스택 (Tech Stack)
* **Runtime**: Node.js (TypeScript)
* **LLM Provider (옵션)**: OpenAI-compatible API (`gpt-oss-20b`)
* **Fallback Engine**: Rule-based deterministic decision

## 3. 핵심 판단 로직 (Logic)
1. **리스크 최우선**
   * Kill-Switch 활성화 또는 Zone2 `BLOCKED`면 즉시 `PASS`/청산 우선
   * 예수금이 최소 기준 미만이면 신규 진입 차단
2. **통합 벡터 유사도 검색**
   * `TB_INTEGRATED_VECTOR_STATION`에서 `VECTOR_DISTANCE` 기반 Top-K 검색
   * Z1~Z4 유사도를 가중합하여 단일 유사도 점수 산출
   * 과거 `PROFIT_RATE` 라벨을 함께 집계해 기대값/승률 반영
3. **Cold Start 하이브리드 분기**
   * 유사 샘플 부족 시 Z1 수급 임계치(거래대금 폭발/체결 강도/호가 불균형) 1차 체크
   * LLM Zero-shot으로 “데이터 공백 상태에서 Z3+Z4 진입 타당성” 추가 판단
   * 초기 구간은 수익 극대화보다 고해상도 데이터 수집 목적의 소량 모의매매 우선
4. **결정 스냅샷 생성**
   * 의사결정 시점의 핵심 상태를 `Zone5StateArchive` JSON으로 생성

## 4. 입출력 (I/O)
* **Input**: `DashboardSnapshot`, `Zone3PatternMatch`, `Zone4Madness`, `Zone6HistoryFeedback`
* **Output**:
  * `Zone5Decision` (`action`, `confidenceScore`, `reasoning`, `suggestedWeightPct`)
  * `Zone5ActionOrderTemplate` (시장가 주문 템플릿)
  * `Zone5StateArchive` (결정 당시 상태 아카이브)

## 5. 현재 구현 상태 (v0 Skeleton)
아래 항목은 현재 코드에 반영된 Zone 5 구현 범위입니다.

### 5.1 구현 파일
* `apps/orchestrator/src/zones/zone5/decision.ts`
* `apps/orchestrator/src/state/store.ts`
* `apps/orchestrator/src/pipeline.ts`
* `apps/orchestrator/src/index.ts`

### 5.2 엔진 구조 (`Zone5Engine`)
`createZone5Engine()` 기반 상태형 엔진으로 동작합니다.
* `evaluate(input)`
  * safety gate(`kill-switch`, `risk-flag`, `min-cash`) 우선 평가
  * Oracle 통합 벡터 유사도 검색 후 warm/cold 경로 분기
  * cold-start에서는 Z1 임계치 + zero-shot LLM/휴리스틱으로 소량 진입 판단
  * warm-state에서는 가중 유사도 + 라벨 기반 기대값으로 결단
  * LLM 실패 시(`AUTO`) 규칙/하이브리드 엔진으로 fallback
* `getStateSnapshot()`
  * 최근 source, decision, error, vector-search 상태, action-order, archive JSON 조회

### 5.3 Provider 모델
* `ZONE5_PROVIDER=RULE`: 로컬 룰만 사용
* `ZONE5_PROVIDER=LLM`: LLM 결과만 사용 (오류 시 실패)
* `ZONE5_PROVIDER=AUTO`: LLM 시도 후 실패 시 룰 fallback

### 5.4 LLM 호출 방식
OpenAI-compatible `/chat/completions`를 호출하고, JSON 응답만 허용합니다.
* 요청 모델: `ZONE5_LLM_MODEL`
* 요청 URL: `ZONE5_LLM_BASE_URL` (미설정 시 `LLM_BASE_URL`)
* 타임아웃: `ZONE5_LLM_TIMEOUT_MS`

### 5.5 산출물
1. **최종 결정 (`Zone5Decision`)**
   * `action`: `BUY|SELL|PASS`
   * `confidenceScore`: 0~1
   * `reasoning`: 의사결정 근거 텍스트
2. **주문 템플릿 (`Zone5ActionOrderTemplate`)**
   * 의사결정 결과를 실행 가능한 시장가 주문 템플릿으로 변환
3. **상태 아카이브 (`Zone5StateArchive`)**
   * 계좌/Zone 핵심 수치를 저장 가능한 JSON으로 생성

### 5.6 운영 확인 API
* `GET /api/zone5/state`: Zone5 provider/source/최근 결정/오류 상태 조회
* `GET /health`: zone5 요약(provider/source/model/최근결정/오류) 포함

### 5.7 환경변수
* `ZONE5_PROVIDER` (`AUTO` | `LLM` | `RULE`)
* `ZONE5_LLM_BASE_URL`
* `ZONE5_LLM_MODEL`
* `ZONE5_LLM_TIMEOUT_MS`
* `ZONE5_MIN_CASH`
* `ZONE5_MAX_WEIGHT`
* `ZONE5_MIN_PATTERN_SIMILARITY`
* `ZONE5_REQUIRED_MADNESS_STAGE`
* `ZONE5_VECTOR_SEARCH_ENABLED`
* `ZONE5_VECTOR_TOP_K`
* `ZONE5_VECTOR_MIN_SIMILAR_ROWS`
* `ZONE5_VECTOR_MIN_LABELED_ROWS`
* `ZONE5_VECTOR_MIN_WEIGHTED_SIMILARITY`
* `ZONE5_VEC_WEIGHT_Z1`, `ZONE5_VEC_WEIGHT_Z2`, `ZONE5_VEC_WEIGHT_Z3`, `ZONE5_VEC_WEIGHT_Z4`
* `ZONE5_COLD_Z1_SPIKE_THRESHOLD`
* `ZONE5_COLD_Z1_VOLUME_POWER_THRESHOLD`
* `ZONE5_COLD_Z1_IMBALANCE_MAX`
* `ZONE5_COLLECTION_WEIGHT_PCT`
* `ZONE5_COLLECTION_TARGET_LABELED_ROWS`

### 5.8 현재 한계
* Oracle 실주문/체결 DB 연동은 미구현 (현재는 시뮬레이션 체결)
* Z1~Z4 실임베딩 벡터를 직접 질의하지 않고, 런타임 수치 기반 의사벡터로 검색
* LLM prompt/guardrail은 1차 버전이며 도메인 튜닝은 TODO

### 5.9 DB 매핑 (생성 완료)
* 의사결정 로그 테이블: `TB_ZONE5_DECISION_LOG`
* 파티셔닝: 일 단위 RANGE + INTERVAL
* 인덱스: `IX_Z5_DEC_SYM_TS` (LOCAL)
* DDL: `db/oracle/init_schema.sql`

## 대용량 테이블들은 처음부터 오라클 파티셔닝을 감안해서 만들어 가능하면 global index는 쓰지 않도록 해줘
## 벡터인덱스는 어쩔수 없는경우에는 그냥 global index를 써도 되
