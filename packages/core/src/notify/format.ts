import type { PriceInclusion } from "../listing.js";
import type { SavedSearchFilters } from "../match/matcher.js";
import type { NormalizedListing } from "../normalize/index.js";

export interface TelegramFormatOptions {
  /** Reference time for the listing's age. Passed in so formatting stays pure. */
  now: Date;
  /** Straight-line distance to the search's work address. */
  distanceKm?: number;
  /** Source display name, e.g. "Pararius". Falls back to the listing's sourceId. */
  sourceName?: string;
  /** Our first_seen_at, shown as "first seen … ago" when the source gives no publish date. */
  firstSeenAt?: Date;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isValidDate = (d: Date | undefined): d is Date =>
  d !== undefined && !Number.isNaN(d.getTime());

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** `€1,050`, or `€1,050.50` when there are cents. */
function euros(cents: number): string {
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = cents % 100;
  return rest === 0 ? `€${whole}` : `€${whole}.${String(rest).padStart(2, "0")}`;
}

/** `1 Oct`, with the year only when it isn't the current one. Dates are UTC midnight. */
function day(d: Date, now: Date): string {
  const year = d.getUTCFullYear() === now.getUTCFullYear() ? "" : ` ${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""}${year}`;
}

/** Largest whole unit: `40 s`, `3 min`, `1 h`, `2 d`. A future time counts as 0 s. */
function age(from: Date, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** Joins the parts that are present; undefined when none are. */
function line(parts: readonly (string | undefined)[], sep: string): string | undefined {
  const present = parts.filter((p): p is string => p !== undefined && p !== "");
  return present.length > 0 ? present.join(sep) : undefined;
}

function heading(l: NormalizedListing): string | undefined {
  const street = l.street !== undefined ? line([l.street, l.houseNumber], " ") : l.title;
  return line([street, l.city], ", ");
}

function locationLine(l: NormalizedListing, distanceKm: number | undefined): string | undefined {
  const postcode = l.postcode?.replace(/^(\d{4})([A-Z]{2})$/, "$1 $2");
  const distance =
    distanceKm !== undefined && Number.isFinite(distanceKm)
      ? `${distanceKm.toFixed(1)} km to work`
      : undefined;
  return line([postcode, distance], " · ");
}

/** Display order and wording for inclusions; the source's order is not kept. */
const INCLUSION_LABELS: Readonly<Record<PriceInclusion, string>> = {
  gas: "gas",
  water: "water",
  electricity: "electricity",
  internet: "internet",
  service_costs: "service costs",
  municipal_taxes: "municipal taxes",
};

/** `gas + electricity`, deduplicated, in INCLUSION_LABELS order; undefined when empty. */
function inclusions(includes: readonly PriceInclusion[] | undefined): string | undefined {
  const stated = new Set<string>(includes);
  const labels = Object.entries(INCLUSION_LABELS)
    .filter(([key]) => stated.has(key))
    .map(([, label]) => label);
  return labels.length > 0 ? labels.join(" + ") : undefined;
}

/**
 * - base and total known: the total with its base + service breakdown
 * - total only, inclusions listed: all-in, naming what's included
 * - total only, nothing listed: just the total
 * - base only: says the total is unknown; service costs are never guessed
 */
function priceLine(l: NormalizedListing): string | undefined {
  const { priceBaseCents: base, priceTotalCents: total } = l;
  if (total !== undefined) {
    if (base !== undefined && base < total) {
      return `${euros(total)} total  (${euros(base)} + ${euros(total - base)} service)`;
    }
    const included = base === undefined ? inclusions(l.priceIncludes) : undefined;
    return included !== undefined
      ? `${euros(total)} all-in  (${included} included)`
      : `${euros(total)} total`;
  }
  if (base !== undefined) return `${euros(base)} base, total unknown`;
  return undefined;
}

function sizeLine(l: NormalizedListing): string | undefined {
  return line(
    [
      l.areaSqm !== undefined ? `${l.areaSqm} m²` : undefined,
      l.rooms !== undefined ? plural(l.rooms, "room") : undefined,
      l.furnished,
    ],
    " · ",
  );
}

function availabilityLine(l: NormalizedListing, now: Date): string | undefined {
  return line(
    [
      isValidDate(l.availableFrom) ? `From ${day(l.availableFrom, now)}` : undefined,
      l.minContractMonths !== undefined ? `min ${plural(l.minContractMonths, "month")}` : undefined,
    ],
    " · ",
  );
}

/**
 * The exception to omit-when-missing: an unknown registration or income is
 * printed as "not stated", because that is what tells the reader to ask.
 */
function qualificationLine(l: NormalizedListing): string {
  const registration =
    l.registrationAllowed === undefined
      ? "Registration: not stated"
      : `Registration ${l.registrationAllowed ? "✓" : "✗"}`;
  const income =
    l.incomeRequirementMultiple === undefined
      ? "Income: not stated"
      : `Income: ${l.incomeRequirementMultiple}× rent`;
  return `${registration}   ${income}`;
}

function sourceLine(l: NormalizedListing, opts: TelegramFormatOptions): string {
  const name = opts.sourceName ?? l.sourceId;
  if (isValidDate(l.publishedAt)) return `${name} · published ${age(l.publishedAt, opts.now)} ago`;
  if (isValidDate(opts.firstSeenAt)) {
    return `${name} · first seen ${age(opts.firstSeenAt, opts.now)} ago`;
  }
  return name;
}

/**
 * Plain-text Telegram alert: facts and the link, never description text or
 * images (DECISIONS #004, #007). A line whose data is missing is left out
 * rather than printed as "unknown" — except registration and income, which say
 * "not stated". Pure.
 *
 * `search` is unused until a user income is configurable; the income line
 * then compares against it instead of only stating the requirement.
 */
export function formatTelegram(
  listing: NormalizedListing,
  search: SavedSearchFilters,
  opts: TelegramFormatOptions,
): string {
  const blocks = [
    [heading(listing), locationLine(listing, opts.distanceKm)],
    [
      priceLine(listing),
      sizeLine(listing),
      availabilityLine(listing, opts.now),
      qualificationLine(listing),
    ],
    [sourceLine(listing, opts), listing.canonicalUrl],
  ];
  return blocks
    .map((lines) => line(lines, "\n"))
    .filter((block): block is string => block !== undefined)
    .join("\n\n");
}
