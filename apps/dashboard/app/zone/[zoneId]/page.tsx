import { notFound, redirect } from "next/navigation";

import { ZoneDetailClientPage } from "@/components/zone-detail-page-client";
import { ZONE_IDS, isZoneId } from "@/lib/zone-meta";

export function generateStaticParams() {
  return ZONE_IDS.map((zoneId) => ({ zoneId }));
}

export default async function ZoneDetailPage({ params }: { params: Promise<{ zoneId: string }> }) {
  const { zoneId } = await params;

  if (!isZoneId(zoneId)) {
    notFound();
  }

  if (zoneId === "0") {
    redirect("/settings/zone0?tab=telegram");
  }

  return <ZoneDetailClientPage zoneId={zoneId} />;
}
