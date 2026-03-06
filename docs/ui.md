# Tactical Dashboard (UI 설계도)

## 1. 개요 (Overview)
Node.js(Orchestrator)가 웹소켓으로 쏘아주는 실시간 틱 데이터와, Python(로컬 LLM)의 추론 과정을 시각화하는 중앙 통제실입니다. 
인간(GK)이 직접 매매를 하지 않더라도, AI가 '왜 이런 결정을 내렸는지' 실시간으로 감시하고 필요시 개입(Kill-Switch)할 수 있도록 설계되었습니다.

## 2. 기술 스택 (Tech Stack)
* **Framework**: Next.js 14 (App Router) + React
* **Language**: TypeScript
* **Styling**: Tailwind CSS (Dark Mode / High Contrast)
* **Charting**: Lightweight Charts (TradingView) 또는 Recharts
* **State/Comms**: Zustand + Socket.io-client (Node.js와 실시간 통신)

## 3. 화면 레이아웃 (Grid Layout)
화면은 100vh 꽉 찬 전체 화면 모드로 구성되며, 4개의 주요 패널로 나뉩니다.

### 🌐 [Top Bar] Global Status & Portfolio
화면 최상단에 고정되는 시스템 인프라 및 자산 요약 헤더입니다.
* **Network Status**: KIS API(초록), Oracle 26ai(초록), 로컬 LLM 192.168.0.3(초록) 연결 상태 표시.
* **My Account**: 총 자산, 가용 예수금, 당일 실현 손익(%).
* **Master Kill-Switch**: 누르는 즉시 모든 신규 매수를 중단하고 보유 종목을 시장가로 청산하는 긴급 정지 버튼 (빨간색).

### 📡 [Left Panel] Radar & Zone 1 (시장 감시)
* **Real-time Ticker (Zone 0)**: 한국투자증권에서 스트리밍되는 실시간 호가/체결 데이터가 터미널 로그처럼 빠르게 올라갑니다.
* **Volume Spike Alert (Zone 1)**: 거래대금이 직전 1분 대비 300% 이상 폭증하는 종목이 감지되면 빨간색 플래시 박스로 팝업됩니다.
* **Fundamental Filter (Zone 2)**: 현재 타겟팅된 종목의 DART 악재(CB/유상증자) 유무를 O/X 아이콘으로 표시합니다.

### 📈 [Center Top] Tactical Chart (Zone 1 & Zone 3)
화면에서 가장 넓은 영역을 차지하는 실시간 차트 구역입니다.
* **1분봉/3분봉 차트**: 실시간 캔들스틱 차트.
* **Auto Support/Resistance (Zone 1)**: Node.js가 계산한 당일의 지지선과 저항선이 점선으로 자동 작도됩니다.
* **Pattern Match Overlay (Zone 3)**: Oracle 26ai가 현재 차트와 "94% 일치한다"고 판단한 과거의 'CLASS_A(급등) 패턴' 궤적을 현재 차트 위에 옅은 그림자(Ghost line) 형태로 겹쳐서 보여줍니다. (가장 강력한 시각화 포인트)

### 🧠 [Center Bottom] AI Brain Terminal (Zone 4, 5, 6)
로컬 LLM(`gpt-oss-20b`)이 생각하는 과정을 실시간 텍스트와 게이지로 보여줍니다.
* **Madness Gauge (Zone 4)**: 종토방 리젠율과 뉴스 감성 스코어를 0~100의 아날로그 계기판(Gauge)으로 표시. 구간별 색상 변화 (파랑: STAGE 1 발화 -> 빨강: STAGE 3 광기).
* **LLM Chain of Thought (Zone 5)**: AI가 JSON을 만들기 전 추론하는 과정을 터미널 텍스트처럼 출력.
  > `[sys] Zone 3 패턴 92% 일치 감지.`
  > `[sys] 특징주 뉴스 감성 분석 중... Score: +0.85 (탐욕)`
  > `[sys] Zone 6 과거 유사 이력 조회: 3전 2승 1패 (승률 66%)`
  > `[Z5_Decision] 손익비 1:2 충족. 가용 예수금의 15% 비중으로 BUY 승인.`
* **History Vector Feedback (Zone 6)**: 현재 상황과 유사한 과거 나의 매매 기록 요약을 미니 카드로 노출.

### 💼 [Right Panel] Execution & Order Book (주문 및 잔고)
실제 KIS API로 전송된 주문과 현재 내 계좌의 상태를 보여줍니다.
* **Active Positions**: 현재 보유 중인 종목명, 진입가, 현재가, 실시간 수익률(%). 수익률에 따라 초록/빨강 텍스트 강조.
* **Order Log**: 매수/매도 주문이 API를 통해 KIS 서버로 전송되고 체결된 내역 (Timestamp 포함).
* **Manual Override**: AI의 판단을 무시하고 사용자가 직접 시장가 매수/매도/절반 청산을 할 수 있는 수동 핫키 버튼.

## 4. UI/UX 디자인 테마 (Color Palette)
장시간 모니터링해도 눈이 피로하지 않도록 다크 톤을 유지하되, 중요 시그널만 강렬한 색상으로 대비를 줍니다.
* **Background**: `#0F172A` (Slate 900) - 깊은 남색 계열의 다크 모드.
* **Panel Borders**: `#1E293B` (Slate 800) - 패널 간의 얇은 구분선.
* **Terminal Text (Z0/Z5)**: `#22C55E` (Green 500) - 전통적인 해커 터미널의 녹색.
* **Buy/Profit**: `#ef4444` (Red 500) - 한국 주식 시장 기준 상승/매수는 빨간색.
* **Sell/Loss**: `#3b82f6` (Blue 500) - 한국 주식 시장 기준 하락/매도는 파란색.
* **Madness Alert**: `#eab308` (Yellow 500) - 광기 지수 경고 및 특징주 뉴스 팝업.

## 5. 운영 API 연계 (현재 구현)
* Snapshot: `GET /api/snapshot`
* Zone state:
  * `GET /api/zone0/buffer`
  * `GET /api/zone1/state`
  * `GET /api/zone2/state`
  * `GET /api/zone3/state`
  * `GET /api/zone4/state`
  * `GET /api/zone5/state`
  * `GET /api/zone6/state`
* Control:
  * `POST /api/kill-switch`
  * `POST /api/manual-order`
* Health:
  * `GET /health` (zone0~6 요약)

## 6. 포트/실행 기준
* Dashboard: `http://localhost:5000`
* Orchestrator: `http://localhost:5001`

## 7. 현재 구현 고도화 상태 (v3)
아래 항목은 현재 대시보드 코드에 반영된 고도화 범위입니다.

### 7.1 Top Bar
* 네트워크 카드형 상태 (KIS/Oracle/LLM endpoint 포함)
* Socket 연결 상태 + Health Poll 경고 + Command 에러 배지
* Zone2~6 source 요약 칩
* 계좌 요약(총자산/예수금/실현손익) + Kill-Switch 강화 버튼

### 7.2 Left Panel (Radar)
* Zone0 버퍼 요약 카드 (News/Telegram 카운트)
* 실시간 ticker 터미널 + 마지막 frame 시각
* Zone1 spike ratio 게이지/경보
* Zone2 provider/source + 리스크 이슈 표시

### 7.3 Center Panel (Chart + Brain)
* 가격 시계열을 캔들형 SVG 차트로 렌더링
* 지지선/저항선 점선 오버레이
* Zone3 class 기반 Ghost Pattern 오버레이
* Zone4 원형 Madness Gauge(conic-gradient)
* Zone5 chain log + Zone6 피드백 카드 확장

### 7.4 Right Panel (Execution)
* Zone5 결정 요약 카드(액션/신뢰도/비중/TP/SL)
* Order book 압력(BID/ASK depth bar)
* Active positions + Order log
* Manual override 수량 preset + 시장가 매수/매도/절반청산

### 7.5 연동 방식
* Socket: snapshot 실시간 push
* Polling: `/health` 3초 주기 갱신
* API Command: kill-switch/manual-order 실패 시 에러 표시

### 7.6 추가 고도화 (v3)
* Top Bar를 sticky header로 고정해 스크롤 중에도 글로벌 상태/킬스위치 상시 표시
* Zone1 스파이크 300% 초과 시 Left Panel에 플래시 경보 박스 표시
* Center 차트에 1분/3분 토글, 현재가 점선, 가격 스케일 라벨(상/중/하) 추가

## 8. 성능 튜닝
버벅임이 있을 때는 아래 값을 조정합니다.
* `NEXT_PUBLIC_DASHBOARD_UI_PERF=low|high`
  * `low`: blur/hover/flash 애니메이션 최소화(기본)
  * `high`: 시각효과 활성화
* `NEXT_PUBLIC_DASHBOARD_MAX_FPS`
  * Socket snapshot 반영 최대 FPS (기본 `5`)
  * 소켓 수신량이 높을 때 UI 프레임 드랍 완화

## 9. Zone 관리 메뉴
대시보드 상단에 `존별 관리 메뉴` 패널이 추가되었습니다.
* Zone0~Zone6 탭 선택
* 각 Zone의 `/health` 요약 지표 즉시 확인
* Zone별 상세 API 호출(`상태 새로고침`)
* 해당 Zone API 엔드포인트 바로 열기

### 9.1 Zone별 상세 조회 API
* Zone0: `GET /api/zone0/buffer` (버퍼 카운트/최근 샘플 중심으로 표시)
* Zone1: `GET /api/zone1/state`
* Zone2: `GET /api/zone2/state`
* Zone3: `GET /api/zone3/state`
* Zone4: `GET /api/zone4/state`
* Zone5: `GET /api/zone5/state`
* Zone6: `GET /api/zone6/state`
