export function toSymbolCode(raw: string | null | undefined): string {
  const text = String(raw ?? "").trim();
  const digits = text.replace(/[^\d]/g, "");
  if (digits.length >= 6) {
    return digits.slice(0, 6);
  }
  return text || "UNKNOWN";
}

export function formatSymbolLabel(
  symbol: string | null | undefined,
  symbolNames: Record<string, string>,
  fallbackName?: string | null
): string {
  const code = toSymbolCode(symbol);
  const mapName = symbolNames[code];
  const rawFallback = String(fallbackName ?? "").trim();
  const name = mapName && mapName !== code ? mapName : rawFallback && rawFallback !== code ? rawFallback : "";

  if (!name) {
    return code;
  }

  return `${code} ${name}`;
}

export function decorateSymbolCodes(text: string, symbolNames: Record<string, string>): string {
  const source = String(text ?? "");
  if (!source) {
    return source;
  }

  return source.replace(/\b\d{6}\b/g, (matched) => formatSymbolLabel(matched, symbolNames));
}
