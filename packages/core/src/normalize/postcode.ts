const POSTCODE = /^([1-9][0-9]{3})\s*([a-zA-Z]{2})$/;

/**
 * NL postcode as `1234AB` (no space, uppercase), or undefined if `raw` is not
 * 4 digits (no leading zero) followed by 2 letters.
 */
export function normalizePostcode(raw: string): string | undefined {
  const m = POSTCODE.exec(raw.trim());
  if (!m) return undefined;
  return `${m[1]}${m[2]?.toUpperCase()}`;
}

/**
 * House number with whitespace collapsed and suffix letters uppercased
 * (`208a` -> `208A`), so the dedup address fingerprint doesn't depend on
 * how a source spells it. Undefined when blank.
 */
export function normalizeHouseNumber(raw: string): string | undefined {
  const nr = raw.replace(/\s+/g, " ").trim().toUpperCase();
  return nr === "" ? undefined : nr;
}

/**
 * Trailing house number group: digits plus an optional suffix — attached
 * letters (`12a`, `208A`, `12bis`), a dash part (`12-2`, `12-hs`) or a spaced
 * `bis`/`ter`/single letter (`12 bis`, `12 A`). The street is everything
 * before it, so digits inside the street (`Straat 2e Hoek 14`) stay there.
 */
const STREET_AND_NUMBER = /^(.*\S)\s+(\d+(?:[a-zA-Z]{1,4}|-[a-zA-Z0-9]+|\s(?:bis|ter|[a-zA-Z]))?)$/;

export interface AddressParts {
  street?: string;
  houseNumber?: string;
}

/**
 * Split a source's address line into street and house number. Only the part
 * before the first comma is considered (`Kruisstraat 112, 5612 CJ Eindhoven`).
 * Returns `{}` unless both a street and a trailing house number are found.
 */
export function splitAddress(addressRaw: string): AddressParts {
  const line = (addressRaw.split(",", 1)[0] ?? "").replace(/\s+/g, " ").trim();
  const m = STREET_AND_NUMBER.exec(line);
  const houseNumber = m?.[2] !== undefined ? normalizeHouseNumber(m[2]) : undefined;
  if (!m?.[1] || !houseNumber) return {};
  return { street: m[1], houseNumber };
}
