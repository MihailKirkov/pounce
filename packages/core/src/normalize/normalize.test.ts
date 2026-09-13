import { describe, expect, it } from "vitest";
import type { CanonicalListingInput } from "../listing.js";
import { postcodeCentroid } from "./geo.js";
import { normalize } from "./index.js";

const minimal: CanonicalListingInput = {
  sourceListingId: "fake-1",
  url: "https://fake.example/listing/1",
};

describe("normalize", () => {
  it("sets identity and canonicalizes the url", () => {
    const n = normalize(
      { ...minimal, url: "http://www.fake.example/listing/1/?utm_source=x" },
      "fake",
    );
    expect(n.sourceId).toBe("fake");
    expect(n.sourceListingId).toBe("fake-1");
    expect(n.canonicalUrl).toBe("https://fake.example/listing/1");
    expect("url" in n).toBe(false);
  });

  it("does not throw on a listing with only the required fields, and invents nothing", () => {
    expect(normalize(minimal, "fake")).toEqual({
      sourceId: "fake",
      sourceListingId: "fake-1",
      canonicalUrl: "https://fake.example/listing/1",
    });
  });

  it("throws only when the required url is not an absolute http(s) URL", () => {
    expect(() => normalize({ ...minimal, url: "/listing/1" }, "fake")).toThrow();
  });

  it("keeps adapter lat/lng and sets geoPrecision exact", () => {
    const n = normalize({ ...minimal, postcode: "5612 CJ", lat: 51.446, lng: 5.478 }, "fake");
    expect(n.lat).toBe(51.446);
    expect(n.lng).toBe(5.478);
    expect(n.geoPrecision).toBe("exact");
  });

  it("fills centroid coords from a postcode and sets geoPrecision postcode", () => {
    const n = normalize({ ...minimal, postcode: "5615 pt" }, "fake");
    const centroid = postcodeCentroid("5615");
    expect(centroid).toBeDefined();
    expect(n.postcode).toBe("5615PT");
    expect(n.lat).toBe(centroid?.lat);
    expect(n.lng).toBe(centroid?.lng);
    expect(n.geoPrecision).toBe("postcode");
  });

  it("gives no coords and no geoPrecision when there is neither lat/lng nor a known postcode", () => {
    for (const input of [
      minimal,
      { ...minimal, postcode: "1012AB" },
      { ...minimal, postcode: "?" },
    ]) {
      const n = normalize(input, "fake");
      expect(n.lat).toBeUndefined();
      expect(n.lng).toBeUndefined();
      expect(n.geoPrecision).toBeUndefined();
    }
  });

  it("falls back to the centroid when adapter coords are partial or out of range", () => {
    const onlyLat = normalize({ ...minimal, postcode: "5502JV", lat: 51.4 }, "fake");
    expect(onlyLat.geoPrecision).toBe("postcode");
    expect(onlyLat.lat).toBe(postcodeCentroid("5502")?.lat);

    const bogus = normalize({ ...minimal, lat: Number.NaN, lng: 500 }, "fake");
    expect(bogus.lat).toBeUndefined();
    expect(bogus.lng).toBeUndefined();
    expect(bogus.geoPrecision).toBeUndefined();
  });

  it("drops a postcode that doesn't parse instead of passing it through", () => {
    expect(normalize({ ...minimal, postcode: "Eindhoven" }, "fake").postcode).toBeUndefined();
  });

  it("fills street and house number from addressRaw when the adapter didn't split them", () => {
    const n = normalize({ ...minimal, addressRaw: "Hoogstraat 208A, 5615 PT Eindhoven" }, "fake");
    expect(n.addressRaw).toBe("Hoogstraat 208A, 5615 PT Eindhoven");
    expect(n.street).toBe("Hoogstraat");
    expect(n.houseNumber).toBe("208A");
  });

  it("prefers the adapter's own street and house number, trimmed", () => {
    const n = normalize(
      {
        ...minimal,
        addressRaw: "Straat 2e Hoek 14",
        street: " Straat 2e Hoek ",
        houseNumber: "14 ",
      },
      "fake",
    );
    expect(n.street).toBe("Straat 2e Hoek");
    expect(n.houseNumber).toBe("14");
  });

  it("uppercases house numbers from both the adapter and addressRaw", () => {
    expect(
      normalize({ ...minimal, street: "Hoogstraat", houseNumber: "208a" }, "fake").houseNumber,
    ).toBe("208A");
    expect(normalize({ ...minimal, addressRaw: "Hoogstraat 208a" }, "fake").houseNumber).toBe(
      "208A",
    );
  });

  it("collapses whitespace in text fields and drops blank ones", () => {
    const n = normalize(
      { ...minimal, title: "  Kruisstraat\n 112 ", city: " Eindhoven ", agencyName: "   " },
      "fake",
    );
    expect(n.title).toBe("Kruisstraat 112");
    expect(n.city).toBe("Eindhoven");
    expect("agencyName" in n).toBe(false);
  });

  it("resolves prices", () => {
    expect(
      normalize({ ...minimal, priceBaseCents: 105000, priceTotalCents: 118500 }, "fake"),
    ).toMatchObject({ priceBaseCents: 105000, priceTotalCents: 118500, priceBasis: "exact" });

    const allIn = normalize(
      { ...minimal, priceTotalCents: 127500, priceIncludes: ["gas", "electricity"] },
      "fake",
    );
    expect(allIn).toMatchObject({ priceTotalCents: 127500, priceBasis: "exact" });
    expect(allIn.priceBaseCents).toBeUndefined();
    expect(allIn.priceIncludes).toEqual(["gas", "electricity"]);

    const baseOnly = normalize({ ...minimal, priceBaseCents: 87000 }, "fake");
    expect(baseOnly).toMatchObject({ priceBaseCents: 87000, priceBasis: "base_only" });
    expect(baseOnly.priceTotalCents).toBeUndefined();
  });

  it("keeps null-vs-false tri-states exactly as given", () => {
    const unknown = normalize(minimal, "fake");
    expect("registrationAllowed" in unknown).toBe(false);
    expect("petsAllowed" in unknown).toBe(false);
    expect("incomeRequirementMultiple" in unknown).toBe(false);

    const explicit = normalize(
      { ...minimal, registrationAllowed: false, petsAllowed: true, incomeRequirementMultiple: 3.5 },
      "fake",
    );
    expect(explicit.registrationAllowed).toBe(false);
    expect(explicit.petsAllowed).toBe(true);
    expect(explicit.incomeRequirementMultiple).toBe(3.5);
  });

  it("passes the remaining facts through untouched", () => {
    const publishedAt = new Date("2026-09-12T11:58:00Z");
    const availableFrom = new Date("2027-01-01");
    const n = normalize(
      {
        ...minimal,
        publishedAt,
        availableFrom,
        depositCents: 210000,
        areaSqm: 58,
        rooms: 3,
        bedrooms: 2,
        propertyType: "apartment",
        furnished: "upholstered",
        minContractMonths: 12,
        agencyFeeFlagged: true,
        extra: { categoryId: 7 },
      },
      "fake",
    );
    expect(n).toMatchObject({
      publishedAt,
      availableFrom,
      depositCents: 210000,
      areaSqm: 58,
      rooms: 3,
      bedrooms: 2,
      propertyType: "apartment",
      furnished: "upholstered",
      minContractMonths: 12,
      agencyFeeFlagged: true,
      extra: { categoryId: 7 },
    });
  });

  it("does not mutate its input", () => {
    const input: CanonicalListingInput = {
      ...minimal,
      url: "http://www.fake.example/listing/1?utm_source=x",
      postcode: "5612 cj",
      title: " t ",
    };
    const copy = structuredClone(input);
    normalize(input, "fake");
    expect(input).toEqual(copy);
  });
});
