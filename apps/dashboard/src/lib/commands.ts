import type { ManualOrderCommand } from "@stock/contracts";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";

export async function toggleKillSwitch(enabled: boolean): Promise<void> {
  const res = await fetch(`${ORCHESTRATOR_URL}/api/kill-switch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ enabled })
  });
  if (!res.ok) {
    throw new Error(`킬스위치 요청 실패 (${res.status})`);
  }
}

export async function sendManualOrder(command: ManualOrderCommand): Promise<void> {
  const res = await fetch(`${ORCHESTRATOR_URL}/api/manual-order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  if (!res.ok) {
    throw new Error(`수동 주문 요청 실패 (${res.status})`);
  }
}
