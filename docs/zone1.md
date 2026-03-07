# Zone 1: Technical Indicators (기술적 지표 연산)

## 1. 개요 (Overview)
Zone 0에서 유입된 실시간 틱/호가 데이터를 바탕으로 '현재 주가의 구조적 위치'와 '돌파 가능성'을 1초 단위로 계산하는 정석 타점 구역.

## 2. 기술 스택 (Tech Stack)
* **Runtime**: Node.js (배열 기반 고속 인메모리 연산)
* **Logic**: 시간 복잡도 O(1)에 가까운 스트림 처리 지향

## 3. 핵심 산출 지표 (Metrics)
1. **체결 강도 (Volume Power)**: 매수 체결량 / 매도 체결량 (KIS 제공 데이터 활용)
2. **거래대금 스파이크 (Spike Ratio)**: 직전 1분 대비 최근 1분간의 폭발적 거래량 증가 퍼센티지(%)
3. **단기 이평선 이격도 (Moving Average Divergence)**: 3분/5분 이동평균선 대비 현재가의 이격률 (과매수/과매도 판별)
4. **호가 잔량비 (Order Imbalance)**: 매도 10호가 총잔량 vs 매수 10호가 총잔량 비율
5. **당일 지지/저항선 (Support/Resistance)**: 장중 고점/저점/시가 기반 계산

## 4. 입출력 (I/O)
* **Input**: Zone 0의 KIS 실시간 스트리밍 데이터
* **Output**: Zone 5로 전달될 `Zone1_Technical` JSON 객체 (현재 타점 요약본)

## 5. 현재 구현 상태 (v0 Skeleton)
아래 항목은 현재 코드에 반영된 Zone 1 구현 범위입니다.

### 5.1 구현 파일
* `apps/orchestrator/src/zones/zone1/technical.ts`
* `apps/orchestrator/src/state/store.ts`
* `apps/orchestrator/src/pipeline.ts`
* `apps/orchestrator/src/index.ts`

### 5.2 스트림 처리 방식
Zone0의 `tick + orderBook`를 입력으로 받아 상태 누적 계산합니다.
* 이벤트 기반 입력 기준(Zone0 `zone0:raw` 수신 시점)
* Ring Buffer 기반 윈도우 연산으로 O(1)에 가까운 업데이트
* 세션(일자) 변경 시 open/high/low 및 윈도우 상태 리셋

### 5.3 현재 반영된 산출 지표
문서의 5개 지표를 모두 계산합니다.
1. **Volume Power**  
   KIS 원시 체결강도(`volumePower`)가 존재하면 우선 사용하고, 미수신 시 체결량+호가 깊이 비중(가격 변동 bias 포함) 추정식으로 `buy/sell * 100` 계산
2. **Spike Ratio**  
   최근 1분 거래대금 합 / 직전 1분 거래대금 합 * 100
3. **MA Divergence**  
   3분/5분 이동평균 대비 현재가 이격률의 가중 결합값
4. **Order Imbalance**  
   매도 10호가 총잔량 / 매수 10호가 총잔량
5. **Support/Resistance**  
   당일 시가/고가/저가 기반 pivot 계산

### 5.4 운영 확인 API
* `GET /api/zone1/state`: Zone1 내부 상태(ma3/ma5, high/low, 1분 notional 등) 조회
* `GET /health`: zone1 요약(sessionDate/high/low/ma3/ma5) 포함

### 5.5 현재 한계
* KIS 원시 체결강도 미수신 구간에서는 Volume Power가 추정식 fallback으로 계산됨
* 1초 고정 tick 전제이므로 실시간 가변 지연 환경 보정 로직은 미구현

### 5.6 DB 매핑 (Step 1: Raw/Vector 분리)
* Raw 틱 로그 테이블: `TB_ZONE1_TICK_RAW` (벡터 컬럼 없음)
* 파티셔닝: 일 단위 RANGE + INTERVAL
* 인덱스: `IX_Z1_TICK_SYM_TS` (LOCAL)
* 이벤트 벡터 저장: `TB_INTEGRATED_VECTOR_STATION.Z1_TECH_VEC` (`VECTOR(128, FLOAT32)`)
* DDL: `db/oracle/step1_integrated_vector_schema.sql`

## 대용량 테이블들은 처음부터 오라클 파티셔닝을 감안해서 만들어 가능하면 global index는 쓰지 않도록 해줘 
## 벡터인덱스는 어쩔수 없는경우에는 그냥 global index를 써도 되
