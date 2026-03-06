export const ZONE_IDS = ["0", "1", "2", "3", "4", "5", "6"] as const;

export type ZoneId = (typeof ZONE_IDS)[number];

export function isZoneId(value: string): value is ZoneId {
  return ZONE_IDS.includes(value as ZoneId);
}
