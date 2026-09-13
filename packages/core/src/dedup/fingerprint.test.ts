import { describe, expect, it } from "vitest";
import { type NormalizedListing, normalize } from "../normalize/index.js";
import { bestMatch, fingerprints, matchLayer, newPropertyKind } from "./fingerprint.js";

function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    sourceId: "fake",
    sourceListingId: "fake-1",
    canonicalUrl: "https://fake.example/listing/1",
    postcode: "5612CJ",
    houseNumber: "112",
    priceTotalCents: 100000,
    areaSqm: 50,
    rooms: 3,
    ...overrides,
  };
}

/** Same flat, second source: different URL, no house number, so only fuzzy can link it. */
function elsewhere(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  const { houseNumber: _, ...rest } = listing({
    sourceId: "other",
    sourceListingId: "other-9",
    canonicalUrl: "https://other.example/huur/9",
  });
  return { ...rest, ...overrides };
}

describe("fingerprints", () => {
  it("always has the url", () => {
    expect(fingerprints(listing()).url).toBe("https://fake.example/listing/1");
  });

  it("has an address key when postcode and house number are both present", () => {
    expect(fingerprints(listing()).address).toBe("5612CJ|112");
  });

  it("has no address key when either part is missing or empty", () => {
    const { postcode: _p, ...noPostcode } = listing();
    const { houseNumber: _h, ...noNumber } = listing();
    expect(fingerprints(noPostcode).address).toBeUndefined();
    expect(fingerprints(noNumber).address).toBeUndefined();
    expect(fingerprints(listing({ houseNumber: "" })).address).toBeUndefined();
    expect(fingerprints(listing({ postcode: "" })).address).toBeUndefined();
  });

  it("has a fuzzy key when postcode, total price, area and rooms are all present", () => {
    expect(fingerprints(listing()).fuzzy).toEqual({
      postcode: "5612CJ",
      priceTotalCents: 100000,
      areaSqm: 50,
      rooms: 3,
    });
  });

  it("has no fuzzy key when any of the four is missing", () => {
    for (const field of ["postcode", "priceTotalCents", "areaSqm", "rooms"] as const) {
      const { [field]: _, ...rest } = listing();
      expect(fingerprints(rest).fuzzy, field).toBeUndefined();
    }
  });
});

describe("matchLayer", () => {
  it("matches on equal canonical URLs with score 1", () => {
    const a = listing({ postcode: "1012AB" });
    const b = listing({ sourceListingId: "fake-2", postcode: "5615PT", houseNumber: "9" });
    expect(matchLayer(a, b)).toEqual({ kind: "url", score: 1 });
  });

  it("returns the first layer that hits: url before address", () => {
    expect(matchLayer(listing(), listing())).toEqual({ kind: "url", score: 1 });
  });

  it("merges the same flat on two sources with different URLs and casing by address", () => {
    const pararius = normalize(
      {
        sourceListingId: "p-1",
        url: "https://www.pararius.nl/appartement-te-huur/eindhoven/abc/hoogstraat",
        addressRaw: "Hoogstraat 208a",
        postcode: "5615 pt",
        priceTotalCents: 127500,
      },
      "pararius",
    );
    const huurwoningen = normalize(
      {
        sourceListingId: "h-1",
        url: "https://huurwoningen.nl/huren/eindhoven/123/hoogstraat/",
        street: "Hoogstraat",
        houseNumber: "208A",
        postcode: "5615PT",
        priceTotalCents: 129000,
      },
      "huurwoningen",
    );
    expect(fingerprints(pararius).address).toBe(fingerprints(huurwoningen).address);
    expect(matchLayer(pararius, huurwoningen)).toEqual({ kind: "address", score: 1 });
  });

  it("does not merge two different flats in one building", () => {
    const a = listing({ houseNumber: "112", priceTotalCents: 95000, areaSqm: 44, rooms: 2 });
    const b = listing({
      canonicalUrl: "https://fake.example/listing/2",
      houseNumber: "114",
      priceTotalCents: 140000,
      areaSqm: 80,
      rooms: 4,
    });
    expect(matchLayer(a, b)).toBeUndefined();
  });

  it("does not fuzzy-merge identical units at different known house numbers", () => {
    const a = listing({ houseNumber: "112" });
    const b = listing({ canonicalUrl: "https://fake.example/listing/2", houseNumber: "114" });
    expect(matchLayer(a, b)).toBeUndefined();
  });

  it("fuzzy-merges a listing 4% cheaper and 8% smaller", () => {
    const m = matchLayer(elsewhere({ priceTotalCents: 96000, areaSqm: 46 }), listing());
    expect(m?.kind).toBe("fuzzy");
    expect(m?.score).toBeGreaterThan(0);
    expect(m?.score).toBeLessThan(1);
  });

  it("does not fuzzy-merge at 6% cheaper", () => {
    expect(matchLayer(elsewhere({ priceTotalCents: 94000 }), listing())).toBeUndefined();
  });

  it("does not fuzzy-merge at 11% smaller", () => {
    expect(matchLayer(elsewhere({ areaSqm: 89 }), listing({ areaSqm: 100 }))).toBeUndefined();
  });

  it("includes the ±5% and ±10% boundaries", () => {
    expect(matchLayer(elsewhere({ priceTotalCents: 95000, areaSqm: 45 }), listing())?.kind).toBe(
      "fuzzy",
    );
  });

  it("never fuzzy-matches when rooms is missing on either side", () => {
    const { rooms: _, ...noRooms } = elsewhere();
    expect(matchLayer(noRooms, listing())).toBeUndefined();
    expect(matchLayer(listing(), noRooms)).toBeUndefined();
  });

  it("never fuzzy-matches a base_only listing, since there is no total to compare", () => {
    const { priceTotalCents: _, ...baseOnly } = elsewhere({ priceBaseCents: 100000 });
    expect(matchLayer(baseOnly, listing())).toBeUndefined();
  });

  it("requires equal rooms and equal postcode for fuzzy", () => {
    expect(matchLayer(elsewhere({ rooms: 2 }), listing())).toBeUndefined();
    expect(matchLayer(elsewhere({ postcode: "5612CK" }), listing())).toBeUndefined();
  });

  it("scores identical price and area as 1, and closer pairs above farther ones", () => {
    expect(matchLayer(elsewhere(), listing())).toEqual({ kind: "fuzzy", score: 1 });
    const close = matchLayer(elsewhere({ priceTotalCents: 99000, areaSqm: 49 }), listing());
    const far = matchLayer(elsewhere({ priceTotalCents: 96000, areaSqm: 46 }), listing());
    expect(close?.score).toBeGreaterThan(far?.score ?? 1);
  });

  it("gives the same answer regardless of argument order", () => {
    const a = elsewhere({ priceTotalCents: 95500, areaSqm: 46 });
    const b = listing();
    expect(matchLayer(a, b)).toEqual(matchLayer(b, a));
  });

  it("returns undefined when nothing matches", () => {
    expect(
      matchLayer(
        listing(),
        elsewhere({ postcode: "5502JV", priceTotalCents: 87000, areaSqm: 44, rooms: 2 }),
      ),
    ).toBeUndefined();
  });
});

describe("bestMatch", () => {
  it("returns undefined when no existing listing matches", () => {
    const far = elsewhere({ postcode: "5502JV" });
    expect(bestMatch(listing(), [{ listing: far, propertyId: "p-far" }])).toBeUndefined();
    expect(bestMatch(listing(), [])).toBeUndefined();
  });

  it("prefers a stronger layer over an earlier weaker hit: url over address over fuzzy", () => {
    const fuzzy = { listing: elsewhere(), propertyId: "p-fuzzy" };
    const address = {
      listing: listing({ sourceId: "other", canonicalUrl: "https://other.example/huur/1" }),
      propertyId: "p-address",
    };
    const url = { listing: listing({ sourceListingId: "fake-1-relisted" }), propertyId: "p-url" };

    expect(bestMatch(listing(), [fuzzy, address])).toEqual({
      match: { kind: "address", score: 1 },
      propertyId: "p-address",
    });
    expect(bestMatch(listing(), [fuzzy, address, url])).toEqual({
      match: { kind: "url", score: 1 },
      propertyId: "p-url",
    });
  });

  it("among fuzzy hits, takes the highest score", () => {
    const close = { listing: elsewhere({ priceTotalCents: 99000 }), propertyId: "p-close" };
    const exact = { listing: elsewhere(), propertyId: "p-exact" };
    expect(bestMatch(listing(), [close, exact])?.propertyId).toBe("p-exact");
    expect(bestMatch(listing(), [exact, close])?.propertyId).toBe("p-exact");
  });
});

describe("newPropertyKind", () => {
  it("is address when the listing carries an address fingerprint", () => {
    expect(newPropertyKind(listing())).toBe("address");
  });

  it("is url when it doesn't, even if a fuzzy key exists", () => {
    expect(newPropertyKind(elsewhere())).toBe("url");
  });
});
