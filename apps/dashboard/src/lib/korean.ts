import type {
  ConnectionState,
  DecisionAction,
  FundamentalRiskFlag,
  MadnessStage,
  NetworkServiceName,
  OrderSide,
  OrderSource,
  OrderStatus,
  PatternClass
} from "@stock/contracts";

export function serviceLabelKo(name: NetworkServiceName | string): string {
  if (name === "KIS_API") return "한국투자증권";
  if (name === "ORACLE_26AI") return "오라클 26에이아이";
  if (name === "LOCAL_LLM") return "로컬 언어모델";
  return name;
}

export function connectionStateKo(state: ConnectionState | string): string {
  if (state === "UP") return "정상";
  if (state === "DOWN") return "장애";
  return state;
}

export function orderSideKo(side: OrderSide | string): string {
  if (side === "BUY") return "매수";
  if (side === "SELL") return "매도";
  return side;
}

export function orderStatusKo(status: OrderStatus | string): string {
  if (status === "SENT") return "전송됨";
  if (status === "FILLED") return "체결";
  if (status === "REJECTED") return "거절";
  return status;
}

export function orderSourceKo(source: OrderSource | string): string {
  if (source === "AI") return "인공지능";
  if (source === "MANUAL") return "수동";
  if (source === "KILL_SWITCH") return "킬스위치";
  return source;
}

export function decisionActionKo(action: DecisionAction | string): string {
  if (action === "BUY") return "매수";
  if (action === "SELL") return "매도";
  if (action === "PASS") return "관망";
  return action;
}

export function riskFlagKo(flag: FundamentalRiskFlag | string): string {
  if (flag === "BLOCKED") return "차단";
  if (flag === "CLEAR") return "통과";
  return flag;
}

export function fundamentalIssueKo(issue: string): string {
  const key = issue.trim().toLowerCase();
  if (key === "has_cb_bw_issue") return "전환사채/신주인수권부사채 리스크";
  if (key === "has_rights_offering") return "유상증자 리스크";
  if (key === "has_krx_warning") return "거래소 경고/위험";
  if (key === "has_capital_impairment") return "자본잠식 리스크";
  if (key === "forced_blocked_symbol") return "강제 차단 종목";
  return issue;
}

export function patternClassKo(klass: PatternClass | string): string {
  if (klass === "CLASS_A") return "급등형";
  if (klass === "CLASS_B") return "중립형";
  if (klass === "CLASS_C") return "급락형";
  return klass;
}

export function madnessStageKo(stage: MadnessStage | string): string {
  if (stage === "STAGE_1") return "1단계(발화)";
  if (stage === "STAGE_2") return "2단계(폭발)";
  if (stage === "STAGE_3") return "3단계(광기)";
  return stage;
}

export function sourceKo(value: string | null | undefined): string {
  if (!value) return "-";
  const upper = value.toUpperCase();
  if (upper === "PYTHON") return "파이썬";
  if (upper === "MOCK") return "모의";
  if (upper === "AUTO") return "자동";
  if (upper === "LOCAL") return "로컬";
  if (upper === "LOCAL_VECTOR") return "로컬 벡터";
  if (upper === "LLM") return "언어모델";
  if (upper === "RULE") return "규칙";
  if (upper === "FALLBACK") return "대체";

  const lower = value.toLowerCase();
  if (lower.includes("python")) return "파이썬";
  if (lower.includes("mock")) return "모의";
  if (lower.includes("local") && lower.includes("vector")) return "로컬 벡터";
  if (lower.includes("local")) return "로컬";
  if (lower.includes("llm")) return "언어모델";
  if (lower.includes("rule")) return "규칙";
  if (lower.includes("fallback")) return "대체";
  if (lower.includes("auto")) return "자동";
  return value;
}

export function narrativeKo(text: string): string {
  return text
    .replace(/Master Kill-Switch/gi, "마스터 킬스위치")
    .replace(/\bZone\s?([0-9])\b/gi, "존$1")
    .replace(/\bCLASS_A\b/g, "급등형")
    .replace(/\bCLASS_B\b/g, "중립형")
    .replace(/\bCLASS_C\b/g, "급락형")
    .replace(/\bSTAGE_1\b/g, "1단계(발화)")
    .replace(/\bSTAGE_2\b/g, "2단계(폭발)")
    .replace(/\bSTAGE_3\b/g, "3단계(광기)")
    .replace(/\bBUY\b/g, "매수")
    .replace(/\bSELL\b/g, "매도")
    .replace(/\bPASS\b/g, "관망");
}
