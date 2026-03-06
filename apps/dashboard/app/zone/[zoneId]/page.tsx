import { notFound } from "next/navigation";

import { ZoneDetailClientPage, ZONE_IDS, isZoneId } from "@/components/zone-detail-page-client";

export function generateStaticParams() {
  return ZONE_IDS.map((zoneId) => ({ zoneId }));
}

export default async function ZoneDetailPage({ params }: { params: Promise<{ zoneId: string }> }) {
  const { zoneId } = await params;

  if (!isZoneId(zoneId)) {
    notFound();
  }

  return <ZoneDetailClientPage zoneId={zoneId} />;
}
