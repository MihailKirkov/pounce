import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testing } from "@pounce/core";
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "./index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

describe("fake adapter", () => {
  it("satisfies the adapter contract against fixtures", async () => {
    const ctx = await testing.createTestContext({ fixturesDir });
    const { canon } = await testing.assertAdapterContract(fakeAdapter, ctx, {
      cities: ["Eindhoven"],
    });
    expect(canon).toHaveLength(3);
    expect(ctx.http.requests).toEqual(["https://fake.example/api/list?city=eindhoven"]);
  });

  it("maps all-in vs base+service correctly", async () => {
    const ctx = await testing.createTestContext({ fixturesDir });
    const { canon } = await testing.assertAdapterContract(fakeAdapter, ctx, {
      cities: ["Eindhoven"],
    });
    const [a, b] = canon;
    expect(a?.priceBaseCents).toBe(105000);
    expect(a?.priceTotalCents).toBe(118500);
    expect(b?.priceBaseCents).toBeUndefined();
    expect(b?.priceTotalCents).toBe(127500);
  });

  it("leaves registration unknown until detail() runs", async () => {
    const ctx = await testing.createTestContext({ fixturesDir });
    const { raws } = await testing.assertAdapterContract(fakeAdapter, ctx, {
      cities: ["Eindhoven"],
    });
    const first = raws[0];
    if (!first || !fakeAdapter.detail) {
      throw new Error("expected a fixture listing and a detail() implementation");
    }
    expect(fakeAdapter.toCanonical(first).registrationAllowed).toBeUndefined();
    const enriched = await fakeAdapter.detail(first, ctx);
    const c = fakeAdapter.toCanonical(enriched);
    expect(c.registrationAllowed).toBe(true);
    expect(c.depositCents).toBe(210000);
    expect(c.agencyName).toBe("Bergs Vastgoed");
  });
});
