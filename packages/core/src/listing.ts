/**
 * Canonical listing shape. Mirrors docs/data-model.md.
 *
 * Every field except the identity block is optional. Sources are inconsistent;
 * a missing field must never fail ingestion — it may only fail *matching*.
 */

export type PropertyType = "apartment" | "house" | "studio" | "room";

/** kaal / gestoffeerd / gemeubileerd */
export type Furnishing = "bare" | "upholstered" | "furnished";

export type PriceInclusion =
  | "gas"
  | "water"
  | "electricity"
  | "internet"
  | "service_costs"
  | "municipal_taxes";

/**
 * What an adapter hands to core. Field names match the canonical model, values
 * are *as extracted*: core normalizes postcodes, strips tracking params, resolves
 * base-vs-total pricing and geocodes from postcode when lat/lng are absent.
 *
 * Adapters must only set `registrationAllowed`, `petsAllowed` and
 * `incomeRequirementMultiple` when the source states it explicitly.
 * Unknown is `undefined`, never `false`.
 */
export interface CanonicalListingInput {
  /** Source's own id for this listing. Stable across polls. */
  sourceListingId: string;
  /** Public URL of the listing. Core canonicalizes it. */
  url: string;

  title?: string;
  /** Source's own claim of publication time. Omit if not exposed. */
  publishedAt?: Date;

  addressRaw?: string;
  street?: string;
  houseNumber?: string;
  postcode?: string;
  city?: string;
  lat?: number;
  lng?: number;

  /** kale huur, in cents */
  priceBaseCents?: number;
  /** what you actually pay monthly, in cents. Set this for all-in listings. */
  priceTotalCents?: number;
  priceIncludes?: PriceInclusion[];
  depositCents?: number;

  areaSqm?: number;
  rooms?: number;
  bedrooms?: number;
  propertyType?: PropertyType;
  furnished?: Furnishing;

  availableFrom?: Date;
  minContractMonths?: number;
  registrationAllowed?: boolean;
  petsAllowed?: boolean;
  incomeRequirementMultiple?: number;

  agencyName?: string;
  /** true if bemiddelingskosten (illegal tenant-side agency fee) is mentioned */
  agencyFeeFlagged?: boolean;

  /**
   * Structured leftovers worth keeping for debugging. Never put description
   * text or image URLs here (DECISIONS #004).
   */
  extra?: Record<string, string | number | boolean | null>;
}
