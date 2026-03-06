export function formatKrw(value: number): string {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 0
  }).format(value);
}

export function formatPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function formatTs(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", {
    hour12: false
  });
}

