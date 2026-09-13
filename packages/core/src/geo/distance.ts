export interface LatLng {
  lat: number;
  lng: number;
}

/** Mean Earth radius (IUGG), in km. */
export const EARTH_RADIUS_KM = 6371.0088;

const rad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Straight-line (great-circle) distance in km, by the haversine formula.
 * Display only: no routing, no travel time.
 */
export function distanceKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
