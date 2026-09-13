import type { LatLng } from "../geo/distance.js";
import table from "./pc4-centroids.json" with { type: "json" };

export type { LatLng } from "../geo/distance.js";

export type GeoPrecision = "exact" | "postcode";

// TODO: bundle the full NL PC4 table (see docs/backlog.md). This one only
// covers Eindhoven, Veldhoven and Best, which includes every fake fixture.
const centroids = new Map<string, LatLng>(Object.entries(table.centroids));

/** Centroid of a 4-digit postcode area, or undefined if it isn't in the table. */
export function postcodeCentroid(pc4: string): LatLng | undefined {
  return centroids.get(pc4);
}
