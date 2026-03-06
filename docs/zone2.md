# Zone 2: Fundamental Filter (생존 방어선)

## 1. 개요 (Overview)
상장폐지, 거래정지, 쏟아지는 악성 매물(CB/BW) 등으로 인한 '깡통 계좌' 리스크를 원천 차단하는 킬스위치(Kill-Switch) 구역. 

## 2. 기술 스택 (Tech Stack)
* **Runtime**: Python 3.x (Batch/Background Worker)
* **Database**: Oracle 26ai (`192.168.0.120:1521/AI_DB`)

## 3. 데이터 소스 및 점검 항목 (Checklist)
1. **DART 전자공시**: 최근 3개월 내 대규모 전환사채(CB), 신주인수권부사채(BW), 유상증자(주주배정) 이력 여부
2. **KRX 시장 조치**: 투자경고, 투자위험, 관리종목 지정 여부
3. **재무 상태표**: 완전 자본잠식 등 극단적 재무 불건전성 (네이버/FnGuide 크롤링)

## 4. 입출력 (I/O)
* **Input**: DART API 및 외부 재무 크롤링 데이터
* **Output**: Oracle DB `TB_ZONE2_FUNDAMENTAL` 테이블에 종목별 리스크 플래그(True/False) 업데이트. 매매 직전 Node.js가 조회하여 False 시 즉시 PASS 처리.

## 5. 현재 구현 상태 (v0 Skeleton)
아래 항목은 현재 코드에 반영된 Zone 2 구현 범위입니다.

### 5.1 구현 파일
* `apps/orchestrator/src/zones/zone2/fundamental.ts`
* `apps/orchestrator/src/state/store.ts`
* `apps/orchestrator/src/pipeline.ts`
* `apps/orchestrator/src/index.ts`
* `services/python/zone2_worker.py`
* `services/python/common/contracts.py`

### 5.2 엔진 구조
Node.js Orchestrator에 `Zone2Engine`을 붙여 매 tick마다 아래 순서로 동작합니다.
1. 캐시 유효성 검사 (`ZONE2_REFRESH_TICKS`, `ZONE2_STALE_SECONDS`)
2. provider(`AUTO`/`PYTHON`/`MOCK`) 기준 리스크 조회
3. 결과를 `Zone2Fundamental`(`CLEAR`/`BLOCKED`)로 표준화
4. Zone5 의사결정 입력으로 전달

### 5.3 체크리스트 반영 항목
문서의 3개 점검 항목을 현재 구조에 매핑했습니다.
1. **DART 공시 리스크**: CB/BW/유상증자 여부 (`has_cb_bw_issue`)
2. **KRX 조치 리스크**: 투자경고/투자위험/관리종목 여부 (`has_krx_warning`)
3. **재무 리스크**: 완전 자본잠식 등 (`has_capital_impairment`)

하나라도 true면 `risk_flag = BLOCKED`, 아니면 `CLEAR`입니다.

### 5.4 Python 워커 연계
`ZONE2_PROVIDER=AUTO|PYTHON`일 때 Node가 `zone2_worker.py`를 호출합니다.
* Python 실행 실패/미설치 시 자동으로 `MOCK` fallback
* `ZONE2_PYTHON_CMD`로 python 실행 명령 지정 가능

### 5.5 운영 확인 API
* `GET /api/zone2/state`: provider/source/cache/마지막 체크 시각 조회
* `GET /health`: zone2 요약(provider/source/cache/lastCheckedAt) 포함

### 5.6 환경변수
* `ZONE2_PROVIDER` (`AUTO` | `PYTHON` | `MOCK`)
* `ZONE2_REFRESH_TICKS`
* `ZONE2_STALE_SECONDS`
* `ZONE2_PYTHON_CMD`
* `ZONE2_FORCE_BLOCKED_SYMBOLS` (강제 차단 심볼 목록)

### 5.7 현재 한계
* Oracle `TB_ZONE2_FUNDAMENTAL` 실DB read/write 로직은 아직 엔진에 미연결
* DART/KRX/FnGuide 실크롤링은 Python 워커 mock/deterministic 단계
* 즉, 현재는 인터페이스/운영 플로우 중심의 skeleton 구현

### 5.8 DB 매핑 (생성 완료)
* 리스크 캐시 테이블: `TB_ZONE2_FUNDAMENTAL`
* 인덱스: `IX_Z2_FUND_CHECKED_AT`
* DDL: `db/oracle/init_schema.sql`

## 대용량 테이블들은 처음부터 오라클 파티셔닝을 감안해서 만들어 가능하면 global index는 쓰지 않도록 해줘 
## 벡터인덱스는 어쩔수 없는경우에는 그냥 global index를 써도 되
