# Oracle DB Schema & Runbook

## 1. 개요
Zone0~6 운영을 위한 Oracle 기본 스키마를 `db/oracle/init_schema.sql`로 생성합니다.
대용량 로그 테이블은 파티셔닝을 적용했고, 일반 인덱스는 `LOCAL` 기준으로 구성했습니다.
벡터 검색용 인덱스는 Zone3/Zone6에 생성했습니다.

## 2. 생성 스크립트
* SQL: `db/oracle/init_schema.sql`
* 실행 스크립트: `scripts/db-init.ps1`
* npm 명령: `npm run db:init`

## 3. 테이블 매핑
1. `TB_ZONE0_EVENT_RAW` (Zone0 raw event log, 일 단위 파티션)
2. `TB_ZONE1_TECHNICAL_LOG` (Zone1 지표 로그, 일 단위 파티션)
3. `TB_ZONE2_FUNDAMENTAL` (Zone2 리스크 캐시/결과 테이블)
4. `TB_ZONE3_PATTERN_LIBRARY` (Zone3 패턴 라이브러리 + `VECTOR(1024, FLOAT32)`)
5. `TB_ZONE4_MADNESS_LOG` (Zone4 지수 로그, 일 단위 파티션)
6. `TB_ZONE5_DECISION_LOG` (Zone5 의사결정 로그, 일 단위 파티션)
7. `TB_TRADE_HISTORY` (Zone6 히스토리 + 벡터, 월 단위 파티션)

## 4. 인덱스 정책
* 대용량 파티션 테이블 인덱스: `LOCAL`
* Zone3 벡터 인덱스: `IX_Z3_PATTERN_VEC`
* Zone6 벡터 인덱스: `IX_Z6_TRADE_VEC`

## 5. 실행 결과 (2026-03-06)
`npm run db:init` 기준 아래 오브젝트 생성 확인:
* 7개 테이블 생성 완료
* 파티션 테이블 5개 생성 완료
* LOCAL 인덱스 생성 완료
* VECTOR 인덱스 2개 생성 완료 (`IX_Z3_PATTERN_VEC`, `IX_Z6_TRADE_VEC`)

## 6. 운영 확인 명령
```bash
npm run db:init
npm run build -w @stock/contracts && npm run build -w @stock/orchestrator
npm run verify:zones
```

## 7. 현재 범위
현재 단계는 **스키마 생성 + 런타임 존 통합 검증**까지 완료된 상태입니다.
Zone2/Zone6의 Oracle 실시간 read/write 연결은 다음 단계에서 Orchestrator/Python worker에 추가 구현이 필요합니다.
