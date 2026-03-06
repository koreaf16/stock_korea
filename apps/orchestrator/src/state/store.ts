import { createEmptyDashboardSnapshot, type DashboardSnapshot } from "@stock/contracts";

import { createZone0Gateway, type Zone0Gateway } from "../zones/zone0/ingest.js";
import { createZone1Engine, type Zone1Engine } from "../zones/zone1/technical.js";
import { createZone2Engine, type Zone2Engine } from "../zones/zone2/fundamental.js";
import { createZone3Engine, type Zone3Engine } from "../zones/zone3/pattern.js";
import { createZone4Engine, type Zone4Engine } from "../zones/zone4/madness.js";
import { createZone5Engine, type Zone5Engine } from "../zones/zone5/decision.js";
import { createZone6Engine, type Zone6Engine } from "../zones/zone6/history.js";

export interface RuntimeState {
  tickCount: number;
  snapshot: DashboardSnapshot;
  zone0: Zone0Gateway;
  zone1: Zone1Engine;
  zone2: Zone2Engine;
  zone3: Zone3Engine;
  zone4: Zone4Engine;
  zone5: Zone5Engine;
  zone6: Zone6Engine;
}

export function createRuntimeState(): RuntimeState {
  return {
    tickCount: 0,
    snapshot: createEmptyDashboardSnapshot(),
    zone0: createZone0Gateway(),
    zone1: createZone1Engine(),
    zone2: createZone2Engine(),
    zone3: createZone3Engine(),
    zone4: createZone4Engine(),
    zone5: createZone5Engine(),
    zone6: createZone6Engine()
  };
}
