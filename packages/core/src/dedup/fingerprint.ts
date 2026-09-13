import type { NormalizedListing } from "../normalize/index.js";

/** Mirrors the `fingerprint_kind` enum. */
export type FingerprintKind = "url" | "address" | "fuzzy";

export interface FuzzyKey {
  postcode: string;
  priceTotalCents: number;
  areaSqm: number;
  rooms: number;
}

export interface Fingerprints {
  url: string;
  address?: string;
  fuzzy?: FuzzyKey;
}

export interface DedupMatch {
  kind: FingerprintKind;
  /** 1 for url and address; 0–1 for fuzzy, from how close price and area are. */
  score: number;
}

/** Layer 3 tolerances, as a percentage of the larger of the two values. */
const PRICE_TOLERANCE_PCT = 5;
const AREA_TOLERANCE_PCT = 10;

export function fingerprints(l: NormalizedListing): Fingerprints {
  const out: Fingerprints = { url: l.canonicalUrl };
  if (l.postcode && l.houseNumber) {
    out.address = `${l.postcode}|${l.houseNumber}`;
  }
  const { postcode, priceTotalCents, areaSqm, rooms } = l;
  if (postcode && priceTotalCents !== undefined && areaSqm !== undefined && rooms !== undefined) {
    out.fuzzy = { postcode, priceTotalCents, areaSqm, rooms };
  }
  return out;
}

/**
 * 1 when equal, falling linearly to 0 at the tolerance edge, undefined beyond
 * it. Relative to the larger value, so argument order doesn't matter. The
 * bound check cross-multiplies so exactly 5% / 10% is inside, not float noise.
 */
function closeness(a: number, b: number, tolerancePct: number): number | undefined {
  const diff = Math.abs(a - b) * 100;
  const limit = tolerancePct * Math.max(a, b);
  if (diff > limit) return undefined;
  return limit === 0 ? 1 : 1 - diff / limit;
}

function fuzzyScore(a: FuzzyKey, b: FuzzyKey): number | undefined {
  if (a.postcode !== b.postcode || a.rooms !== b.rooms) return undefined;
  const price = closeness(a.priceTotalCents, b.priceTotalCents, PRICE_TOLERANCE_PCT);
  const area = closeness(a.areaSqm, b.areaSqm, AREA_TOLERANCE_PCT);
  if (price === undefined || area === undefined) return undefined;
  return (price + area) / 2;
}

/**
 * Both house numbers known and different means two units, however alike they
 * look — identical flats in one building must not fuzzy-merge.
 */
function differentKnownUnits(a: NormalizedListing, b: NormalizedListing): boolean {
  return Boolean(a.houseNumber && b.houseNumber && a.houseNumber !== b.houseNumber);
}

/**
 * First fingerprint layer on which `candidate` and `existing` are the same
 * property, or undefined. Pure; the caller supplies the candidates.
 */
export function matchLayer(
  candidate: NormalizedListing,
  existing: NormalizedListing,
): DedupMatch | undefined {
  const c = fingerprints(candidate);
  const e = fingerprints(existing);

  if (c.url === e.url) return { kind: "url", score: 1 };
  if (c.address !== undefined && c.address === e.address) return { kind: "address", score: 1 };
  if (c.fuzzy && e.fuzzy && !differentKnownUnits(candidate, existing)) {
    const score = fuzzyScore(c.fuzzy, e.fuzzy);
    if (score !== undefined) return { kind: "fuzzy", score };
  }
  return undefined;
}

export interface DedupCandidate {
  listing: NormalizedListing;
  propertyId: string;
}

export interface DedupHit {
  match: DedupMatch;
  propertyId: string;
}

/** Lower is stronger: the layer order of docs/data-model.md. */
const LAYER_RANK: Readonly<Record<FingerprintKind, number>> = { url: 0, address: 1, fuzzy: 2 };

function stronger(a: DedupMatch, b: DedupMatch): boolean {
  const byLayer = LAYER_RANK[a.kind] - LAYER_RANK[b.kind];
  return byLayer !== 0 ? byLayer < 0 : a.score > b.score;
}

/**
 * The property `candidate` belongs to, or undefined for a new one. Across all
 * existing listings the strongest layer wins, then the higher score; on a tie
 * the earlier candidate. Pure; the caller chooses which listings to compare.
 */
export function bestMatch(
  candidate: NormalizedListing,
  existing: readonly DedupCandidate[],
): DedupHit | undefined {
  let best: DedupHit | undefined;
  for (const { listing, propertyId } of existing) {
    const match = matchLayer(candidate, listing);
    if (match && (!best || stronger(match, best.match))) best = { match, propertyId };
  }
  return best;
}

/**
 * `properties.fingerprint_kind` for a property founded by this listing: the
 * identity it can be found by from another source. Address when it has one;
 * otherwise only its URL identifies it — fuzzy is a tolerance, not an identity.
 */
export function newPropertyKind(listing: NormalizedListing): FingerprintKind {
  return fingerprints(listing).address !== undefined ? "address" : "url";
}
