from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Zone2Fundamental(BaseModel):
    symbol: str
    risk_flag: Literal["CLEAR", "BLOCKED"]
    risk_score: float = 1.0
    rule_risk_score: float = 1.0
    vector_risk_score: float = 1.0
    similar_pump_score: float = 0.0
    similar_delist_score: float = 1.0
    disclosure_toxicity_score: float = 1.0
    vector_latency_ms: float = 0.0
    safe_mode: bool = True
    issues: list[str] = Field(default_factory=list)
    has_cb_bw_issue: bool = False
    has_krx_warning: bool = False
    has_capital_impairment: bool = False
    source: Literal["PYTHON_WORKER"] = "PYTHON_WORKER"
    checked_at: str = Field(default_factory=now_iso)


class Zone3PatternMatch(BaseModel):
    klass: Literal["CLASS_A", "CLASS_B", "CLASS_C"]
    similarity: float
    matched_pattern_id: str
    updated_at: str = Field(default_factory=now_iso)


class Zone4Madness(BaseModel):
    score: float
    stage: Literal["STAGE_1", "STAGE_2", "STAGE_3"]
    sentiment: float
    news_velocity: float
    updated_at: str = Field(default_factory=now_iso)


class Zone6HistoryFeedback(BaseModel):
    similar_trade_id: str
    win_rate: float
    summary: str
    updated_at: str = Field(default_factory=now_iso)
