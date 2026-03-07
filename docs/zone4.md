# Zone 4: Madness Gauge (감성/광기 지수)

## 1. 개요 (Overview)
Zone 0의 뉴스/종토방/텔레그램 원문에서 감성 흐름을 실시간으로 요약해 0~100 광기 지수로 변환하는 구역.
Zone 3 패턴 유사도 및 Zone 1 변동성 지표와 결합되어 Zone 5의 최종 판단에 사용된다.

## 2. 기술 스택 (Tech Stack)
* **Runtime**: Node.js (TypeScript)
* **Worker (옵션)**: Python 3.x (`zone4_worker.py`)
* **Input Source**: Zone 0 sentiment pulse + Zone1/Zone3 요약값

## 3. 핵심 로직 (Logic)
1. Zone0에서 전달된 감성 pulse(`score`, `velocity`, `signalCount`) 수신
2. 최근 1분 social signal rate(종토방/뉴스/텔레그램 발생량) 계산
3. Zone1(`spikeRatio`, `volumePower`, `maDivergence`) + Zone3(`similarity`)와 결합
4. EMA smoothing 후 0~100 점수 산출
5. 임계값 기반 stage 분류
   * STAGE_1: 발화 구간
   * STAGE_2: 폭발 구간
   * STAGE_3: 광기 구간

## 4. 입출력 (I/O)
* **Input**: `Zone0SentimentPulse`, `Zone1Technical`, `Zone3PatternMatch`
* **Output**: `Zone4Madness` (`score`, `stage`, `sentiment`, `newsVelocity`)

## 5. 현재 구현 상태 (v0 Skeleton)
아래 항목은 현재 코드에 반영된 Zone 4 구현 범위입니다.

### 5.1 구현 파일
* `apps/orchestrator/src/zones/zone4/madness.ts`
* `apps/orchestrator/src/state/store.ts`
* `apps/orchestrator/src/pipeline.ts`
* `apps/orchestrator/src/index.ts`
* `services/python/zone4_worker.py`

### 5.2 엔진 구조
Node.js Orchestrator에 `Zone4Engine`을 붙여 매 tick마다 아래 순서로 동작합니다.
1. sentiment pulse 반영 + 1분 signal-rate 계산
2. local score 산출 (기술/패턴/감성 결합)
3. EMA smoothing으로 노이즈 완화
4. provider(`AUTO`/`PYTHON`/`LOCAL`) 기준 최종 점수 확정
5. stage 판정 후 Zone5 입력으로 전달

### 5.3 Provider 모델
* `ZONE4_PROVIDER=LOCAL`: 로컬 계산만 사용
* `ZONE4_PROVIDER=PYTHON`: Python worker 결과 사용
* `ZONE4_PROVIDER=AUTO`: Python 시도 후 실패 시 로컬 fallback

### 5.4 운영 확인 API
* `GET /api/zone4/state`: provider/source, signalRate1m, lastScore, lastStage 조회
* `GET /health`: zone4 요약(provider/source/lastScore/lastStage) 포함

### 5.5 환경변수
* `ZONE4_PROVIDER` (`AUTO` | `PYTHON` | `LOCAL`)
* `ZONE4_STAGE2_THRESHOLD`
* `ZONE4_STAGE3_THRESHOLD`
* `ZONE4_EMA_ALPHA`
* `ZONE4_PYTHON_CMD`

### 5.6 현재 한계
* Zone0 실소스가 연결되어 pulse는 실데이터 기반으로 계산됨 (단, 키 미설정 소스는 비활성)
* Python worker는 deterministic scoring skeleton 단계
* 즉, 현재는 인터페이스/운영 플로우 중심 구현

### 5.7 DB 매핑 (Step 1: Raw/Vector 분리)
* Raw 뉴스 로그 테이블: `TB_ZONE4_NEWS_RAW` (벡터 컬럼 없음)
* 파티셔닝: 일 단위 RANGE + INTERVAL
* 인덱스: `IX_Z4_NEWS_SYM_TS` (LOCAL)
* 이벤트 벡터 저장: `TB_INTEGRATED_VECTOR_STATION.Z4_SENT_VEC` (`VECTOR(768, FLOAT32)`)
* DDL: `db/oracle/step1_integrated_vector_schema.sql`

## 대용량 테이블들은 처음부터 오라클 파티셔닝을 감안해서 만들어 가능하면 global index는 쓰지 않도록 해줘 

## 6. Zone 4 고도화 구현 (2026-03)
현재 코드 기준으로 Zone4는 단순 텍스트 임베딩이 아니라, 시장 충격량/신선도까지 포함하는 하이브리드 파이프라인으로 동작한다.

### 6.1 Raw 수집/저장 확장
`TB_ZONE4_NEWS_RAW` 저장 시 아래 메타데이터를 함께 기록한다.
- `NEWS_TS_MS`: 밀리초 단위 타임스탬프
- `SOURCE_CLASS`, `SOURCE_SCORE`: 출처 등급/신뢰도
- `KEYWORDS_JSON`, `KEYWORD_STRENGTH`: 촉매 키워드/강도
- `SPIKE_TS`, `REACTION_LATENCY_MS`, `TEMPO_LABEL`: 반응 레이턴시 및 품질 라벨
- `SHOCK_SCORE`, `SECTOR_COUPLING_IDX`, `LLM_POTENTIAL_SCORE`: 충격량/섹터 연동/콜드스타트 잠재력

관련 구현:
- `apps/orchestrator/src/db/oracle-persistence.ts`
- `db/oracle/step1_integrated_vector_schema.sql`

### 6.2 반응 레이턴시(Tempo) 계산
- `T_news`: 뉴스 시각 (`TB_ZONE4_NEWS_RAW.news_ts`)
- `T_spike`: `TB_ZONE1_TICK_RAW`에서 거래량 급증(기준 평균 대비 3배) 최초 시점
- `ΔT = T_spike - T_news`
- 라벨:
  - `<= 1초`: `HIGH_QUALITY`
  - `>= 60초`: `LOW_QUALITY`
  - 그 외: `MID_QUALITY`
  - 미탐지: `NO_SPIKE`

### 6.3 RTX 3090 하이브리드 임베딩(768d)
`services/python/zone_integrated_miner.py`에서 Z4 임베딩을 아래처럼 구성한다.
- Text embedding 700d: 뉴스/메타 텍스트를 임베딩 후 700차원으로 정규 투영
- Numeric feature 68d: `ΔT`, 출처신뢰도, 키워드강도, 섹터커플링, shock, zero-shot score 등 수치 피처
- 최종 768d: `[700d text] + [68d numeric]` 결합 후 L2 정규화
- 저장 컬럼: `TB_INTEGRATED_VECTOR_STATION.Z4_SENT_VEC`

### 6.4 수익률 가중 유사도 검색
- Node Zone5 유사도 쿼리에서 `VECTOR_DISTANCE(..., COSINE)` 기반 가중합을 계산
- Z4는 `profit_rate` 양수 구간에 가중치를 부여한 `news_weighted_score`를 별도 산출
- 결과로 `z4ExpectedProfitRate`, `z4TopCases`를 만들고 LLM 입력 payload에 포함

관련 구현:
- `apps/orchestrator/src/zones/zone5/decision.ts`

### 6.5 콜드스타트 보강
- 라벨 데이터 부족 시 Rule + Zero-shot LLM 혼합 판단
- 목적은 초기 수익 극대화가 아니라 고해상도 라벨 데이터 축적
- Zone4 쪽에서도 zero-shot 잠재력 점수(`LLM_POTENTIAL_SCORE`)를 피처에 주입
