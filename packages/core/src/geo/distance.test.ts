import { describe, expect, it } from "vitest";
import { EARTH_RADIUS_KM, distanceKm } from "./distance.js";

describe("distanceKm", () => {
  it("is 0 for the same point", () => {
    expect(distanceKm({ lat: 51.4433, lng: 5.4797 }, { lat: 51.4433, lng: 5.4797 })).toBe(0);
  });

  it("gives one degree of latitude along a meridian as πR/180", () => {
    const d = distanceKm({ lat: 51, lng: 5 }, { lat: 52, lng: 5 });
    expect(d).toBeCloseTo((Math.PI * EARTH_RADIUS_KM) / 180, 9);
    expect(d).toBeCloseTo(111.195, 3);
  });

  it("gives a quarter of the equator as πR/2", () => {
    expect(distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 90 })).toBeCloseTo(
      (Math.PI * EARTH_RADIUS_KM) / 2,
      6,
    );
  });

  it("measures Eindhoven Centraal to Amsterdam Centraal at about 111.4 km, either way round", () => {
    const eindhoven = { lat: 51.4433, lng: 5.4797 };
    const amsterdam = { lat: 52.3789, lng: 4.9003 };
    expect(distanceKm(eindhoven, amsterdam)).toBeCloseTo(111.37, 2);
    expect(distanceKm(amsterdam, eindhoven)).toBe(distanceKm(eindhoven, amsterdam));
  });
});
