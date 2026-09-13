import type { Furnishing, PropertyType } from "../listing.js";
import type { NormalizedListing } from "../normalize/index.js";

export type RegistrationMode = "required" | "preferred" | "any";

/** `not_stated` lets a search opt in to listings that don't say how they're furnished. */
export type FurnishingFilter = Furnishing | "not_stated";

/**
 * The filter columns of `saved_searches`, as a plain type. `null` means the
 * filter is not set; an empty array means "any".
 */
export interface SavedSearchFilters {
  cities: readonly string[];
  priceTotalMinCents: number | null;
  priceTotalMaxCents: number | null;
  areaSqmMin: number | null;
  roomsMin: number | null;
  propertyTypes: readonly PropertyType[];
  furnished: readonly FurnishingFilter[];
  registration: RegistrationMode;
}

export type MatchField = keyof SavedSearchFilters;

export interface MatchReason {
  field: MatchField;
  passed: boolean;
  /** Human-readable, for the UI and logs. */
  detail: string;
}

export interface MatchResult {
  matched: boolean;
  /** One entry per filter, set or not, always in the same order. */
  reasons: MatchReason[];
}

function reason(field: MatchField, passed: boolean, detail: string): MatchReason {
  return { field, passed, detail };
}

const eur = (cents: number): string => `€${(cents / 100).toFixed(2)}`;
const list = (values: readonly string[]): string => `[${values.join(", ")}]`;

/** Any-of on a single value. Empty `wanted` means any; an unknown value fails a set list. */
function anyOf(
  field: MatchField,
  value: string | undefined,
  wanted: readonly string[],
  noun: string,
): MatchReason {
  if (wanted.length === 0) return reason(field, true, `any ${noun}`);
  if (value === undefined) return reason(field, false, `${noun} unknown, wanted ${list(wanted)}`);
  const ok = wanted.includes(value);
  return reason(field, ok, `${value} ${ok ? "is" : "is not"} in ${list(wanted)}`);
}

function checkCities(l: NormalizedListing, cities: readonly string[]): MatchReason {
  const lower = cities.map((c) => c.trim().toLowerCase());
  return anyOf("cities", l.city?.toLowerCase(), lower, "city");
}

/**
 * Compares the total. A base_only listing is compared on its base and says
 * so: total >= base, so base <= max is the best we know and base >= min is
 * proof. We never guess the service costs.
 */
function checkPrice(
  l: NormalizedListing,
  field: "priceTotalMinCents" | "priceTotalMaxCents",
  bound: number | null,
): MatchReason {
  const isMax = field === "priceTotalMaxCents";
  const label = isMax ? "max" : "min";
  if (bound === null) return reason(field, true, `no ${label}`);

  const within = (v: number): boolean => (isMax ? v <= bound : v >= bound);
  const describe = (v: number): string => {
    const op = within(v) ? (isMax ? "<=" : ">=") : isMax ? ">" : "<";
    return `${eur(v)} ${op} ${label} ${eur(bound)}`;
  };

  if (l.priceTotalCents !== undefined) {
    return reason(field, within(l.priceTotalCents), `total ${describe(l.priceTotalCents)}`);
  }
  if (l.priceBaseCents !== undefined) {
    return reason(
      field,
      within(l.priceBaseCents),
      `base_only, total unknown: base ${describe(l.priceBaseCents)}`,
    );
  }
  return reason(field, false, `price unknown, ${label} ${eur(bound)} set`);
}

function checkMin(
  field: "areaSqmMin" | "roomsMin",
  value: number | undefined,
  min: number | null,
  noun: string,
): MatchReason {
  if (min === null) return reason(field, true, "no min");
  if (value === undefined) return reason(field, false, `${noun} unknown, min ${min} set`);
  const ok = value >= min;
  return reason(field, ok, `${noun} ${value} ${ok ? ">=" : "<"} min ${min}`);
}

/** Unknown is never treated as refused: `preferred` keeps it, only `required` drops it. */
function checkRegistration(l: NormalizedListing, mode: RegistrationMode): MatchReason {
  const v = l.registrationAllowed;
  const known = v === true || v === false;
  const stated = !known ? "unknown" : v ? "allowed" : "not allowed";
  const ok = mode === "any" || v === true || (mode === "preferred" && !known);
  return reason("registration", ok, `${mode}: registration ${stated}`);
}

/** Pure. Evaluates every filter — no short-circuit — so every decision can be explained. */
export function matches(listing: NormalizedListing, search: SavedSearchFilters): MatchResult {
  const reasons = [
    checkCities(listing, search.cities),
    checkPrice(listing, "priceTotalMinCents", search.priceTotalMinCents),
    checkPrice(listing, "priceTotalMaxCents", search.priceTotalMaxCents),
    checkMin("areaSqmMin", listing.areaSqm, search.areaSqmMin, "area"),
    checkMin("roomsMin", listing.rooms, search.roomsMin, "rooms"),
    anyOf("propertyTypes", listing.propertyType, search.propertyTypes, "property type"),
    anyOf("furnished", listing.furnished ?? "not_stated", search.furnished, "furnishing"),
    checkRegistration(listing, search.registration),
  ];
  return { matched: reasons.every((r) => r.passed), reasons };
}
