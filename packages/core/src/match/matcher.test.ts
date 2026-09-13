import { describe, expect, it } from "vitest";
import type { NormalizedListing } from "../normalize/index.js";
import { type MatchResult, type SavedSearchFilters, matches } from "./matcher.js";

function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    sourceId: "fake",
    sourceListingId: "fake-1",
    canonicalUrl: "https://fake.example/listing/1",
    city: "Eindhoven",
    priceBaseCents: 105000,
    priceTotalCents: 118500,
    priceBasis: "exact",
    areaSqm: 58,
    rooms: 3,
    propertyType: "apartment",
    furnished: "upholstered",
    registrationAllowed: true,
    ...overrides,
  };
}

const bare: NormalizedListing = {
  sourceId: "fake",
  sourceListingId: "fake-0",
  canonicalUrl: "https://fake.example/listing/0",
};

const open: SavedSearchFilters = {
  cities: [],
  priceTotalMinCents: null,
  priceTotalMaxCents: null,
  areaSqmMin: null,
  roomsMin: null,
  propertyTypes: [],
  furnished: [],
  registration: "any",
};

function search(overrides: Partial<SavedSearchFilters> = {}): SavedSearchFilters {
  return { ...open, ...overrides };
}

function reason(result: MatchResult, field: keyof SavedSearchFilters) {
  const r = result.reasons.find((x) => x.field === field);
  if (!r) throw new Error(`no reason for ${field}`);
  return r;
}

const strict = search({
  cities: ["Eindhoven"],
  priceTotalMinCents: 80000,
  priceTotalMaxCents: 130000,
  areaSqmMin: 40,
  roomsMin: 2,
  propertyTypes: ["apartment"],
  furnished: ["upholstered", "furnished"],
  registration: "required",
});

describe("matches — overall", () => {
  it("matches a listing that satisfies every filter, with one passing reason per filter", () => {
    const r = matches(listing(), strict);
    expect(r.matched).toBe(true);
    expect(r.reasons.map((x) => x.field).sort()).toEqual(Object.keys(open).sort());
    expect(r.reasons.every((x) => x.passed)).toBe(true);
  });

  it("an open search matches even a listing with no facts at all", () => {
    const r = matches(bare, open);
    expect(r.matched).toBe(true);
    expect(r.reasons).toHaveLength(Object.keys(open).length);
  });

  it("evaluates every rule instead of stopping at the first failure", () => {
    const r = matches(listing({ city: "Veldhoven", priceTotalCents: 150000, rooms: 1 }), strict);
    expect(r.matched).toBe(false);
    expect(r.reasons).toHaveLength(Object.keys(open).length);
    expect(
      r.reasons
        .filter((x) => !x.passed)
        .map((x) => x.field)
        .sort(),
    ).toEqual(["cities", "priceTotalMaxCents", "roomsMin"]);
  });

  it("every reason explains itself", () => {
    for (const r of matches(bare, strict).reasons) {
      expect(r.detail.length, r.field).toBeGreaterThan(0);
    }
  });
});

describe("matches — cities", () => {
  it("compares case-insensitively", () => {
    expect(
      reason(matches(listing({ city: "EINDHOVEN" }), search({ cities: ["eindhoven"] })), "cities")
        .passed,
    ).toBe(true);
  });

  it("fails a city not in the list", () => {
    const r = reason(
      matches(listing({ city: "Veldhoven" }), search({ cities: ["Eindhoven", "Best"] })),
      "cities",
    );
    expect(r.passed).toBe(false);
  });

  it("fails an unknown city when cities are set, and says so", () => {
    const r = reason(matches(bare, search({ cities: ["Eindhoven"] })), "cities");
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/unknown/);
  });

  it("treats an empty list as any city", () => {
    expect(reason(matches(listing({ city: "Veldhoven" }), open), "cities").passed).toBe(true);
  });
});

describe("matches — price", () => {
  it("compares the max against the total, inclusive", () => {
    const max = search({ priceTotalMaxCents: 118500 });
    expect(reason(matches(listing(), max), "priceTotalMaxCents").passed).toBe(true);
    expect(
      reason(matches(listing({ priceTotalCents: 118501 }), max), "priceTotalMaxCents").passed,
    ).toBe(false);
  });

  it("uses the total, not the base, even when the base alone would pass", () => {
    const r = matches(
      listing({ priceBaseCents: 100000, priceTotalCents: 125000 }),
      search({ priceTotalMaxCents: 120000 }),
    );
    expect(reason(r, "priceTotalMaxCents").passed).toBe(false);
  });

  it("compares the min against the total, inclusive", () => {
    const min = search({ priceTotalMinCents: 118500 });
    expect(reason(matches(listing(), min), "priceTotalMinCents").passed).toBe(true);
    expect(
      reason(matches(listing({ priceTotalCents: 90000 }), min), "priceTotalMinCents").passed,
    ).toBe(false);
  });

  it("passes a base_only listing under the max and records that the total is unknown", () => {
    const { priceTotalCents: _, ...baseOnly } = listing({
      priceBaseCents: 87000,
      priceBasis: "base_only",
    });
    const r = reason(
      matches(baseOnly, search({ priceTotalMaxCents: 100000 })),
      "priceTotalMaxCents",
    );
    expect(r.passed).toBe(true);
    expect(r.detail).toContain("base_only, total unknown");
  });

  it("fails a base_only listing over the max", () => {
    const { priceTotalCents: _, ...baseOnly } = listing({
      priceBaseCents: 105000,
      priceBasis: "base_only",
    });
    const r = reason(
      matches(baseOnly, search({ priceTotalMaxCents: 100000 })),
      "priceTotalMaxCents",
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("base_only, total unknown");
  });

  it("passes a base_only listing whose base already meets the min, and fails one below it", () => {
    const { priceTotalCents: _, ...baseOnly } = listing({
      priceBaseCents: 87000,
      priceBasis: "base_only",
    });
    expect(
      reason(matches(baseOnly, search({ priceTotalMinCents: 80000 })), "priceTotalMinCents").passed,
    ).toBe(true);
    const below = reason(
      matches(baseOnly, search({ priceTotalMinCents: 90000 })),
      "priceTotalMinCents",
    );
    expect(below.passed).toBe(false);
    expect(below.detail).toContain("base_only, total unknown");
  });

  it("fails set price bounds when the listing has no price at all", () => {
    const r = matches(bare, search({ priceTotalMinCents: 50000, priceTotalMaxCents: 130000 }));
    expect(reason(r, "priceTotalMinCents").passed).toBe(false);
    expect(reason(r, "priceTotalMaxCents").passed).toBe(false);
    expect(reason(r, "priceTotalMaxCents").detail).toMatch(/unknown/);
  });

  it("passes unset price bounds regardless of price", () => {
    const r = matches(bare, open);
    expect(reason(r, "priceTotalMinCents").passed).toBe(true);
    expect(reason(r, "priceTotalMaxCents").passed).toBe(true);
  });
});

describe("matches — area and rooms", () => {
  it("passes at the minimum and fails below it", () => {
    expect(
      reason(matches(listing({ areaSqm: 40 }), search({ areaSqmMin: 40 })), "areaSqmMin").passed,
    ).toBe(true);
    expect(
      reason(matches(listing({ areaSqm: 39 }), search({ areaSqmMin: 40 })), "areaSqmMin").passed,
    ).toBe(false);
    expect(reason(matches(listing({ rooms: 2 }), search({ roomsMin: 2 })), "roomsMin").passed).toBe(
      true,
    );
    expect(reason(matches(listing({ rooms: 1 }), search({ roomsMin: 2 })), "roomsMin").passed).toBe(
      false,
    );
  });

  it("fails a set minimum when the listing's value is missing, and says so", () => {
    const r = matches(bare, search({ areaSqmMin: 40, roomsMin: 2 }));
    expect(reason(r, "areaSqmMin")).toMatchObject({
      passed: false,
      detail: expect.stringMatching(/unknown/),
    });
    expect(reason(r, "roomsMin")).toMatchObject({
      passed: false,
      detail: expect.stringMatching(/unknown/),
    });
  });
});

describe("matches — property type and furnishing", () => {
  it("property types are any-of; empty means any; unknown fails a set list", () => {
    const flats = search({ propertyTypes: ["apartment", "studio"] });
    expect(
      reason(matches(listing({ propertyType: "studio" }), flats), "propertyTypes").passed,
    ).toBe(true);
    expect(reason(matches(listing({ propertyType: "room" }), flats), "propertyTypes").passed).toBe(
      false,
    );
    expect(reason(matches(bare, flats), "propertyTypes").passed).toBe(false);
    expect(reason(matches(listing({ propertyType: "room" }), open), "propertyTypes").passed).toBe(
      true,
    );
  });

  it("furnishing is any-of; empty means any, including unstated", () => {
    const f = search({ furnished: ["furnished"] });
    expect(reason(matches(listing({ furnished: "furnished" }), f), "furnished").passed).toBe(true);
    expect(reason(matches(listing({ furnished: "bare" }), f), "furnished").passed).toBe(false);
    expect(reason(matches(bare, open), "furnished").passed).toBe(true);
  });

  it("an unstated furnishing passes only when the search includes not_stated", () => {
    expect(reason(matches(bare, search({ furnished: ["bare"] })), "furnished").passed).toBe(false);
    expect(
      reason(matches(bare, search({ furnished: ["bare", "not_stated"] })), "furnished").passed,
    ).toBe(true);
  });
});

describe("matches — registration", () => {
  const unknown = bare;
  const allowed = listing({ registrationAllowed: true });
  const refused = listing({ registrationAllowed: false });

  it("required drops undefined", () => {
    const r = reason(matches(unknown, search({ registration: "required" })), "registration");
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/unknown/);
  });

  it("required keeps true and drops false", () => {
    const s = search({ registration: "required" });
    expect(reason(matches(allowed, s), "registration").passed).toBe(true);
    expect(reason(matches(refused, s), "registration").passed).toBe(false);
  });

  it("preferred keeps undefined", () => {
    expect(
      reason(matches(unknown, search({ registration: "preferred" })), "registration").passed,
    ).toBe(true);
  });

  it("preferred keeps true and drops false", () => {
    const s = search({ registration: "preferred" });
    expect(reason(matches(allowed, s), "registration").passed).toBe(true);
    expect(reason(matches(refused, s), "registration").passed).toBe(false);
  });

  it("any passes true, false and unknown", () => {
    const s = search({ registration: "any" });
    for (const l of [allowed, refused, unknown]) {
      expect(reason(matches(l, s), "registration").passed).toBe(true);
    }
  });
});
