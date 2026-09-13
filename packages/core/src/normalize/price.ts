import type { CanonicalListingInput } from "../listing.js";

/**
 * - `exact`: the monthly total is known (both amounts given, or an all-in total).
 * - `base_only`: only kale huur is known; the matcher decides how to compare it.
 * - `derived`: reserved for a total computed from base + stated costs. Nothing
 *   produces it yet — we never invent a service-cost estimate.
 */
export type PriceBasis = "exact" | "derived" | "base_only";

export interface ResolvedPrice {
  priceBaseCents?: number;
  priceTotalCents?: number;
  /** Undefined when the listing has no usable price at all. */
  priceBasis?: PriceBasis;
}

function cents(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * `priceIncludes` is accepted but does not change the basis: an adapter that
 * set a total has already told us what is paid monthly.
 */
export function resolvePrice(
  input: Pick<CanonicalListingInput, "priceBaseCents" | "priceTotalCents" | "priceIncludes">,
): ResolvedPrice {
  const base = cents(input.priceBaseCents);
  const total = cents(input.priceTotalCents);

  if (total !== undefined) {
    return base !== undefined
      ? { priceBaseCents: base, priceTotalCents: total, priceBasis: "exact" }
      : { priceTotalCents: total, priceBasis: "exact" };
  }
  if (base !== undefined) {
    return { priceBaseCents: base, priceBasis: "base_only" };
  }
  return {};
}
