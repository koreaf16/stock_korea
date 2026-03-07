# Oracle DB Schema & Runbook

## 1. 개요
Zone0~6 운영 기본 스키마는 `db/oracle/init_schema.sql`로 생성합니다.
Step 1(통합 벡터 스키마)은 `db/oracle/step1_integrated_vector_schema.sql`로 분리해 관리합니다.
핵심 원칙은 **원본 로그(벡터 없음)와 판단용 벡터(통합 테이블) 분리**입니다.

## 2. 생성 스크립트
* SQL: `db/oracle/init_schema.sql`
* SQL (Step 1): `db/oracle/step1_integrated_vector_schema.sql`
* 실행 스크립트: `scripts/db-init.ps1`
* npm 명령: `npm run db:init`

## 3. Step 1 테이블 매핑
1. `TB_ZONE0_EVENT_RAW` (Zone0 raw event log, 일 단위 파티션)
2. `TB_ZONE1_TICK_RAW` (Zone1 틱 raw 로그, 벡터 없음, 일 단위 파티션)
3. `TB_ZONE2_FUNDAMENTAL` (Zone2 리스크 캐시/결과 테이블)
4. `TB_ZONE3_CANDLE_RAW` (Zone3 캔들 raw 로그, 벡터 없음, 일 단위 파티션)
5. `TB_ZONE4_NEWS_RAW` (Zone4 뉴스 raw 로그, 벡터 없음, 일 단위 파티션)
6. `TB_ZONE5_DECISION_LOG` (Zone5 의사결정 로그, 일 단위 파티션)
7. `TB_TRADE_HISTORY` (Zone6 히스토리, 월 단위 파티션)
8. `TB_INTEGRATED_VECTOR_STATION` (이벤트 스냅샷 통합 벡터 저장소)
9. `TB_PATTERN_LIBRARY` (Zone6 학습 패턴 라이브러리, 월 단위 파티션)

## 4. 인덱스 정책
* 대용량 파티션 테이블 인덱스: `LOCAL`
* 통합 벡터 인덱스(HNSW, Oracle 26ai):
  * `IX_IVS_Z1_TECH_HNSW` on `Z1_TECH_VEC`
  * `IX_IVS_Z2_FUND_HNSW` on `Z2_FUND_VEC`
  * `IX_IVS_Z3_CHART_HNSW` on `Z3_CHART_VEC`
  * `IX_IVS_Z4_SENT_HNSW` on `Z4_SENT_VEC`
* 패턴 라이브러리 벡터 인덱스(HNSW):
  * `IX_PAT_Z1_TECH_HNSW` on `Z1_TECH_VEC`
  * `IX_PAT_Z2_FUND_HNSW` on `Z2_FUND_VEC`
  * `IX_PAT_Z3_CHART_HNSW` on `Z3_CHART_VEC`
  * `IX_PAT_Z4_SENT_HNSW` on `Z4_SENT_VEC`
* 레거시 벡터 인덱스/컬럼은 Step 1 스크립트에서 제거
* 성능 옵션:
  * `TB_INTEGRATED_VECTOR_STATION`에 In-Memory 활성화
  * `TB_PATTERN_LIBRARY`에 In-Memory 활성화
  * 벡터 인덱스는 `organization inmemory neighbor graph` 사용

## 5. 운영 확인 명령
```bash
npm run db:init
npm run build -w @stock/contracts && npm run build -w @stock/orchestrator
npm run verify:zones
```

## 6. 현재 범위
현재 문서는 Step 1 스키마(원본 로그/통합 벡터 분리) 기준입니다.
애플리케이션의 실시간 read/write 경로는 다음 단계에서 순차 연결이 필요합니다.
