import { z } from "zod";

/**
 * Audience targeting by country (and the other facets the API forwards) for
 * Facebook Page posts and LinkedIn Company Page posts.
 *
 * Facebook: the API takes `facebook_targeting` / `facebook_feed_targeting` as
 * Meta's own Graph objects (`targeting` / `feed_targeting`). Agents asked for
 * "only UK and US" should not have to know Graph's shape, so a
 * `{ countries: ["GB", "US"] }` shortcut is turned into
 * `{ geo_locations: { countries: [...] } }` here, before the SDK sends it.
 *
 * LinkedIn: `linkedin_target_*` facets (URN lists) build the post's
 * `distribution.targetEntities`. They go to the API as given.
 *
 * YouTube has no country targeting through its API (allowedCountries is not
 * saved), so there is nothing for it here.
 */

/** Common aliases agents write instead of the ISO 3166-1 alpha-2 code. */
const COUNTRY_ALIASES: Record<string, string> = { UK: "GB", EL: "GR" };

function normalizeCountries(field: string, value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [value];
  const codes: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      throw new Error(`\`${field}\`.countries must be a list of ISO 3166-1 alpha-2 country codes, e.g. ["GB", "US"].`);
    }
    const trimmed = item.trim().toUpperCase();
    if (!trimmed) continue;
    const code = COUNTRY_ALIASES[trimmed] ?? trimmed;
    if (!/^[A-Z]{2}$/.test(code)) {
      throw new Error(
        `\`${field}\`.countries takes ISO 3166-1 alpha-2 country codes such as "GB" or "US" (got "${item}").`
      );
    }
    if (!codes.includes(code)) codes.push(code);
  }
  if (codes.length === 0) {
    throw new Error(`\`${field}\`.countries is empty: pass at least one country code, e.g. ["GB", "US"].`);
  }
  return codes;
}

/**
 * Turn the `countries` shortcut into Graph's `geo_locations.countries`; any
 * other key (raw Graph targeting) is kept untouched. A JSON string is parsed.
 */
export function normalizeFacebookTargeting(field: string, value: unknown): unknown {
  if (value === undefined || value === null || value === "") return value;
  let obj = value;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      throw new Error(`\`${field}\` must be an object such as { countries: ["GB", "US"] } or Meta's targeting JSON.`);
    }
  }
  if (Array.isArray(obj)) {
    // A bare list of codes: the countries shortcut without its key.
    obj = { countries: obj };
  }
  if (!obj || typeof obj !== "object") {
    throw new Error(`\`${field}\` must be an object such as { countries: ["GB", "US"] } or Meta's targeting JSON.`);
  }
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  if (out.countries !== undefined) {
    const countries = normalizeCountries(field, out.countries);
    delete out.countries;
    const geo = out.geo_locations;
    if (geo !== undefined && (typeof geo !== "object" || geo === null || Array.isArray(geo))) {
      throw new Error(`\`${field}\`.geo_locations must be an object.`);
    }
    const geoObj = { ...((geo as Record<string, unknown> | undefined) ?? {}) };
    const existing = Array.isArray(geoObj.countries) ? (geoObj.countries as unknown[]) : [];
    geoObj.countries = [...new Set([...existing.map((c) => String(c).toUpperCase()), ...countries])];
    out.geo_locations = geoObj;
  }
  return out;
}

const FACEBOOK_KEYS: Array<[string, string]> = [
  ["facebookTargeting", "facebook_targeting"],
  ["facebookFeedTargeting", "facebook_feed_targeting"],
];

/** Normalize both spellings of the Facebook targeting options in place. */
export function normalizeTargetingOptions(opts: Record<string, unknown>): void {
  for (const [camel, snake] of FACEBOOK_KEYS) {
    for (const key of [camel, snake]) {
      if (opts[key] !== undefined) opts[key] = normalizeFacebookTargeting(key, opts[key]);
    }
  }
}

const COUNTRIES_SHORTCUT =
  'Shortcut: { countries: ["GB", "US"] } with ISO 3166-1 alpha-2 codes (the United Kingdom is GB; "UK" is accepted and sent as GB), sent to Meta as { geo_locations: { countries: [...] } }. Any other key is passed to Meta as is (Graph targeting: geo_locations with countries / regions / cities, locales, age_min, age_max, genders…).';

const FacebookTargetingValue = z
  .object({
    countries: z
      .array(z.string())
      .optional()
      .describe('ISO 3166-1 alpha-2 country codes, e.g. ["GB", "US"].'),
  })
  .passthrough();

export const FACEBOOK_TARGETING: Record<string, z.ZodTypeAny> = {
  facebookTargeting: FacebookTargetingValue.optional().describe(
    "Facebook Page post audience RESTRICTION (Graph `targeting`): only people who match can see the post. Use it when the user says the post is only for some countries, e.g. \"only for UK and US\" → { countries: [\"GB\", \"US\"] }. " +
      COUNTRIES_SHORTCUT +
      " Applies to Page photos (not Stories), Page videos, Reels and text posts."
  ),
  facebookFeedTargeting: FacebookTargetingValue.optional().describe(
    "Facebook Page post feed PREFERENCE (Graph `feed_targeting`): the post is shown more to people who match, but anyone can still see it. Use it for \"mainly for\" / \"prioritise\" wording; use facebookTargeting to really limit who sees it. " +
      COUNTRIES_SHORTCUT +
      " Same placements as facebookTargeting."
  ),
};

const urnList = (what: string, prefix: string) =>
  z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe(`LinkedIn targeting by ${what}: ${prefix}<id> URNs, as a list or comma-separated. A bare numeric id gets the ${prefix} prefix added.`);

const LINKEDIN_PAGE_ONLY =
  "LinkedIn Company Page posts only (set targetLinkedinPageId; a personal profile is refused). LinkedIn requires the targeted audience to be at least 300 of the Page's followers.";

export const LINKEDIN_TARGETING: Record<string, z.ZodTypeAny> = {
  linkedinTargetGeoLocations: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe(
      "LinkedIn: show the Page post only to followers in these places, as urn:li:geo:<id> URNs (list or comma-separated), e.g. [\"urn:li:geo:103644278\"] (United States) and \"urn:li:geo:101165590\" (United Kingdom). Use it when the user says the LinkedIn post is only for some countries. LinkedIn geo ids are not ISO codes: if you do not know the id of a place, ask the user for it instead of guessing. " +
        LINKEDIN_PAGE_ONLY
    ),
  linkedinTargetIndustries: urnList("industry", "urn:li:industry:"),
  linkedinTargetSeniorities: urnList("seniority", "urn:li:seniority:"),
  linkedinTargetJobFunctions: urnList("job function", "urn:li:function:"),
  linkedinTargetDegrees: urnList("degree", "urn:li:degree:"),
  linkedinTargetFieldsOfStudy: urnList("field of study", "urn:li:fieldOfStudy:"),
  linkedinTargetOrganizations: urnList("school (LinkedIn's `organizations` facet holds schools: the school Page)", "urn:li:organization:"),
  linkedinTargetStaffCountRanges: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe(
      "LinkedIn targeting by company size of the follower's employer: SIZE_1, SIZE_2_TO_10, SIZE_11_TO_50, SIZE_51_TO_200, SIZE_201_TO_500, SIZE_501_TO_1000, SIZE_1001_TO_5000, SIZE_5001_TO_10000, SIZE_10001_OR_MORE."
    ),
  linkedinTargetInterfaceLocales: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe('LinkedIn targeting by interface language, as locales like ["en_US", "es_ES"]. This is the language of LinkedIn\'s interface, not a country filter.'),
  linkedinTargetEntities: z
    .union([z.record(z.unknown()), z.string()])
    .optional()
    .describe(
      "LinkedIn raw targetEntities object (geoLocations, industries, seniorities, jobFunctions, degrees, fieldsOfStudy, organizations, staffCountRanges, interfaceLocales). The linkedinTarget* keys are merged on top. Only for facets the other keys do not cover."
    ),
  linkedinTargetCheckAudience: z
    .boolean()
    .optional()
    .describe(
      "LinkedIn: ask LinkedIn for the audience size first and refuse the post when the targeting reaches fewer than 300 followers, instead of letting LinkedIn reject it."
    ),
};
