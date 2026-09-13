import { describe, expect, it } from "vitest";
import { resolvePrice } from "./price.js";

describe("resolvePrice", () => {
  it("keeps base 105000 with total 118500 as exact", () => {
    expect(
      resolvePrice({
        priceBaseCents: 105000,
        priceTotalCents: 118500,
        priceIncludes: ["service_costs"],
      }),
    ).toEqual({ priceBaseCents: 105000, priceTotalCents: 118500, priceBasis: "exact" });
  });

  it("keeps an all-in total with base undefined, basis exact", () => {
    const r = resolvePrice({ priceTotalCents: 127500, priceIncludes: ["gas", "electricity"] });
    expect(r).toEqual({ priceTotalCents: 127500, priceBasis: "exact" });
    expect("priceBaseCents" in r).toBe(false);
  });

  it("leaves total undefined for base-only, basis base_only — no service-cost estimate", () => {
    const r = resolvePrice({ priceBaseCents: 87000 });
    expect(r).toEqual({ priceBaseCents: 87000, priceBasis: "base_only" });
    expect("priceTotalCents" in r).toBe(false);
  });

  it("does not derive a total from priceIncludes on a base-only listing", () => {
    expect(resolvePrice({ priceBaseCents: 87000, priceIncludes: ["service_costs"] })).toEqual({
      priceBaseCents: 87000,
      priceBasis: "base_only",
    });
  });

  it("has no basis when there is no price at all", () => {
    expect(resolvePrice({})).toEqual({});
  });

  it("treats a value that isn't a non-negative integer as absent", () => {
    expect(resolvePrice({ priceBaseCents: Number.NaN, priceTotalCents: 118500 })).toEqual({
      priceTotalCents: 118500,
      priceBasis: "exact",
    });
    expect(resolvePrice({ priceBaseCents: 105000, priceTotalCents: -1 })).toEqual({
      priceBaseCents: 105000,
      priceBasis: "base_only",
    });
    expect(resolvePrice({ priceBaseCents: 1050.5 })).toEqual({});
  });
});
