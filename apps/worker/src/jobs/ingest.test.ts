import { randomUUID } from "node:crypto";
import type { CanonicalListingInput, SavedSearchFilters } from "@pounce/core";
import { dedupDecisions, listings, matches, properties, propertyListings } from "@pounce/db";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, uniquePostcode } from "../testing/db.js";
import { type ActiveSearch, type IngestResult, ingestNewListing } from "./ingest.js";
import type { NotifyJobData } from "./notify.js";

const t = createTestDb();
const now = new Date("2026-09-13T12:00:00Z");

const filters: SavedSearchFilters = {
  cities: ["Eindhoven"],
  priceTotalMinCents: 70000,
  priceTotalMaxCents: 130000,
  areaSqmMin: 40,
  roomsMin: 2,
  propertyTypes: ["apartment", "studio"],
  furnished: ["bare", "upholstered", "furnished", "not_stated"],
  registration: "any",
};

/** One flat at a fresh postcode, as an adapter would hand it over (not yet normalized). */
function flat(postcode: string, overrides: Partial<CanonicalListingInput> = {}) {
  const id = randomUUID();
  return {
    sourceListingId: `ingest-test-${id}`,
    url: `https://fake.example/listing/${id}?utm_source=test`,
    street: "Teststraat",
    houseNumber: "12a",
    postcode: `${postcode.slice(0, 4)} ${postcode.slice(4).toLowerCase()}`,
    city: "Eindhoven",
    priceBaseCents: 105000,
    priceTotalCents: 118500,
    areaSqm: 58,
    rooms: 3,
    propertyType: "apartment",
    furnished: "upholstered",
    ...overrides,
  } satisfies CanonicalListingInput;
}

async function setup() {
  const search: ActiveSearch = { id: await t.createSearch(), filters };
  const enqueueNotify = vi.fn(async (_jobs: NotifyJobData[]) => {});
  const deps = { db: t.db, log: pino({ level: "silent" }), enqueueNotify };
  const ingest = async (sourceId: string, input: CanonicalListingInput): Promise<IngestResult> => {
    const result = await ingestNewListing(deps, sourceId, input, now, [search]);
    if (!result) throw new Error("listing was not new");
    t.track(result);
    return result;
  };
  return { search, enqueueNotify, ingest };
}

const listingsOf = (propertyId: string) =>
  t.db.select().from(propertyListings).where(eq(propertyListings.propertyId, propertyId));
const matchesOf = (propertyId: string) =>
  t.db.select().from(matches).where(eq(matches.propertyId, propertyId));

beforeEach(() => t.assertReachable());
afterAll(() => t.close());

describe("ingestNewListing", () => {
  it("a listing with no similar existing listing creates one property, one match and one notify job", async () => {
    const { search, enqueueNotify, ingest } = await setup();
    const postcode = uniquePostcode();

    const r = await ingest("fake", flat(postcode));

    expect(r.merged).toBeUndefined();
    expect(r.searchesMatched).toBe(1);
    // Stored normalized, so later dedup lookups by postcode and URL can find it.
    const [row] = await t.db.select().from(listings).where(eq(listings.id, r.listingId));
    expect(row?.postcode).toBe(postcode);
    expect(row?.houseNumber).toBe("12A");
    expect(row?.canonicalUrl).not.toContain("utm_source");

    const [property] = await t.db.select().from(properties).where(eq(properties.id, r.propertyId));
    expect(property).toMatchObject({
      representativeListingId: r.listingId,
      fingerprintKind: "address",
      postcode,
      houseNumber: "12A",
    });
    expect(await listingsOf(r.propertyId)).toHaveLength(1);
    expect(await matchesOf(r.propertyId)).toEqual([
      expect.objectContaining({ searchId: search.id, status: "new" }),
    ]);
    expect(enqueueNotify).toHaveBeenCalledTimes(1);
    expect(enqueueNotify).toHaveBeenCalledWith([{ searchId: search.id, propertyId: r.propertyId }]);
  });

  it("a second listing for the same address merges into the existing property and enqueues nothing new", async () => {
    const { enqueueNotify, ingest } = await setup();
    const postcode = uniquePostcode();

    const first = await ingest("fake", flat(postcode));
    // Same flat on another source: different URL and id, slightly different price.
    const second = await ingest("other", flat(postcode, { priceTotalCents: 119900 }));

    expect(second.propertyId).toBe(first.propertyId);
    expect(second.merged).toEqual({ kind: "address", score: 1 });
    expect(second.searchesMatched).toBe(1);
    expect(await listingsOf(first.propertyId)).toHaveLength(2);
    expect(
      await t.db
        .select()
        .from(dedupDecisions)
        .where(eq(dedupDecisions.listingId, second.listingId)),
    ).toEqual([
      expect.objectContaining({ propertyId: first.propertyId, kind: "address", score: 1 }),
    ]);
    // The second listing matched too, but the matches constraint already held the pair.
    expect(await matchesOf(first.propertyId)).toHaveLength(1);
    expect(enqueueNotify).toHaveBeenCalledTimes(1);
    expect(
      await t.db
        .select()
        .from(properties)
        .where(eq(properties.representativeListingId, second.listingId)),
    ).toHaveLength(0);
  });

  it("a listing that fails the matcher creates a property but no match and no notify job", async () => {
    const { enqueueNotify, ingest } = await setup();

    const r = await ingest("fake", flat(uniquePostcode(), { city: "Veldhoven" }));

    expect(r.searchesMatched).toBe(0);
    expect(
      await t.db.select().from(properties).where(eq(properties.id, r.propertyId)),
    ).toHaveLength(1);
    expect(await listingsOf(r.propertyId)).toHaveLength(1);
    expect(await matchesOf(r.propertyId)).toHaveLength(0);
    expect(enqueueNotify).not.toHaveBeenCalled();
  });

  it("returns undefined and does nothing for a listing that is already stored", async () => {
    const { enqueueNotify, ingest, search } = await setup();
    const input = flat(uniquePostcode());
    await ingest("fake", input);

    const again = await ingestNewListing(
      { db: t.db, log: pino({ level: "silent" }), enqueueNotify },
      "fake",
      input,
      now,
      [search],
    );

    expect(again).toBeUndefined();
    expect(enqueueNotify).toHaveBeenCalledTimes(1);
  });
});
