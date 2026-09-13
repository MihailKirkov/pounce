import { describe, expect, it } from "vitest";
import { normalizeHouseNumber, normalizePostcode, splitAddress } from "./postcode.js";

describe("normalizePostcode", () => {
  it('normalizes "5612 cj" to "5612CJ"', () => {
    expect(normalizePostcode("5612 cj")).toBe("5612CJ");
  });

  it("accepts already-normal and loosely spaced input", () => {
    expect(normalizePostcode("5615PT")).toBe("5615PT");
    expect(normalizePostcode("  5502   jv ")).toBe("5502JV");
  });

  it("returns undefined for anything that isn't 4 digits + 2 letters", () => {
    for (const bad of ["", "5612", "5612C", "5612 CJX", "561 CJ", "0612CJ", "CJ 5612", "5612-CJ"]) {
      expect(normalizePostcode(bad), bad).toBeUndefined();
    }
  });
});

describe("normalizeHouseNumber", () => {
  it("uppercases so two sources spelling one address differently agree", () => {
    expect(normalizeHouseNumber("208a")).toBe("208A");
    expect(normalizeHouseNumber("208A")).toBe("208A");
    expect(normalizeHouseNumber("12-hs")).toBe("12-HS");
  });

  it("collapses whitespace and returns undefined when blank", () => {
    expect(normalizeHouseNumber("  12   bis ")).toBe("12 BIS");
    expect(normalizeHouseNumber("   ")).toBeUndefined();
  });
});

describe("splitAddress", () => {
  it('splits "Hoogstraat 208A" into street and number', () => {
    expect(splitAddress("Hoogstraat 208A")).toEqual({ street: "Hoogstraat", houseNumber: "208A" });
  });

  it("takes the trailing number group when the street contains digits", () => {
    expect(splitAddress("Straat 2e Hoek 14")).toEqual({
      street: "Straat 2e Hoek",
      houseNumber: "14",
    });
    expect(splitAddress("1e Hoogstraat 3")).toEqual({ street: "1e Hoogstraat", houseNumber: "3" });
  });

  it("keeps house number suffixes, uppercased", () => {
    expect(splitAddress("Kruisstraat 12a")).toEqual({ street: "Kruisstraat", houseNumber: "12A" });
    expect(splitAddress("Kruisstraat 12-2")).toEqual({
      street: "Kruisstraat",
      houseNumber: "12-2",
    });
    expect(splitAddress("Kruisstraat 12 bis")).toEqual({
      street: "Kruisstraat",
      houseNumber: "12 BIS",
    });
  });

  it("ignores the postcode and city after a comma", () => {
    expect(splitAddress("Kruisstraat 112, 5612 CJ Eindhoven")).toEqual({
      street: "Kruisstraat",
      houseNumber: "112",
    });
  });

  it("collapses whitespace", () => {
    expect(splitAddress("  Van  Somerenstraat   7 ")).toEqual({
      street: "Van Somerenstraat",
      houseNumber: "7",
    });
  });

  it("returns an empty result when there is no street + number", () => {
    expect(splitAddress("")).toEqual({});
    expect(splitAddress("Eindhoven")).toEqual({});
    expect(splitAddress("208A")).toEqual({});
  });
});
