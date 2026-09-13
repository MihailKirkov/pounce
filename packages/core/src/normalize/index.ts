import type { CanonicalListingInput } from "../listing.js";
import { type GeoPrecision, type LatLng, postcodeCentroid } from "./geo.js";
import { normalizeHouseNumber, normalizePostcode, splitAddress } from "./postcode.js";
import { type PriceBasis, resolvePrice } from "./price.js";
import { canonicalizeUrl } from "./url.js";

export type { GeoPrecision } from "./geo.js";
export type { PriceBasis } from "./price.js";

/**
 * A listing ready to be written to `listings`. Same fields as the adapter
 * input, with `url` replaced by `canonicalUrl` and the derived fields added.
 */
export interface NormalizedListing extends Omit<CanonicalListingInput, "url"> {
  sourceId: string;
  canonicalUrl: string;
  priceBasis?: PriceBasis;
  /** `exact` from the adapter, `postcode` from the PC4 centroid table. */
  geoPrecision?: GeoPrecision;
}

interface Geo extends LatLng {
  geoPrecision: GeoPrecision;
}

/** Trim and collapse whitespace; blank becomes undefined. */
function cleanText(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

function validCoords(lat: number | undefined, lng: number | undefined): LatLng | undefined {
  if (lat === undefined || lng === undefined) return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
}

function resolveGeo(
  lat: number | undefined,
  lng: number | undefined,
  postcode: string | undefined,
): Geo | undefined {
  const exact = validCoords(lat, lng);
  if (exact) return { ...exact, geoPrecision: "exact" };
  const centroid = postcode ? postcodeCentroid(postcode.slice(0, 4)) : undefined;
  if (centroid) return { ...centroid, geoPrecision: "postcode" };
  return undefined;
}

function setDefined<K extends keyof NormalizedListing>(
  target: NormalizedListing,
  key: K,
  value: NormalizedListing[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Pure. Never throws on missing or unparseable optional fields — they stay
 * undefined. Throws only if `input.url` is not an absolute http(s) URL, since
 * `canonical_url` is required and there is no listing without it.
 */
export function normalize(input: CanonicalListingInput, sourceId: string): NormalizedListing {
  const {
    url,
    title,
    street,
    houseNumber,
    postcode,
    city,
    lat,
    lng,
    // Pulled out so a raw price that fails validation can't leak through `facts`.
    priceBaseCents: _rawBase,
    priceTotalCents: _rawTotal,
    agencyName,
    ...facts
  } = input;

  const out: NormalizedListing = { ...facts, sourceId, canonicalUrl: canonicalizeUrl(url) };

  const parsed = facts.addressRaw !== undefined ? splitAddress(facts.addressRaw) : {};
  const pc = postcode !== undefined ? normalizePostcode(postcode) : undefined;
  const geo = resolveGeo(lat, lng, pc);

  setDefined(out, "title", cleanText(title));
  setDefined(out, "street", cleanText(street) ?? parsed.street);
  const adapterHouseNumber =
    houseNumber !== undefined ? normalizeHouseNumber(houseNumber) : undefined;
  setDefined(out, "houseNumber", adapterHouseNumber ?? parsed.houseNumber);
  setDefined(out, "postcode", pc);
  setDefined(out, "city", cleanText(city));
  setDefined(out, "agencyName", cleanText(agencyName));
  Object.assign(out, geo, resolvePrice(input));

  return out;
}
