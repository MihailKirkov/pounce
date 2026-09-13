/**
 * Database rows → core's plain types. Postgres null becomes an absent key, since
 * core types are optional-not-undefined (exactOptionalPropertyTypes).
 */
import type { NormalizedListing, PriceInclusion, SavedSearchFilters } from "@pounce/core";
import type { listings, savedSearches } from "@pounce/db";

type ListingRow = typeof listings.$inferSelect;
type SavedSearchRow = typeof savedSearches.$inferSelect;

/** `{ key: value }`, or `{}` when value is null. */
function present<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  return value === null ? {} : ({ [key]: value } as { [P in K]: V });
}

/** numeric comes back from postgres-js as a string. */
function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const PRICE_INCLUSIONS = {
  gas: true,
  water: true,
  electricity: true,
  internet: true,
  service_costs: true,
  municipal_taxes: true,
} satisfies Record<PriceInclusion, true>;

const isPriceInclusion = (value: string): value is PriceInclusion =>
  Object.hasOwn(PRICE_INCLUSIONS, value);

/** price_includes is text[]; a value core doesn't know is dropped, not passed on. */
function toInclusions(values: string[] | null): PriceInclusion[] | null {
  return values === null ? null : values.filter(isPriceInclusion);
}

/** Omits raw_payload: nothing downstream of ingestion reads it yet. */
export function listingFromRow(r: ListingRow): NormalizedListing {
  return {
    sourceId: r.sourceId,
    sourceListingId: r.sourceListingId,
    canonicalUrl: r.canonicalUrl,
    ...present("publishedAt", r.publishedAt),
    ...present("title", r.title),
    ...present("addressRaw", r.addressRaw),
    ...present("street", r.street),
    ...present("houseNumber", r.houseNumber),
    ...present("postcode", r.postcode),
    ...present("city", r.city),
    ...present("lat", r.lat),
    ...present("lng", r.lng),
    ...present("geoPrecision", r.geoPrecision),
    ...present("priceBaseCents", r.priceBaseCents),
    ...present("priceTotalCents", r.priceTotalCents),
    ...present("priceIncludes", toInclusions(r.priceIncludes)),
    ...present("depositCents", r.depositCents),
    ...present("areaSqm", r.areaSqm),
    ...present("rooms", r.rooms),
    ...present("bedrooms", r.bedrooms),
    ...present("propertyType", r.propertyType),
    // `not_stated` is a search filter value; on a listing, unstated is null.
    ...present("furnished", r.furnished === "not_stated" ? null : r.furnished),
    ...present("availableFrom", r.availableFrom),
    ...present("minContractMonths", r.minContractMonths),
    ...present("registrationAllowed", r.registrationAllowed),
    ...present("petsAllowed", r.petsAllowed),
    ...present("incomeRequirementMultiple", toNumber(r.incomeRequirementMultiple)),
    ...present("agencyName", r.agencyName),
    ...present("agencyFeeFlagged", r.agencyFeeFlagged),
  };
}

/** A null array filter is "any", same as empty. */
export function searchFromRow(r: SavedSearchRow): SavedSearchFilters {
  return {
    cities: r.cities ?? [],
    priceTotalMinCents: r.priceTotalMinCents,
    priceTotalMaxCents: r.priceTotalMaxCents,
    areaSqmMin: r.areaSqmMin,
    roomsMin: r.roomsMin,
    propertyTypes: r.propertyTypes ?? [],
    furnished: r.furnished ?? [],
    registration: r.registration,
  };
}
