# Zone 3: Pattern Vector Matching (구조적 패턴 검색)

## 1. 개요 (Overview)
현재 그려지고 있는 30분 분봉의 궤적이 과거의 어떤 타겟 패턴(폭등/폭락)과 유사한지 수치적으로 증명하는 확률 구역.

## 2. 기술 스택 (Tech Stack)
* **Data Miner**: Python (장 종료 후 네이버 금융 과거 분봉 스크래핑 및 라벨링)
* **Search Engine**: Oracle 26ai (AI Vector Search)

## 3. 핵심 로직 (Logic)
1. 과거 +15% 이상 급등한 차트(CLASS_A)와 -10% 이상 투매가 나온 차트(CLASS_C)의 상승 직전 30분 분봉을 정규화하여 1024차원 배열로 저장.
2. 장중 현재 종목의 30분 분봉 궤적을 실시간으로 벡터화.
3. Oracle DB에 코사인 유사도(Cosine Similarity) 쿼리를 던져 가장 가까운 패턴 탐색.

## 4. 입출력 (I/O)
* **Input**: 현재 주가의 30분 시계열 OHLVC 배열
* **Output**: `CLASS_A와 94% 일치`와 같은 유사도 스코어 산출 후 Zone 5로 전달.

## 5. 현재 구현 상태 (v0 Skeleton)
아래 항목은 현재 코드에 반영된 Zone 3 구현 범위입니다.

### 5.1 구현 파일
* `apps/orchestrator/src/zones/zone3/pattern.ts`
* `apps/orchestrator/src/state/store.ts`
* `apps/orchestrator/src/pipeline.ts`
* `apps/orchestrator/src/index.ts`
* `services/python/zone3_worker.py`

### 5.2 엔진 구조
Node.js Orchestrator에 `Zone3Engine`을 붙여 매 tick마다 아래 순서로 동작합니다.
1. Tick을 1분 캔들(OHLVC)로 집계
2. 최근 `ZONE3_CANDLE_WINDOW_MINUTES`(기본 30분) 캔들 유지
3. 시계열을 `ZONE3_VECTOR_DIM`(기본 1024) 차원으로 벡터화
4. 코사인 유사도로 reference pattern(CLASS_A/B/C) 탐색
5. `Zone3PatternMatch` 결과를 Zone5 입력으로 전달

### 5.3 벡터/매칭 로직 반영
* 입력: 실시간 1분 OHLVC 캔들 윈도우
* 벡터화: 가격/거래량 정규화 후 리샘플링
* 탐색: 로컬 reference 라이브러리 기반 cosine similarity
* 보정: Zone1 지표(spike, volumePower, imbalance)를 유사도 nudge로 반영

### 5.4 Provider 모델
* `ZONE3_PROVIDER=LOCAL_VECTOR`: 로컬 벡터 매칭만 사용
* `ZONE3_PROVIDER=PYTHON`: Python worker 결과 사용
* `ZONE3_PROVIDER=AUTO`: Python 시도 후 실패 시 로컬 fallback

### 5.5 운영 확인 API
* `GET /api/zone3/state`: provider/source, candleCount, vectorDim, 마지막 매칭 결과
* `GET /health`: zone3 요약(provider/source/candleCount/lastSimilarity) 포함

### 5.6 환경변수
* `ZONE3_PROVIDER` (`AUTO` | `PYTHON` | `LOCAL_VECTOR`)
* `ZONE3_VECTOR_DIM`
* `ZONE3_CANDLE_WINDOW_MINUTES`
* `ZONE3_MIN_CANDLES`
* `ZONE3_PYTHON_CMD`

### 5.7 현재 한계
* Oracle 26ai 실제 Vector Search SQL 연결은 아직 미연결
* Python data miner(과거 분봉 라벨링) 및 Oracle 벡터 적재 파이프라인은 TODO
* 현재는 인터페이스/엔진/운영 플로우 중심의 skeleton 구현

### 5.8 DB 매핑 (생성 완료)
* 패턴 라이브러리 테이블: `TB_ZONE3_PATTERN_LIBRARY`
* 벡터 컬럼: `PATTERN_VECTOR VECTOR(1024, FLOAT32)`
* 인덱스:
  * `IX_Z3_CLASS_CREATED`
  * `IX_Z3_PATTERN_VEC` (VECTOR)
* DDL: `db/oracle/init_schema.sql`

## 대용량 테이블들은 처음부터 오라클 파티셔닝을 감안해서 만들어 가능하면 global index는 쓰지 않도록 해줘 
## 벡터인덱스는 어쩔수 없는경우에는 그냥 global index를 써도 되
