import type { listings } from "@pounce/db";
import { describe, expect, it } from "vitest";
import { listingFromRow } from "./rows.js";

const row: typeof listings.$inferSelect = {
  id: "00000000-0000-0000-0000-000000000001",
  sourceId: "fake",
  sourceListingId: "fake-1002",
  canonicalUrl: "https://fake.example/listing/1002",
  firstSeenAt: new Date("2026-09-13T10:00:00Z"),
  publishedAt: null,
  title: null,
  addressRaw: null,
  street: null,
  houseNumber: null,
  postcode: null,
  city: null,
  lat: null,
  lng: null,
  geoPrecision: null,
  priceBaseCents: null,
  priceTotalCents: 127500,
  priceIncludes: ["gas", "electricity", "sauna"],
  depositCents: null,
  areaSqm: null,
  rooms: null,
  bedrooms: null,
  propertyType: null,
  furnished: null,
  availableFrom: null,
  minContractMonths: null,
  registrationAllowed: null,
  petsAllowed: null,
  incomeRequirementMultiple: "4",
  agencyName: null,
  agencyFeeFlagged: null,
  rawPayload: null,
  lastSeenAt: new Date("2026-09-13T10:00:00Z"),
  goneAt: null,
};

describe("listingFromRow", () => {
  it("drops nulls, parses numeric, and keeps only known price inclusions", () => {
    expect(listingFromRow(row)).toEqual({
      sourceId: "fake",
      sourceListingId: "fake-1002",
      canonicalUrl: "https://fake.example/listing/1002",
      priceTotalCents: 127500,
      priceIncludes: ["gas", "electricity"],
      incomeRequirementMultiple: 4,
    });
  });
});
