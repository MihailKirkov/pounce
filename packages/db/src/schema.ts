/**
 * Postgres schema. Mirrors docs/data-model.md — change the doc first.
 *
 * Money is integer cents. Every listing field is nullable unless the doc marks
 * it req: a missing field may fail matching, never ingestion. For
 * registration_allowed / pets_allowed / income_requirement_multiple, null means
 * "source didn't say" and is not false.
 */
import {
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const propertyType = pgEnum("property_type", ["apartment", "house", "studio", "room"]);

/** kaal / gestoffeerd / gemeubileerd */
export const furnished = pgEnum("furnished", ["bare", "upholstered", "furnished"]);

/** required drops null; preferred keeps null but sorts true first; any ignores it. */
export const registrationMode = pgEnum("registration_mode", ["required", "preferred", "any"]);

export const matchStatus = pgEnum("match_status", ["new", "seen", "rejected"]);

/** Which dedup layer matched. Shared by properties and dedup_decisions. */
export const fingerprintKind = pgEnum("fingerprint_kind", ["url", "address", "fuzzy"]);

/** exact = source gave coordinates; postcode = PC4 centroid fallback (DECISIONS #008). */
export const geoPrecision = pgEnum("geo_precision", ["exact", "postcode"]);

// ---------------------------------------------------------------------------
// listings — one row per (source, source_listing_id)
// ---------------------------------------------------------------------------

/** Structured fields only. Never description text or image URLs (DECISIONS #004). */
export type RawPayload = Record<string, string | number | boolean | null>;

export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: text("source_id").notNull(),
    sourceListingId: text("source_listing_id").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    publishedAt: timestamptz("published_at"),

    title: text("title"),
    addressRaw: text("address_raw"),
    street: text("street"),
    houseNumber: text("house_number"),
    postcode: text("postcode"),
    city: text("city"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    geoPrecision: geoPrecision("geo_precision"),

    priceBaseCents: integer("price_base_cents"),
    priceTotalCents: integer("price_total_cents"),
    priceIncludes: text("price_includes").array(),
    depositCents: integer("deposit_cents"),

    areaSqm: integer("area_sqm"),
    rooms: integer("rooms"),
    bedrooms: integer("bedrooms"),
    propertyType: propertyType("property_type"),
    furnished: furnished("furnished"),

    availableFrom: date("available_from", { mode: "date" }),
    minContractMonths: integer("min_contract_months"),
    registrationAllowed: boolean("registration_allowed"),
    petsAllowed: boolean("pets_allowed"),
    incomeRequirementMultiple: numeric("income_requirement_multiple"),

    agencyName: text("agency_name"),
    agencyFeeFlagged: boolean("agency_fee_flagged"),

    rawPayload: jsonb("raw_payload").$type<RawPayload>(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    goneAt: timestamptz("gone_at"),
  },
  (t) => [unique("listings_source_listing_unique").on(t.sourceId, t.sourceListingId)],
);

// ---------------------------------------------------------------------------
// properties — one row per deduplicated physical property
// ---------------------------------------------------------------------------

export const properties = pgTable("properties", {
  id: uuid("id").primaryKey().defaultRandom(),
  fingerprintKind: fingerprintKind("fingerprint_kind"),
  postcode: text("postcode"),
  houseNumber: text("house_number"),
  representativeListingId: uuid("representative_listing_id").references(() => listings.id),
});

export const propertyListings = pgTable(
  "property_listings",
  {
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id),
  },
  (t) => [primaryKey({ columns: [t.propertyId, t.listingId] })],
);

/** Audit trail for dedup so merges can be reviewed and undone. */
export const dedupDecisions = pgTable("dedup_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id")
    .notNull()
    .references(() => listings.id),
  propertyId: uuid("property_id")
    .notNull()
    .references(() => properties.id),
  kind: fingerprintKind("kind").notNull(),
  score: doublePrecision("score"),
  decidedAt: timestamptz("decided_at").notNull().defaultNow(),
  reversedAt: timestamptz("reversed_at"),
});

// ---------------------------------------------------------------------------
// saved_searches
// ---------------------------------------------------------------------------

/** A null filter column means "no constraint on this field". */
export const savedSearches = pgTable("saved_searches", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  cities: text("cities").array(),
  priceTotalMinCents: integer("price_total_min_cents"),
  priceTotalMaxCents: integer("price_total_max_cents"),
  areaSqmMin: integer("area_sqm_min"),
  roomsMin: integer("rooms_min"),
  furnished: furnished("furnished").array(),
  propertyTypes: propertyType("property_types").array(),
  registration: registrationMode("registration").notNull().default("any"),
  telegramChatId: text("telegram_chat_id"),
  workAddress: text("work_address"),
  workLat: doublePrecision("work_lat"),
  workLng: doublePrecision("work_lng"),
  active: boolean("active").notNull().default(true),
});

// ---------------------------------------------------------------------------
// matches and notifications
// ---------------------------------------------------------------------------

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    searchId: uuid("search_id")
      .notNull()
      .references(() => savedSearches.id),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    matchedAt: timestamptz("matched_at").notNull().defaultNow(),
    status: matchStatus("status").notNull().default("new"),
  },
  (t) => [unique("matches_search_property_unique").on(t.searchId, t.propertyId)],
);

/**
 * The idempotency rule lives in this unique constraint (DECISIONS #003).
 * Insert before send; on conflict, skip. All three columns are NOT NULL —
 * a nullable column would let duplicates through, since NULLs never conflict.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    searchId: uuid("search_id")
      .notNull()
      .references(() => savedSearches.id),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    channel: text("channel").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    sentAt: timestamptz("sent_at"),
    error: text("error"),
  },
  (t) => [
    unique("notifications_search_property_channel_unique").on(t.searchId, t.propertyId, t.channel),
  ],
);

// ---------------------------------------------------------------------------
// source_runs — one row per poll
// ---------------------------------------------------------------------------

export const sourceRuns = pgTable("source_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: text("source_id").notNull(),
  startedAt: timestamptz("started_at").notNull().defaultNow(),
  finishedAt: timestamptz("finished_at"),
  listingsSeen: integer("listings_seen"),
  listingsNew: integer("listings_new"),
  error: text("error"),
});
