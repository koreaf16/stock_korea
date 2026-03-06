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
* Zone0 실소스(KIS/Naver/Telegram) 연결 전이라 pulse 자체는 mock 기반
* Python worker는 deterministic scoring skeleton 단계
* 즉, 현재는 인터페이스/운영 플로우 중심 구현

### 5.7 DB 매핑 (생성 완료)
* 광기지수 로그 테이블: `TB_ZONE4_MADNESS_LOG`
* 파티셔닝: 일 단위 RANGE + INTERVAL
* 인덱스: `IX_Z4_MAD_SYM_TS` (LOCAL)
* DDL: `db/oracle/init_schema.sql`

## 대용량 테이블들은 처음부터 오라클 파티셔닝을 감안해서 만들어 가능하면 global index는 쓰지 않도록 해줘 
