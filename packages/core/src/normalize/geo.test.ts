import { describe, expect, it } from "vitest";
import { postcodeCentroid } from "./geo.js";

describe("postcodeCentroid", () => {
  it("returns coordinates for the PC4 codes used in the fake fixtures", () => {
    for (const pc4 of ["5612", "5615", "5502"]) {
      const c = postcodeCentroid(pc4);
      expect(c, pc4).toBeDefined();
      // Eindhoven region bounding box, loosely.
      expect(c?.lat).toBeGreaterThan(51.3);
      expect(c?.lat).toBeLessThan(51.6);
      expect(c?.lng).toBeGreaterThan(5.3);
      expect(c?.lng).toBeLessThan(5.6);
    }
  });

  it("covers Best", () => {
    expect(postcodeCentroid("5683")).toBeDefined();
  });

  it("returns undefined for unknown or malformed PC4 codes", () => {
    expect(postcodeCentroid("1012")).toBeUndefined();
    expect(postcodeCentroid("5612CJ")).toBeUndefined();
    expect(postcodeCentroid("")).toBeUndefined();
    expect(postcodeCentroid("centroids")).toBeUndefined();
    expect(postcodeCentroid("toString")).toBeUndefined();
  });
});
