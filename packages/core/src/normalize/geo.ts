import table from "./pc4-centroids.json" with { type: "json" };

export type GeoPrecision = "exact" | "postcode";

export interface LatLng {
  lat: number;
  lng: number;
}

// TODO: bundle the full NL PC4 table (see docs/backlog.md). This one only
// covers Eindhoven, Veldhoven and Best, which includes every fake fixture.
const centroids = new Map<string, LatLng>(Object.entries(table.centroids));

/** Centroid of a 4-digit postcode area, or undefined if it isn't in the table. */
export function postcodeCentroid(pc4: string): LatLng | undefined {
  return centroids.get(pc4);
}
