/**
 * A listing poll has not seen before: normalize → insert → dedup into a
 * property → match against active saved searches → enqueue notify.
 *
 * Duplicate alerts are prevented by constraints, not checks: a matches row is
 * unique per (search, property) and only a freshly inserted one enqueues a
 * notify job; notifications is unique per (search, property, channel) behind
 * that. A listing that merges into an already-alerted property therefore
 * conflicts on matches and enqueues nothing.
 */
import {
  type CanonicalListingInput,
  type DedupCandidate,
  type DedupMatch,
  type NormalizedListing,
  type SavedSearchFilters,
  bestMatch,
  matches,
  newPropertyKind,
  normalize,
} from "@pounce/core";
import {
  type Db,
  dedupDecisions,
  listings,
  matches as matchRows,
  properties,
  propertyListings,
  savedSearches,
} from "@pounce/db";
import { and, asc, eq, ne, or } from "drizzle-orm";
import type { Logger } from "pino";
import { listingFromRow, searchFromRow } from "../rows.js";
import type { NotifyJobData } from "./notify.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ActiveSearch {
  id: string;
  filters: SavedSearchFilters;
}

export interface IngestDeps {
  db: Db;
  log: Logger;
  /** Enqueues notify jobs; the caller builds them with notifyJob() so jobIds match the sweeper's. */
  enqueueNotify: (jobs: NotifyJobData[]) => Promise<void>;
}

export interface IngestResult {
  listingId: string;
  propertyId: string;
  /** The dedup layer and score it merged on; undefined when it founded a new property. */
  merged: DedupMatch | undefined;
  searchesMatched: number;
  /** Matches that were new for their (search, property), each with one notify job. */
  alertsEnqueued: number;
}

export async function loadActiveSearches(db: Db): Promise<ActiveSearch[]> {
  const rows = await db.select().from(savedSearches).where(eq(savedSearches.active, true));
  return rows.map((r) => ({ id: r.id, filters: searchFromRow(r) }));
}

/**
 * Returns undefined if the listing was already stored (a concurrent insert won).
 * Throws only if normalize() rejects the URL or the database fails.
 *
 * Listing, property and matches commit together; notify jobs are enqueued after
 * the commit, so a job never runs before its property exists.
 */
export async function ingestNewListing(
  deps: IngestDeps,
  sourceId: string,
  input: CanonicalListingInput,
  now: Date,
  searches: readonly ActiveSearch[],
): Promise<IngestResult | undefined> {
  const listing = normalize(input, sourceId);

  const stored = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(listings)
      .values(toListingRow(listing, now))
      .onConflictDoNothing({ target: [listings.sourceId, listings.sourceListingId] })
      .returning({ id: listings.id });
    if (!row) return undefined;

    const { propertyId, merged } = await assignProperty(tx, row.id, listing);
    const matched = searches.filter((s) => matches(listing, s.filters).matched);
    const newMatches =
      matched.length === 0
        ? []
        : await tx
            .insert(matchRows)
            .values(matched.map((s) => ({ searchId: s.id, propertyId })))
            .onConflictDoNothing({ target: [matchRows.searchId, matchRows.propertyId] })
            .returning({ searchId: matchRows.searchId });
    return { listingId: row.id, propertyId, merged, matched: matched.length, newMatches };
  });
  if (!stored) return undefined;

  const { listingId, propertyId, merged, newMatches } = stored;
  // If this throws, the match exists without a notify job (see docs/backlog.md).
  if (newMatches.length > 0) {
    await deps.enqueueNotify(newMatches.map(({ searchId }) => ({ searchId, propertyId })));
  }

  const result: IngestResult = {
    listingId,
    propertyId,
    merged,
    searchesMatched: stored.matched,
    alertsEnqueued: newMatches.length,
  };
  deps.log.info(
    {
      event: "listing",
      source: sourceId,
      listingId,
      propertyId,
      merged: merged !== undefined,
      layer: merged?.kind ?? null,
      score: merged?.score ?? null,
      searchesMatched: result.searchesMatched,
      alertsEnqueued: result.alertsEnqueued,
    },
    "listing ingested",
  );
  return result;
}

/**
 * Attaches the listing to the best-matching existing property, recording the
 * decision, or founds a new property with it as representative.
 *
 * Not safe under concurrent polls: two new listings of one flat could each
 * found a property. The poll worker runs with concurrency 1.
 */
async function assignProperty(
  tx: Tx,
  listingId: string,
  listing: NormalizedListing,
): Promise<{ propertyId: string; merged: DedupMatch | undefined }> {
  const hit = bestMatch(listing, await findCandidates(tx, listingId, listing));
  if (hit) {
    await tx.insert(propertyListings).values({ propertyId: hit.propertyId, listingId });
    await tx.insert(dedupDecisions).values({
      listingId,
      propertyId: hit.propertyId,
      kind: hit.match.kind,
      score: hit.match.score,
    });
    return { propertyId: hit.propertyId, merged: hit.match };
  }

  const [property] = await tx
    .insert(properties)
    .values({
      fingerprintKind: newPropertyKind(listing),
      postcode: listing.postcode ?? null,
      houseNumber: listing.houseNumber ?? null,
      representativeListingId: listingId,
    })
    .returning({ id: properties.id });
  if (!property) throw new Error("properties insert returned no row");
  await tx.insert(propertyListings).values({ propertyId: property.id, listingId });
  return { propertyId: property.id, merged: undefined };
}

/**
 * Listings that already belong to a property and share this one's postcode or
 * canonical URL — every listing any dedup layer could match. Oldest first, so
 * ties in bestMatch go to the longest-known property.
 */
async function findCandidates(
  tx: Tx,
  listingId: string,
  listing: NormalizedListing,
): Promise<DedupCandidate[]> {
  const sameUrl = eq(listings.canonicalUrl, listing.canonicalUrl);
  const shared =
    listing.postcode === undefined ? sameUrl : or(sameUrl, eq(listings.postcode, listing.postcode));
  const rows = await tx
    .select({ listing: listings, propertyId: propertyListings.propertyId })
    .from(listings)
    .innerJoin(propertyListings, eq(propertyListings.listingId, listings.id))
    .where(and(shared, ne(listings.id, listingId)))
    .orderBy(asc(listings.firstSeenAt), asc(listings.id));
  return rows.map((r) => ({ listing: listingFromRow(r.listing), propertyId: r.propertyId }));
}

function toListingRow(l: NormalizedListing, now: Date): typeof listings.$inferInsert {
  return {
    sourceId: l.sourceId,
    sourceListingId: l.sourceListingId,
    canonicalUrl: l.canonicalUrl,
    firstSeenAt: now,
    lastSeenAt: now,
    publishedAt: l.publishedAt ?? null,
    title: l.title ?? null,
    addressRaw: l.addressRaw ?? null,
    street: l.street ?? null,
    houseNumber: l.houseNumber ?? null,
    postcode: l.postcode ?? null,
    city: l.city ?? null,
    lat: l.lat ?? null,
    lng: l.lng ?? null,
    geoPrecision: l.geoPrecision ?? null,
    priceBaseCents: l.priceBaseCents ?? null,
    priceTotalCents: l.priceTotalCents ?? null,
    priceIncludes: l.priceIncludes ?? null,
    depositCents: l.depositCents ?? null,
    areaSqm: l.areaSqm ?? null,
    rooms: l.rooms ?? null,
    bedrooms: l.bedrooms ?? null,
    propertyType: l.propertyType ?? null,
    furnished: l.furnished ?? null,
    availableFrom: l.availableFrom ?? null,
    minContractMonths: l.minContractMonths ?? null,
    registrationAllowed: l.registrationAllowed ?? null,
    petsAllowed: l.petsAllowed ?? null,
    incomeRequirementMultiple:
      l.incomeRequirementMultiple === undefined ? null : String(l.incomeRequirementMultiple),
    agencyName: l.agencyName ?? null,
    agencyFeeFlagged: l.agencyFeeFlagged ?? null,
    rawPayload: l.extra ?? null,
  };
}
