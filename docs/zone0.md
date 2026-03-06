# Zone 0: Raw Data Pipeline (원시 데이터 스트리밍)

## 1. 개요 (Overview)
외부 거래소/뉴스/커뮤니티/거시지표 소스에서 들어오는 원시 데이터를 수집하고, Zone 1/4 및 오케스트레이터 전체 파이프라인으로 전달하는 이벤트 기반 게이트웨이입니다.

## 2. 기술 스택 (Tech Stack)
* **Runtime**: Node.js (TypeScript)
* **Protocol**: KIS WebSocket + HTTP/REST + Telegram Webhook
* **Core Pattern**: EventEmitter + Buffer + Retry + Auto-reconnect

## 3. 데이터 소스 (Data Sources)
1. **KIS 실시간 체결 (`H0STCNT0`)**
2. **KIS 실시간 10호가 (`H0STASP0`)**
3. **네이버 뉴스 API (`openapi.naver.com`)**
4. **네이버 종토방 크롤링 (`finance.naver.com/item/board.naver`)**
5. **DART 공시 API (`opendart.fss.or.kr`)**
6. **시장 수급(KRX/KOSCOM)**
7. **거시지표(USD/KRW, US10Y)**
8. **Telegram 웹훅 (`POST /api/zone0/telegram-webhook`)**

## 4. 동적 심볼 풀 (Dynamic Symbol Pool)
고정 `SYMBOL_POOL`을 사용하지 않고, KIS REST 핫리스트 응답으로 감시 종목을 주기적으로 갱신합니다.

* 갱신 주기: `ZONE0_SYMBOL_POOL_REFRESH_MS` (기본 60초)
* 감시 개수: `ZONE0_SYMBOL_POOL_SIZE` (기본 12)
* 수동 타겟 지정: `setTargetSymbol()` 호출 시 해당 종목을 풀 상단에 고정(pinned)
* 증분 반영: 풀 추가 종목은 Subscribe, 제거 종목은 Unsubscribe

## 5. 웹소켓 수집 구조
### 5.1 KIS Approval + 접속
* `apps/orchestrator/src/zones/zone0/kis-websocket.ts`
* REST Approval Key 발급 후 WebSocket 연결
* 연결 실패/종료 시 자동 재연결

### 5.2 멀티 심볼 구독/해제
* `start(symbols)`로 초기 멀티 구독
* `updateSymbols(nextSymbols)`로 증분 구독/해제
* `PINGPONG` 수신 시 에코 응답

### 5.3 파싱 규칙
* 정규식 대신 `split('|')`, `split('^')` 기반 파싱
* 최소 추출 필드:
  * Tick: `symbol`, `price`, `volume`, `volumePower`
  * OrderBook: 10레벨 `asks/bids`, `totalAskDepth`, `totalBidDepth`

## 6. 이벤트 및 프레임 전달
Zone0는 수신된 데이터를 `Zone0Frame`으로 묶어 발행합니다.

* `zone1:tick` -> Zone1 기술지표 입력
* `zone4:context` -> Zone4 감성 컨텍스트 입력
* `zone0:raw` -> 원시 프레임 브로드캐스트/DB 적재

오케스트레이터는 `zone0:raw` 이벤트를 트리거로 `stepRuntime()`을 실행합니다.

## 7. 운영 API
* `GET /api/zone0/buffer`
* `POST /api/zone0/telegram-webhook`
* `GET /api/zone0/telegram-channels`
* `GET /api/zone0/telegram-channels/active`
* `POST /api/zone0/telegram-channels`
* `PUT /api/zone0/telegram-channels/:id`
* `DELETE /api/zone0/telegram-channels/:id`

## 8. 관련 구현 파일
* `apps/orchestrator/src/zones/zone0/ingest.ts`
* `apps/orchestrator/src/zones/zone0/kis-websocket.ts`
* `apps/orchestrator/src/zones/zone0/naver-news-client.ts`
* `apps/orchestrator/src/zones/zone0/dart-disclosure-client.ts`
* `apps/orchestrator/src/zones/zone0/market-flow-client.ts`
* `apps/orchestrator/src/zones/zone0/macro-context-client.ts`
* `apps/orchestrator/src/zones/zone0/telegram-manager.ts`

## 9. 주요 환경변수
### 9.1 KIS 연결
* `KIS_APP_KEY`
* `KIS_APP_SECRET`
* `KIS_WS_URL`
* `KIS_REST_URL`

### 9.2 동적 심볼 풀
* `ZONE0_SYMBOL_DISCOVERY_ENABLED`
* `ZONE0_SYMBOL_POOL_SIZE`
* `ZONE0_SYMBOL_POOL_REFRESH_MS`
* `ZONE0_KIS_HOTLIST_TIMEOUT_MS`
* `ZONE0_KIS_HOTLIST_PATH`
* `ZONE0_KIS_HOTLIST_TR_ID`
* `ZONE0_KIS_HOTLIST_MARKET_DIV`
* `ZONE0_KIS_HOTLIST_SCREEN_DIV`
* `ZONE0_KIS_HOTLIST_INPUT_ISCD`
* `ZONE0_KIS_HOTLIST_DIV_CLS_CODE`
* `ZONE0_KIS_HOTLIST_BLNG_CLS_CODE`
* `ZONE0_KIS_HOTLIST_TRGT_CLS_CODE`
* `ZONE0_KIS_HOTLIST_TRGT_EXLS_CLS_CODE`
* `ZONE0_KIS_HOTLIST_INPUT_PRICE_1`
* `ZONE0_KIS_HOTLIST_INPUT_PRICE_2`
* `ZONE0_KIS_HOTLIST_VOL_CNT`
* `ZONE0_KIS_HOTLIST_INPUT_DATE_1`

### 9.3 외부 수집/버퍼
* `ZONE0_BUFFER_SIZE`
* `ZONE0_FRAME_QUEUE_SIZE`
* `ZONE0_EXTERNAL_POLL_MS`
* `ZONE0_BOARD_POLL_MS`
* `ZONE0_MARKET_FLOW_POLL_MS`
* `ZONE0_MACRO_POLL_MS`
* `ZONE0_SEEN_KEY_LIMIT`
* `ZONE0_NAVER_TIMEOUT_MS`
* `ZONE0_NEWS_KEYWORDS`
* `NAVER_CLIENT_ID`
* `NAVER_CLIENT_SECRET`
* `DART_API_KEY`
* `ZONE0_MARKET_FLOW_PROVIDER`
* `KOSCOM_MARKET_FLOW_URL`
* `KRX_MARKET_FLOW_URL`

## 10. 현재 한계 / 운영 유의사항
* KIS 핫리스트 API는 계정/환경(모의/실전)별로 파라미터와 `TR_ID`가 다를 수 있어 `.env` 튜닝이 필요합니다.
* 외부 API 키 또는 엔드포인트 미설정 시 해당 수집기만 비활성화되고 Zone0 프로세스는 계속 동작합니다.
* Zone1의 `volumePower`는 KIS 체결 원본 필드 제약으로 일부 추정 로직을 포함합니다.

## 11. DB 매핑
* Raw 이벤트 테이블: `TB_ZONE0_EVENT_RAW`
* 인덱스: `IX_Z0_EVENT_SYM_TS` (LOCAL)
* DDL: `db/oracle/init_schema.sql`

## 대용량 테이블들은 처음부터 오라클 파티셔닝을 감안해서 만들어 가능하면 global index는 쓰지 않도록 해줘
## 벡터인덱스는 어쩔수 없는경우에는 그냥 global index를 써도 되
