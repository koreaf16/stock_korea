# Zone 0: Raw Data Pipeline (원시 데이터 스트리밍)

## 1. 개요 (Overview)
외부 거래소 및 커뮤니티로부터 쏟아지는 가공되지 않은 날것의 데이터를 시스템 내부로 유입시키는 최전방 게이트웨이. 지연 시간(Latency) 최소화와 무손실 수신이 최우선 목표이다.

## 2. 기술 스택 (Tech Stack)
* **Runtime**: Node.js (TypeScript) & Python 3.x
* **Protocol**: WebSocket (KIS API), HTTP/REST, Telegram Webhook

## 3. 데이터 소스 및 타겟 (Data Sources)
1. **실시간 틱/체결 (`H0STCNT0`)**: 한국투자증권(KIS) WebSocket -> Node.js 수신
2. **실시간 10호가 잔량 (`H0STASP0`)**: 한국투자증권(KIS) WebSocket -> Node.js 수신
3. **특징주 뉴스 원문**: 네이버 증권 속보 크롤링 (Node.js/cheerio)
4. **종토방 게시글 원시 JSON**: 네이버 종목토론실 비공식 API 폴링 (Node.js)
5. **텔레그램 찌라시 원문**: Python Telethon을 통한 정보방 웹훅 수신

## 4. 입출력 (I/O)
* **Input**: 외부 서버의 텍스트/스트림 데이터
* **Output**: 인메모리 버퍼(Array/Redis) 적재 및 Zone 1, Zone 4 모듈로의 비동기 이벤트 발송 (Event Emitter)

## 5. 현재 구현 상태 (v0 Skeleton)
아래 항목은 현재 코드에 반영된 Zone 0 구현 범위입니다.

### 5.1 구현 파일
* `apps/orchestrator/src/zones/zone0/ingest.ts`
* `apps/orchestrator/src/state/store.ts`
* `apps/orchestrator/src/pipeline.ts`
* `apps/orchestrator/src/index.ts`

### 5.2 수집 프레임 (Zone0Frame)
한 사이클마다 아래 raw frame을 생성합니다.
* Tick (`H0STCNT0` 모사): 종목/체결가/체결량/총 매수·매도 잔량
* OrderBook (`H0STASP0` 모사): 10호가(asks/bids), 총 잔량
* Naver News 원문 모사 배열
* Naver Board 원문 모사 배열
* Telegram 메시지 원문 모사 배열
* Sentiment Pulse: `score`, `velocity`, `signalCount`

### 5.3 이벤트 발행
EventEmitter 기반으로 아래 이벤트를 발행합니다.
* `zone1:tick`: Zone 1 기술지표 입력용 (tick + orderBook)
* `zone4:context`: Zone 4 감성 입력용 (news/board/telegram + sentimentPulse)
* `zone0:raw`: 전체 raw frame

### 5.4 버퍼링
인메모리 버퍼를 유지합니다.
* `ticks`
* `orderBooks`
* `newsItems`
* `boardPosts`
* `telegramMessages`
* `lastFrameAt`

버퍼 크기 기본값은 `ZONE0_BUFFER_SIZE=600`입니다.

### 5.5 운영 API
* `GET /api/zone0/buffer`: Zone 0 버퍼 전체 조회
* `GET /health`: `zone0` 버퍼 카운트 요약 포함

### 5.6 현재 한계
현재는 외부 연결 mock 단계입니다.
* KIS WebSocket 실연결(`H0STCNT0`, `H0STASP0`) 미연결
* Naver 뉴스/종토방 실크롤링 미연결
* Telethon 웹훅 수신 미연결

### 5.7 DB 매핑 (생성 완료)
* Raw 이벤트 적재 대상 테이블: `TB_ZONE0_EVENT_RAW`
* 파티셔닝: 일 단위 RANGE + INTERVAL
* 인덱스: `IX_Z0_EVENT_SYM_TS` (LOCAL)
* DDL: `db/oracle/init_schema.sql`
        
## 대용량 테이블들은 처음부터 오라클 파티셔닝을 감안해서 만들어 가능하면 global index는 쓰지 않도록 해줘 
## 벡터인덱스는 어쩔수 없는경우에는 그냥 global index를 써도 되
