/**
 * Test fixtures against the compose Postgres. The pipeline's guarantees are
 * unique constraints and conditional UPDATEs, so a mocked database would test
 * nothing.
 *
 *   docker compose up -d && pnpm db:migrate
 */
import { randomInt, randomUUID } from "node:crypto";
import {
  type Db,
  createDb,
  dedupDecisions,
  listings,
  matches,
  notifications,
  properties,
  propertyListings,
  savedSearches,
} from "@pounce/db";
import { type SQL, eq, inArray, or, sql } from "drizzle-orm";
import type { NotifyJobData } from "../jobs/notify.js";

type SearchInsert = typeof savedSearches.$inferInsert;
type ListingInsert = typeof listings.$inferInsert;

export interface TestDb {
  db: Db;
  /** One saved search and one property with a representative listing. */
  seed(overrides?: {
    search?: Partial<SearchInsert>;
    listing?: Partial<ListingInsert>;
  }): Promise<NotifyJobData>;
  /** A saved search row, cleaned up on close(). */
  createSearch(overrides?: Partial<SearchInsert>): Promise<string>;
  /** Registers rows created by the code under test so close() removes them. */
  track(rows: { listingId?: string; propertyId?: string }): void;
  /** A notifications row for the pair, in whatever state the test needs. */
  insertNotification(
    data: NotifyJobData,
    state: {
      claimedAt?: SQL | null;
      createdAt?: SQL;
      sentAt?: Date;
      error?: string;
      attempts?: number;
      deadAt?: SQL;
    },
  ): Promise<void>;
  /** A matches row for the pair; matchedAt defaults to now. */
  insertMatch(data: NotifyJobData, state?: { matchedAt?: SQL }): Promise<void>;
  rowsFor(data: NotifyJobData): Promise<(typeof notifications.$inferSelect)[]>;
  /** Fails with a hint if Postgres is not reachable. */
  assertReachable(): Promise<void>;
  /** Deletes every created or tracked row and what hangs off it, then closes the pool. */
  close(): Promise<void>;
}

/** `now() - interval '<text>'`, on the database clock the lease logic uses. */
export const ago = (interval: string): SQL => sql`now() - ${interval}::interval`;

/**
 * A valid, normalized postcode no fixture uses (9xxx is Groningen/Friesland),
 * so dedup candidate lookups in parallel test files never see each other's rows.
 */
export function uniquePostcode(): string {
  const letter = () => String.fromCharCode(65 + randomInt(26));
  return `${9000 + randomInt(1000)}${letter()}${letter()}`;
}

export function createTestDb(): TestDb {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://pounce:pounce@localhost:5432/pounce");
  const created = {
    searchIds: new Set<string>(),
    propertyIds: new Set<string>(),
    listingIds: new Set<string>(),
  };

  async function createSearch(overrides: Partial<SearchInsert> = {}): Promise<string> {
    const [search] = await db
      .insert(savedSearches)
      .values({ name: "notify test", cities: ["Eindhoven"], telegramChatId: "4242", ...overrides })
      .returning({ id: savedSearches.id });
    if (!search) throw new Error("search insert returned no row");
    created.searchIds.add(search.id);
    return search.id;
  }

  return {
    db,
    createSearch,

    track({ listingId, propertyId }) {
      if (listingId) created.listingIds.add(listingId);
      if (propertyId) created.propertyIds.add(propertyId);
    },

    async seed(overrides = {}) {
      const searchId = await createSearch(overrides.search);
      const [listing] = await db
        .insert(listings)
        .values({
          sourceId: "fake",
          sourceListingId: `notify-test-${randomUUID()}`,
          canonicalUrl: "https://fake.example/listing/1001",
          publishedAt: new Date("2026-09-13T10:00:00Z"),
          street: "Kruisstraat",
          houseNumber: "112",
          postcode: "5612CJ",
          city: "Eindhoven",
          priceBaseCents: 105000,
          priceTotalCents: 118500,
          areaSqm: 58,
          rooms: 3,
          furnished: "upholstered",
          registrationAllowed: true,
          ...overrides.listing,
        })
        .returning({ id: listings.id });
      if (!listing) throw new Error("seed insert returned no row");
      created.listingIds.add(listing.id);
      const [property] = await db
        .insert(properties)
        .values({ fingerprintKind: "url", representativeListingId: listing.id })
        .returning({ id: properties.id });
      if (!property) throw new Error("seed insert returned no row");
      created.propertyIds.add(property.id);
      await db.insert(propertyListings).values({ propertyId: property.id, listingId: listing.id });
      return { searchId, propertyId: property.id };
    },

    async insertNotification(data, state) {
      await db.insert(notifications).values({ ...data, channel: "telegram", ...state });
    },

    async insertMatch(data, state = {}) {
      await db.insert(matches).values({ ...data, ...state });
    },

    rowsFor(data) {
      return db.select().from(notifications).where(eq(notifications.searchId, data.searchId));
    },

    async assertReachable() {
      try {
        await db.execute(sql`select 1`);
      } catch (err) {
        throw new Error(
          `worker DB tests need Postgres (docker compose up -d && pnpm db:migrate): ${String(err)}`,
        );
      }
    },

    async close() {
      const searchIds = [...created.searchIds];
      const propertyIds = [...created.propertyIds];
      const listingIds = [...created.listingIds];
      // Children before parents; inArray with an empty list matches nothing.
      if (searchIds.length > 0 || propertyIds.length > 0) {
        await db
          .delete(notifications)
          .where(
            or(
              inArray(notifications.searchId, searchIds),
              inArray(notifications.propertyId, propertyIds),
            ),
          );
        await db
          .delete(matches)
          .where(
            or(inArray(matches.searchId, searchIds), inArray(matches.propertyId, propertyIds)),
          );
      }
      if (listingIds.length > 0 || propertyIds.length > 0) {
        await db
          .delete(dedupDecisions)
          .where(
            or(
              inArray(dedupDecisions.listingId, listingIds),
              inArray(dedupDecisions.propertyId, propertyIds),
            ),
          );
      }
      if (propertyIds.length > 0) {
        await db.delete(propertyListings).where(inArray(propertyListings.propertyId, propertyIds));
        await db.delete(properties).where(inArray(properties.id, propertyIds));
      }
      if (listingIds.length > 0) await db.delete(listings).where(inArray(listings.id, listingIds));
      if (searchIds.length > 0) {
        await db.delete(savedSearches).where(inArray(savedSearches.id, searchIds));
      }
      await db.$client.end();
    },
  };
}
