import { describe, expect, it } from "vitest";
import type { SavedSearchFilters } from "../match/matcher.js";
import type { NormalizedListing } from "../normalize/index.js";
import { formatTelegram } from "./format.js";

const now = new Date("2026-09-13T10:00:40Z");

const search: SavedSearchFilters = {
  cities: ["Eindhoven"],
  priceTotalMinCents: null,
  priceTotalMaxCents: 130000,
  areaSqmMin: 40,
  roomsMin: 2,
  propertyTypes: [],
  furnished: [],
  registration: "any",
};

const complete: NormalizedListing = {
  sourceId: "pararius",
  sourceListingId: "abc123",
  canonicalUrl: "https://fake.example/listing/abc123",
  publishedAt: new Date("2026-09-13T10:00:00Z"),
  title: "Apartment Kruisstraat",
  street: "Kruisstraat",
  houseNumber: "112",
  postcode: "5612CJ",
  city: "Eindhoven",
  priceBaseCents: 105000,
  priceTotalCents: 118500,
  // With base and total both known the breakdown wins; inclusions don't change the line.
  priceIncludes: ["service_costs"],
  priceBasis: "exact",
  areaSqm: 58,
  rooms: 3,
  furnished: "upholstered",
  availableFrom: new Date("2026-10-01"),
  minContractMonths: 12,
  registrationAllowed: true,
  incomeRequirementMultiple: 3.5,
};

describe("formatTelegram", () => {
  it("formats a complete listing", () => {
    const text = formatTelegram(complete, search, {
      now,
      distanceKm: 3.44,
      sourceName: "Pararius",
    });
    expect(text).toBe(
      [
        "Kruisstraat 112, Eindhoven",
        "5612 CJ · 3.4 km to work",
        "",
        "€1,185 total  (€1,050 + €135 service)",
        "58 m² · 3 rooms · upholstered",
        "From 1 Oct · min 12 months",
        "Registration ✓   Income: 3.5× rent",
        "",
        "Pararius · published 40 s ago",
        "https://fake.example/listing/abc123",
      ].join("\n"),
    );
  });

  it("formats a base_only listing without guessing the total", () => {
    const { priceTotalCents: _total, incomeRequirementMultiple: _income, ...rest } = complete;
    const listing: NormalizedListing = {
      ...rest,
      priceBasis: "base_only",
      areaSqm: 40,
      rooms: 1,
      furnished: "bare",
      availableFrom: new Date("2027-01-01"),
      minContractMonths: 1,
      registrationAllowed: false,
      publishedAt: new Date("2026-09-13T08:55:00Z"),
    };
    expect(formatTelegram(listing, search, { now, sourceName: "Pararius" })).toBe(
      [
        "Kruisstraat 112, Eindhoven",
        "5612 CJ",
        "",
        "€1,050 base, total unknown",
        "40 m² · 1 room · bare",
        "From 1 Jan 2027 · min 1 month",
        "Registration ✗   Income: not stated",
        "",
        "Pararius · published 1 h ago",
        "https://fake.example/listing/abc123",
      ].join("\n"),
    );
  });

  it("formats an all-in listing with its inclusions in a fixed, readable order", () => {
    const {
      priceBaseCents: _base,
      minContractMonths: _min,
      registrationAllowed: _registration,
      ...rest
    } = complete;
    const listing: NormalizedListing = {
      ...rest,
      street: "Hoogstraat",
      houseNumber: "208A",
      postcode: "5615PT",
      priceTotalCents: 127500,
      // Source order and a duplicate: neither may leak into the message.
      priceIncludes: ["electricity", "gas", "electricity"],
      areaSqm: 47,
      rooms: 2,
      furnished: "furnished",
      availableFrom: new Date("2026-12-15"),
      incomeRequirementMultiple: 4,
      publishedAt: new Date("2026-09-13T09:59:45Z"),
    };
    expect(formatTelegram(listing, search, { now, distanceKm: 5.1, sourceName: "Pararius" })).toBe(
      [
        "Hoogstraat 208A, Eindhoven",
        "5615 PT · 5.1 km to work",
        "",
        "€1,275 all-in  (gas + electricity included)",
        "47 m² · 2 rooms · furnished",
        "From 15 Dec",
        "Registration: not stated   Income: 4× rent",
        "",
        "Pararius · published 55 s ago",
        "https://fake.example/listing/abc123",
      ].join("\n"),
    );
  });

  it("says registration and income are not stated, and omits a missing available-from", () => {
    const {
      priceBaseCents: _base,
      priceIncludes: _includes,
      postcode: _postcode,
      furnished: _furnished,
      availableFrom: _from,
      registrationAllowed: _registration,
      incomeRequirementMultiple: _income,
      publishedAt: _published,
      ...rest
    } = complete;
    const text = formatTelegram(rest, search, {
      now,
      distanceKm: 3.4,
      sourceName: "Pararius",
      firstSeenAt: new Date("2026-09-13T09:57:00Z"),
    });
    expect(text).toBe(
      [
        "Kruisstraat 112, Eindhoven",
        "3.4 km to work",
        "",
        "€1,185 total",
        "58 m² · 3 rooms",
        "min 12 months",
        "Registration: not stated   Income: not stated",
        "",
        "Pararius · first seen 3 min ago",
        "https://fake.example/listing/abc123",
      ].join("\n"),
    );
  });

  it("prints only registration, income, source and link for a listing with no facts", () => {
    const bare: NormalizedListing = {
      sourceId: "fake",
      sourceListingId: "fake-0",
      canonicalUrl: "https://fake.example/listing/0",
    };
    expect(formatTelegram(bare, search, { now })).toBe(
      [
        "Registration: not stated   Income: not stated",
        "",
        "fake",
        "https://fake.example/listing/0",
      ].join("\n"),
    );
  });
});
