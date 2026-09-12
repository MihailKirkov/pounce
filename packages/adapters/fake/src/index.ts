/**
 * Fake adapter. Exists to prove the pipeline end-to-end in session 1 and to
 * serve as the reference implementation of the contract. It reads JSON from
 * a pretend API; a real adapter parses HTML the same way, just with a parser.
 */
import { defineAdapter, type CanonicalListingInput, type Furnishing } from "@pounce/core";

interface FakeRaw {
  id: string;
  url: string;
  title: string;
  street: string;
  nr: string;
  postcode: string;
  city: string;
  lat?: number;
  lng?: number;
  rent: number;
  service?: number;
  allin?: boolean;
  sqm: number;
  rooms: number;
  furnished: string;
  from: string;
  published: string;
  // from detail()
  deposit?: number;
  minMonths?: number;
  registration?: boolean;
  agency?: string;
}

const FURN: Record<string, Furnishing> = {
  kaal: "bare",
  gestoffeerd: "upholstered",
  gemeubileerd: "furnished",
};

export const fakeAdapter = defineAdapter<FakeRaw>({
  id: "fake",
  displayName: "Fake source",
  homepage: "https://fake.example",
  transport: "http",
  polling: {
    intervalSeconds: 60,
    minIntervalSeconds: 30,
    minRequestGapMs: 500,
    backoff: { initialSeconds: 60, maxSeconds: 900, factor: 2 },
  },
  capabilities: {
    coordinates: true,
    publishedAt: true,
    cityFilter: true,
    registrationOnDetail: true,
  },

  async list(scope, ctx) {
    const city = (scope.cities[0] ?? "eindhoven").toLowerCase();
    const res = await ctx.http.get(`https://fake.example/api/list?city=${city}`);
    if (res.status !== 200) throw new Error(`fake list: HTTP ${res.status}`);
    const listings = await res.json<FakeRaw[]>();
    ctx.logger.debug("fake list ok", { count: listings.length });
    return { listings, complete: true, diagnostics: { pages: 1 } };
  },

  async detail(raw, ctx) {
    const res = await ctx.http.get(`https://fake.example/api/listing/${raw.id.replace("fake-", "")}`);
    if (res.status !== 200) return raw;
    const d = await res.json<Partial<FakeRaw>>();
    return { ...raw, ...d };
  },

  toCanonical(raw): CanonicalListingInput {
    const base = raw.rent * 100;
    const out: CanonicalListingInput = {
      sourceListingId: raw.id,
      url: raw.url,
      title: raw.title,
      publishedAt: new Date(raw.published),
      addressRaw: `${raw.street} ${raw.nr}, ${raw.postcode} ${raw.city}`,
      street: raw.street,
      houseNumber: raw.nr,
      postcode: raw.postcode,
      city: raw.city,
      areaSqm: raw.sqm,
      rooms: raw.rooms,
      propertyType: "apartment",
      availableFrom: new Date(raw.from),
    };
    const f = FURN[raw.furnished];
    if (f) out.furnished = f;
    if (raw.lat !== undefined && raw.lng !== undefined) {
      out.lat = raw.lat;
      out.lng = raw.lng;
    }
    if (raw.allin) {
      out.priceTotalCents = base;
      out.priceIncludes = ["gas", "electricity"];
    } else {
      out.priceBaseCents = base;
      if (raw.service !== undefined) {
        out.priceTotalCents = base + raw.service * 100;
        out.priceIncludes = ["service_costs"];
      }
    }
    if (raw.deposit !== undefined) out.depositCents = raw.deposit * 100;
    if (raw.minMonths !== undefined) out.minContractMonths = raw.minMonths;
    if (raw.registration !== undefined) out.registrationAllowed = raw.registration;
    if (raw.agency !== undefined) out.agencyName = raw.agency;
    return out;
  },
});
