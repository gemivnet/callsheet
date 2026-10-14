import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, INFO, WARN } from '../test-icons.js';
import { retry, HttpError } from '../retry.js';

const AWC_API = 'https://aviationweather.gov/api/data';

// Fetch deadline for individual endpoint calls. The whole connector is also
// wrapped by core.ts's per-connector deadline, but a single slow product
// shouldn't drag down the rest of the briefing.
const ENDPOINT_TIMEOUT_MS = 30_000;

// PIREP search radius (statute miles, the API's unit) and age window in hours.
const DEFAULT_PIREP_RADIUS = 100;
const DEFAULT_PIREP_AGE_HOURS = 2;

// Cap the AFD payload to keep the prompt small. The full discussion is
// usually 1-3kB; we want the leading paragraphs which contain the aviation
// concerns. Anything beyond is rarely actionable for a student pilot.
const AFD_MAX_CHARS = 2500;

// Hazard polygons within this many nautical miles of any user station are
// considered "near route" and surfaced. Anything farther is dropped.
const HAZARD_PROXIMITY_NM = 100;

// G-AIRMET products to fetch. SIERRA = IFR/MTN OBSC, TANGO = TURB,
// ZULU = ICE+freezing-level. All three are relevant to a student pilot.
const GAIRMET_TYPES = ['sierra', 'tango', 'zulu'] as const;

interface TafForecast {
  station: string;
  raw: string;
  periods: TafPeriod[];
}

interface TafPeriod {
  from: string;
  to: string;
  type: 'base' | 'from' | 'tempo' | 'becmg' | 'prob';
  windDir?: number | string;
  windSpeedKt?: number;
  windGustKt?: number;
  visibilityMi?: number;
  /** Lowest broken/overcast base (ft AGL); null when there is no ceiling. */
  ceiling?: number | null;
  flightCategory?: FlightCategory;
  /** Which elements the category rests on. Never VFR unless both are known. */
  categoryBasis?: CategoryBasis;
  /** Low-level wind shear, e.g. "2000 ft 270° 45 kt". */
  windShear?: string;
  weather?: string;
  raw: string;
}

export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR';
export type CategoryBasis = 'ceiling+visibility' | 'visibility only' | 'ceiling only';

/**
 * Visibility in statute miles from an aviationweather.gov value.
 *
 * The API sends numbers for some reports and strings for others: "10+" and
 * "6+" (more than), fractions like "1/2" or "1 1/2", and "M1/4" (less than).
 * Reading these with a plain cast is how every visibility silently became
 * undefined.
 */
export function parseVisibility(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v
    .trim()
    .toUpperCase()
    .replace(/SM$/, '')
    .replace(/^[PM]/, '')
    .replace(/\+$/, '')
    .trim();
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(s);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  return Number(s);
}

/**
 * Ceiling in feet AGL: the lowest broken or overcast layer, or a vertical
 * visibility. Returns null when the sky has no ceiling (clear, few,
 * scattered) and undefined when the report says nothing about clouds.
 *
 * The API has no ceiling field. The connector used to read `ceil`, which does
 * not exist, so every TAF was classified on visibility alone — a 400 ft
 * overcast with good visibility came out as VFR.
 */
export function ceilingFrom(clouds: unknown, vertVis?: unknown): number | null | undefined {
  if (typeof vertVis === 'number' && Number.isFinite(vertVis)) return vertVis;
  if (!Array.isArray(clouds)) return undefined;
  let lowest: number | null = null;
  for (const layer of clouds as { cover?: unknown; base?: unknown }[]) {
    const cover = typeof layer?.cover === 'string' ? layer.cover.toUpperCase() : '';
    if (cover !== 'BKN' && cover !== 'OVC' && cover !== 'OVX' && cover !== 'VV') continue;
    if (typeof layer.base === 'number' && (lowest === null || layer.base < lowest)) {
      lowest = layer.base;
    }
  }
  return lowest;
}

/**
 * FAA flight category from ceiling and visibility.
 *
 *   LIFR  ceiling < 500 ft   or visibility < 1 SM
 *   IFR   ceiling < 1,000 ft or visibility < 3 SM
 *   MVFR  ceiling ≤ 3,000 ft or visibility ≤ 5 SM
 *   VFR   otherwise
 *
 * The previous thresholds were each one category too lenient (MVFR started
 * below 1,000 ft). An element that is unknown never counts as good weather:
 * the result is VFR only when both ceiling and visibility are known.
 */
export function flightCategory(
  ceilingFt: number | null | undefined,
  visMi: number | undefined,
): { category?: FlightCategory; basis?: CategoryBasis } {
  const ceilingKnown = ceilingFt !== undefined;
  const visKnown = visMi !== undefined;
  if (!ceilingKnown && !visKnown) return {};
  const ceil = ceilingFt ?? Infinity;
  const vis = visMi ?? Infinity;

  let category: FlightCategory;
  if (ceil < 500 || vis < 1) category = 'LIFR';
  else if (ceil < 1000 || vis < 3) category = 'IFR';
  else if (ceil <= 3000 || vis <= 5) category = 'MVFR';
  else category = 'VFR';

  const basis: CategoryBasis =
    ceilingKnown && visKnown ? 'ceiling+visibility' : visKnown ? 'visibility only' : 'ceiling only';
  if (category === 'VFR' && basis !== 'ceiling+visibility') return { basis };
  return { category, basis };
}

/** "2000 ft 270° 45 kt" from a TAF period's wind-shear fields. */
function describeWindShear(f: Record<string, unknown>): string | undefined {
  const hgt = f.wshearHgt;
  const dir = f.wshearDir;
  const spd = f.wshearSpd;
  if (typeof hgt !== 'number' || typeof spd !== 'number') return undefined;
  // The API reports the height in hundreds of feet, as coded in the TAF (WS020).
  const feet = hgt < 100 ? hgt * 100 : hgt;
  return `${feet} ft ${typeof dir === 'number' ? `${dir}° ` : ''}${spd} kt`;
}

interface StationInfo {
  icaoId: string;
  site: string;
  lat: number;
  lon: number;
  /** Elevation in feet (converted from the API's meters). */
  elevFt: number;
}

interface PirepReport {
  station: string;
  obsTime: string;
  acType?: string;
  lat: number;
  lon: number;
  altitudeFt?: number;
  cloudsRaw?: string;
  weather?: string;
  turbulence?: string;
  icing?: string;
  raw: string;
}

interface HazardPolygonReport {
  type: 'SIGMET' | 'AIRMET' | 'G-AIRMET' | 'CWA';
  hazard: string;
  product?: string;
  validFrom?: string;
  validTo?: string;
  /**
   * For G-AIRMETs, the API returns one entry per forecast hour (0/3/6/9/12).
   * We collapse those into a single report and list the hours covered here so
   * Claude can see "this hazard is active now and through +6h" without
   * choking on 5 near-duplicate entries.
   */
  forecastHours?: number[];
  altitudeLowFt?: number;
  altitudeHighFt?: number;
  severity?: number;
  reason?: string;
  /** Stations whose location intersects (or is within proximity of) this hazard. */
  affectedStations: string[];
  raw?: string;
}

interface DensityAltitudeReport {
  station: string;
  fieldElevFt: number;
  oatC: number;
  altimeterInHg: number;
  pressureAltFt: number;
  densityAltFt: number;
  /** Density altitude minus field elevation. >1500 ft = "hot and high" warning. */
  daAboveFieldFt: number;
}

/**
 * Parse the aviationweather.gov JSON TAF response into structured periods.
 * The API returns TAF objects with a `fcsts` array of forecast periods.
 */
export function parseTafPeriods(taf: Record<string, unknown>): TafPeriod[] {
  const fcsts = taf.fcsts as Record<string, unknown>[] | undefined;
  if (!fcsts?.length) return [];

  // TEMPO, PROB and BECMG groups list only the elements that change. Anything
  // they leave out continues from the prevailing (initial or FM) conditions,
  // so carry those forward rather than judging a group on half its weather.
  let prevailingVis: number | undefined;
  let prevailingCeil: number | null | undefined;

  return fcsts.map((f) => {
    const changeType = (f.fcstChange as string | null | undefined) ?? '';
    const isTemporary = /^(TEMPO|PROB|BECMG)/.test(changeType);

    let vis = parseVisibility(f.visib);
    let ceil = ceilingFrom(f.clouds, f.vertVis);
    if (isTemporary) {
      vis ??= prevailingVis;
      if (ceil === undefined) ceil = prevailingCeil;
    } else {
      prevailingVis = vis ?? prevailingVis;
      prevailingCeil = ceil === undefined ? prevailingCeil : ceil;
    }
    const cat = flightCategory(ceil, vis);

    // Format times as readable strings
    const timeFrom = f.timeFrom as number | undefined;
    const timeTo = f.timeTo as number | undefined;
    const fromStr = timeFrom
      ? new Date(timeFrom * 1000).toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      : '';
    const toStr = timeTo
      ? new Date(timeTo * 1000).toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      : '';

    // Determine period type
    let type: TafPeriod['type'] = 'from';
    if (changeType.startsWith('TEMPO')) type = 'tempo';
    else if (changeType.startsWith('BECMG')) type = 'becmg';
    else if (changeType.startsWith('PROB')) type = 'prob';

    // Collect weather phenomena
    const wxString = (f.wxString as string | null | undefined) ?? '';

    return {
      from: fromStr,
      to: toStr,
      type,
      windDir: f.wdir as number | string | undefined,
      windSpeedKt: f.wspd as number | undefined,
      windGustKt: f.wgst as number | undefined,
      visibilityMi: vis,
      ceiling: ceil,
      flightCategory: cat.category,
      categoryBasis: cat.basis,
      windShear: describeWindShear(f),
      weather: wxString || undefined,
      raw: (f.raw as string | undefined) ?? '',
    };
  });
}

/** Rank of a flight category, worst first; unknown sorts after VFR. */
const CATEGORY_RANK: Record<FlightCategory, number> = { LIFR: 0, IFR: 1, MVFR: 2, VFR: 3 };

/**
 * The worst forecast category across a TAF's periods, or "unknown" when no
 * period could be classified. The old summary started from "VFR" and treated
 * anything unclassified as VFR, so a TAF it could not read reported clear
 * skies.
 */
export function worstCategory(periods: { flightCategory?: FlightCategory }[]): string {
  let worst: FlightCategory | undefined;
  for (const p of periods) {
    if (!p.flightCategory) continue;
    if (!worst || CATEGORY_RANK[p.flightCategory] < CATEGORY_RANK[worst]) worst = p.flightCategory;
  }
  return worst ?? 'unknown';
}

/**
 * The station to anchor the PIREP search on. The endpoint needs a location it
 * can resolve; an FAA-only identifier (three characters, or a digit-bearing
 * field code) is rejected with HTTP 400 "Invalid location specified", so the
 * first four-letter ICAO identifier is used instead.
 */
export function pirepAnchor(stations: string[]): string | undefined {
  return stations.find((s) => /^[A-Z]{4}$/.test(s)) ?? stations[0];
}

/** How many retry attempts AWC endpoints get — the site 502s during heavy updates. */
const AWC_RETRIES = 3;
/** Base backoff for AWC retries. Keep snappy; AWC outages are usually seconds. */
const AWC_BASE_DELAY_MS = 400;

function awcOnRetry(label: string): (attempt: number, err: unknown, delayMs: number) => void {
  return (attempt, err, delayMs) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `  aviation_weather: ${label} attempt ${attempt} failed (${msg}), retrying in ${delayMs}ms...`,
    );
  };
}

/**
 * Fetch JSON from an aviationweather.gov endpoint with a deadline and
 * retry-with-backoff. Returns null on persistent error so a single bad
 * endpoint can't crash the whole connector.
 *
 * AWC returns 200 with an empty body when a product has no reports for the
 * requested window (common for PIREPs and CWAs on quiet days). That's a
 * valid nothing-to-report response, not a failure — treat it as null
 * silently. Real errors are still logged for diagnosis.
 */
async function safeFetchJson<T>(
  url: string,
  label: string,
  failures?: string[],
): Promise<T | null> {
  try {
    const body = await retry(
      async () => {
        const r = await fetch(url, { signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS) });
        if (!r.ok) {
          throw new HttpError(r.status, `${label} returned ${r.status}`, url);
        }
        return (await r.text()).trim();
      },
      {
        retries: AWC_RETRIES,
        baseDelayMs: AWC_BASE_DELAY_MS,
        onRetry: awcOnRetry(label),
      },
    );
    if (!body) return null;
    try {
      return JSON.parse(body) as T;
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      console.log(`  aviation_weather: ${label} returned unparseable JSON: ${msg}`);
      failures?.push(`${label}: unparseable response`);
      return null;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  aviation_weather: ${label} failed after retries: ${msg}`);
    failures?.push(`${label}: ${msg}`);
    return null;
  }
}

async function safeFetchText(
  url: string,
  label: string,
  failures?: string[],
): Promise<string | null> {
  try {
    return await retry(
      async () => {
        const r = await fetch(url, { signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS) });
        if (!r.ok) {
          throw new HttpError(r.status, `${label} returned ${r.status}`, url);
        }
        return await r.text();
      },
      {
        retries: AWC_RETRIES,
        baseDelayMs: AWC_BASE_DELAY_MS,
        onRetry: awcOnRetry(label),
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  aviation_weather: ${label} failed after retries: ${msg}`);
    failures?.push(`${label}: ${msg}`);
    return null;
  }
}

/**
 * Great-circle distance in nautical miles between two lat/lon pairs.
 * Standard haversine formula. Used for hazard polygon proximity checks.
 */
export function nmDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R_NM = 3440.065; // Earth radius in nautical miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Test whether a point is inside a polygon using ray casting. Polygon is an
 * array of {lat, lon} vertices, assumed closed (or auto-closed by the
 * algorithm — we don't require the last point to equal the first).
 */
export function pointInPolygon(
  lat: number,
  lon: number,
  polygon: { lat: number; lon: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lon;
    const yi = polygon[i].lat;
    const xj = polygon[j].lon;
    const yj = polygon[j].lat;
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Returns true if any of the user's stations is inside the polygon OR within
 * the proximity threshold (nautical miles) of any vertex. The proximity check
 * catches polygons that brush against the route without enclosing it.
 */
function stationsInOrNearPolygon(
  stations: StationInfo[],
  polygon: { lat: number; lon: number }[],
  proximityNm: number,
): string[] {
  const hits: string[] = [];
  for (const s of stations) {
    if (pointInPolygon(s.lat, s.lon, polygon)) {
      hits.push(s.icaoId);
      continue;
    }
    const minDist = polygon.reduce(
      (min, v) => Math.min(min, nmDistance(s.lat, s.lon, v.lat, v.lon)),
      Infinity,
    );
    if (minDist <= proximityNm) hits.push(s.icaoId);
  }
  return hits;
}

/**
 * Density altitude from a METAR.
 *
 *   pressure_alt = field_elev + (29.92 - altimeter_inHg) * 1000
 *   ISA_temp_C   = 15 - 2 * (field_elev / 1000)
 *   density_alt  = pressure_alt + 120 * (OAT_C - ISA_temp_C)
 *
 * Standard rule of thumb formula, accurate enough for student-pilot
 * preflight planning at low elevations. Returns null if any input is missing.
 */
export function computeDensityAltitude(
  fieldElevFt: number,
  oatC: number | undefined,
  altimeterInHg: number | undefined,
): { pressureAltFt: number; densityAltFt: number } | null {
  if (oatC === undefined || altimeterInHg === undefined) return null;
  const pressureAltFt = fieldElevFt + (29.92 - altimeterInHg) * 1000;
  const isaC = 15 - 2 * (fieldElevFt / 1000);
  const densityAltFt = pressureAltFt + 120 * (oatC - isaC);
  return {
    pressureAltFt: Math.round(pressureAltFt),
    densityAltFt: Math.round(densityAltFt),
  };
}

/** METAR `altim` field is in millibars; convert to inHg for the DA formula. */
function altimMbToInHg(mb: number | undefined): number | undefined {
  if (mb === undefined) return undefined;
  return mb * 0.02953;
}

function epochToIso(epoch: number | undefined): string | undefined {
  if (epoch === undefined) return undefined;
  return new Date(epoch * 1000).toISOString();
}

/**
 * Try to extract the most relevant section of an Area Forecast Discussion.
 * AFD text starts with metadata; the bulk we care about is the
 * "Aviation discussion" or the leading "Main Concerns" block. We just take
 * the first AFD_MAX_CHARS so the prompt doesn't balloon.
 */
function trimAfd(text: string | null): string | undefined {
  if (!text) return undefined;
  const cleaned = text.trim();
  if (cleaned.length <= AFD_MAX_CHARS) return cleaned;
  return cleaned.slice(0, AFD_MAX_CHARS) + '\n…[truncated]';
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'aviation_weather',
    description: 'Aviation weather — METAR/TAF/PIREPs/AIRMETs/SIGMETs/AFD for flight planning',

    async fetch(): Promise<ConnectorResult> {
      const stations = (config.stations as string[]) ?? [];
      if (!stations.length) {
        return {
          source: 'aviation_weather',
          description: 'No stations configured.',
          data: {},
          priorityHint: 'low',
        };
      }

      const stationStr = stations.join(',');
      const pirepRadius = (config.pirep_radius_nm as number | undefined) ?? DEFAULT_PIREP_RADIUS;
      const pirepAge = (config.pirep_age_hours as number | undefined) ?? DEFAULT_PIREP_AGE_HOURS;
      // Allow the user to pin a specific WFO for the AFD; otherwise use the
      // first ICAO-shaped station, since most WFO IDs map cleanly from a
      // nearby airport. If nothing qualifies the AFD is simply skipped —
      // better than falling back to a region the household has no connection
      // to, which is what a hardcoded default did.
      const afdStation =
        (config.wfo as string | undefined) ?? stations.find((s) => /^K[A-Z]{3}$/.test(s));
      // Products that could not be fetched this run. Reported in the payload:
      // a failed product used to look exactly like a quiet one (PIREPs read as
      // "0 recent" for weeks while every request was a 400).
      const unavailable: string[] = [];
      const pirepStation = pirepAnchor(stations);

      // Fire all endpoints in parallel. Each is wrapped in safeFetch* so any
      // single failure degrades that one product without breaking the whole
      // briefing — important because a flight lesson briefing is something
      // the user actually relies on day-of.
      const [
        metarRaw,
        tafRaw,
        stationInfoRaw,
        pirepRaw,
        airSigmetRaw,
        gAirmetRaws,
        cwaRaw,
        afdText,
      ] = await Promise.all([
        safeFetchJson<Record<string, unknown>[]>(
          `${AWC_API}/metar?ids=${encodeURIComponent(stationStr)}&format=json`,
          'METAR',
          unavailable,
        ),
        safeFetchJson<Record<string, unknown>[]>(
          `${AWC_API}/taf?ids=${encodeURIComponent(stationStr)}&format=json`,
          'TAF',
          unavailable,
        ),
        safeFetchJson<Record<string, unknown>[]>(
          `${AWC_API}/stationinfo?ids=${encodeURIComponent(stationStr)}&format=json`,
          'stationinfo',
          unavailable,
        ),
        safeFetchJson<Record<string, unknown>[]>(
          `${AWC_API}/pirep?id=${encodeURIComponent(pirepStation ?? stations[0])}` +
            `&distance=${pirepRadius}&age=${pirepAge}&format=json`,
          'PIREPs',
          unavailable,
        ),
        safeFetchJson<Record<string, unknown>[]>(
          `${AWC_API}/airsigmet?format=json`,
          'AIRSIGMET',
          unavailable,
        ),
        Promise.all(
          GAIRMET_TYPES.map((t) =>
            safeFetchJson<Record<string, unknown>[]>(
              `${AWC_API}/gairmet?format=json&type=${t}`,
              `G-AIRMET ${t}`,
              unavailable,
            ),
          ),
        ),
        safeFetchJson<Record<string, unknown>[]>(`${AWC_API}/cwa?format=json`, 'CWA', unavailable),
        afdStation
          ? safeFetchText(
              `${AWC_API}/fcstdisc?cwa=${encodeURIComponent(afdStation)}&type=afd`,
              'AFD',
              unavailable,
            )
          : Promise.resolve(null),
      ]);

      // METAR is the floor — without it the whole connector is degraded.
      // We still return whatever we got rather than throwing.
      const metars = metarRaw ?? [];
      const tafs = tafRaw ?? [];

      const metarData = metars.map((m) => {
        const visibilityMi = parseVisibility(m.visib);
        const ceiling = ceilingFrom(m.clouds, m.vertVis);
        // The API sends its own category as `fltCat`; the connector read
        // `fltcat`, so every observation came through blank and every brief
        // said "Current: unknown". Prefer the API's value, compute otherwise.
        const reported = typeof m.fltCat === 'string' && m.fltCat ? m.fltCat : undefined;
        const computed = flightCategory(ceiling, visibilityMi);
        return {
          station: (m.icaoId as string) ?? '',
          raw: (m.rawOb as string) ?? '',
          tempC: m.temp as number | undefined,
          dewpointC: m.dewp as number | undefined,
          windDir: m.wdir as number | string | undefined,
          windSpeedKt: m.wspd as number | undefined,
          windGustKt: m.wgst as number | undefined,
          visibilityMi,
          ceiling,
          altimeterInHg: altimMbToInHg(m.altim as number | undefined),
          flightCategory: reported ?? computed.category ?? '',
        };
      });

      const tafData: TafForecast[] = tafs.map((t) => ({
        station: (t.icaoId as string) ?? '',
        raw: (t.rawTAF as string) ?? '',
        periods: parseTafPeriods(t),
      }));

      // Station info: convert elev meters → feet so density altitude math
      // and any "field elevation: X ft" surfacing is in pilot units.
      const stationInfo: StationInfo[] = (stationInfoRaw ?? []).map((s) => ({
        icaoId: (s.icaoId as string) ?? '',
        site: (s.site as string) ?? '',
        lat: (s.lat as number) ?? 0,
        lon: (s.lon as number) ?? 0,
        elevFt: Math.round(((s.elev as number) ?? 0) * 3.28084),
      }));

      // PIREPs: trim to ~15, prefer recent + within radius. The API already
      // filters by distance from station[0], so we just shape and cap.
      const pireps: PirepReport[] = (pirepRaw ?? []).slice(0, 15).map((p) => {
        const clouds = p.clouds as { cover?: string; base?: number; top?: number }[] | undefined;
        const cloudsStr =
          clouds
            ?.map((c) => `${c.cover ?? ''}${c.base ? c.base.toString() : ''}`)
            .filter(Boolean)
            .join(' ') || undefined;
        const tbInt = (p.tbInt1 as string) || '';
        const tbType = (p.tbType1 as string) || '';
        const turbulence = tbInt || tbType ? `${tbInt} ${tbType}`.trim() : undefined;
        const icgInt = (p.icgInt1 as string) || '';
        const icgType = (p.icgType1 as string) || '';
        const icing = icgInt || icgType ? `${icgInt} ${icgType}`.trim() : undefined;
        return {
          station: (p.icaoId as string) ?? '',
          obsTime: epochToIso(p.obsTime as number | undefined) ?? '',
          acType: (p.acType as string) ?? undefined,
          lat: (p.lat as number) ?? 0,
          lon: (p.lon as number) ?? 0,
          altitudeFt:
            ((p.fltLvl as number | undefined) ?? undefined)
              ? (p.fltLvl as number) * 100
              : undefined,
          cloudsRaw: cloudsStr,
          weather: (p.wxString as string) || undefined,
          turbulence,
          icing,
          raw: (p.rawOb as string) ?? '',
        };
      });

      // AIRMET / SIGMET filtering: keep only items whose polygon contains or
      // is within HAZARD_PROXIMITY_NM of any user station. The API returns
      // every active hazard nationwide; without this filter the payload is
      // huge and almost all of it is irrelevant to any one pilot.
      const airSigmetReports: HazardPolygonReport[] = [];
      for (const a of airSigmetRaw ?? []) {
        const coords = a.coords as { lat: number; lon: number }[] | undefined;
        if (!coords?.length) continue;
        const affected = stationsInOrNearPolygon(stationInfo, coords, HAZARD_PROXIMITY_NM);
        if (!affected.length) continue;
        airSigmetReports.push({
          type: (a.airSigmetType as string) === 'AIRMET' ? 'AIRMET' : 'SIGMET',
          hazard: (a.hazard as string) ?? '',
          validFrom: epochToIso(a.validTimeFrom as number | undefined),
          validTo: epochToIso(a.validTimeTo as number | undefined),
          altitudeLowFt: (a.altitudeLow1 as number | null) ?? undefined,
          altitudeHighFt: (a.altitudeHi1 as number | null) ?? undefined,
          severity: a.severity as number | undefined,
          affectedStations: affected,
          raw: (a.rawAirSigmet as string)?.slice(0, 800),
        });
      }

      // G-AIRMETs come per-forecast-hour (0/3/6/9/12). Collapse runs of the
      // same (hazard, product) over the same affected stations into a single
      // report so Claude sees "IFR active hours 0/3/6 over the home field" instead of
      // five near-duplicate entries.
      const gAirmetByKey = new Map<string, HazardPolygonReport>();
      for (const list of gAirmetRaws) {
        for (const g of list ?? []) {
          const coords = g.coords as { lat: string | number; lon: string | number }[] | undefined;
          if (!coords?.length) continue;
          const numericCoords = coords.map((c) => ({
            lat: typeof c.lat === 'string' ? parseFloat(c.lat) : c.lat,
            lon: typeof c.lon === 'string' ? parseFloat(c.lon) : c.lon,
          }));
          const affected = stationsInOrNearPolygon(stationInfo, numericCoords, HAZARD_PROXIMITY_NM);
          if (!affected.length) continue;

          const hazard = (g.hazard as string) ?? '';
          const product = (g.product as string) ?? '';
          const key = `${hazard}|${product}|${affected.sort().join(',')}`;
          const fcstHour = (g.forecastHour as number | undefined) ?? 0;

          const existing = gAirmetByKey.get(key);
          if (existing) {
            existing.forecastHours = [...(existing.forecastHours ?? []), fcstHour].sort(
              (a, b) => a - b,
            );
            continue;
          }
          gAirmetByKey.set(key, {
            type: 'G-AIRMET',
            hazard,
            product: product || undefined,
            validFrom: (g.validTime as string) ?? undefined,
            forecastHours: [fcstHour],
            altitudeLowFt: g.base ? Number(g.base) : undefined,
            altitudeHighFt: g.top ? Number(g.top) : undefined,
            reason: (g.due_to as string) ?? undefined,
            affectedStations: affected,
          });
        }
      }
      const gAirmetReports: HazardPolygonReport[] = Array.from(gAirmetByKey.values());

      const cwaReports: HazardPolygonReport[] = [];
      for (const c of cwaRaw ?? []) {
        const coords = c.coords as { lat: number; lon: number }[] | undefined;
        if (!coords?.length) continue;
        const affected = stationsInOrNearPolygon(stationInfo, coords, HAZARD_PROXIMITY_NM);
        if (!affected.length) continue;
        cwaReports.push({
          type: 'CWA',
          hazard: (c.hazard as string) ?? '',
          validFrom: epochToIso(c.validTimeFrom as number | undefined),
          validTo: epochToIso(c.validTimeTo as number | undefined),
          affectedStations: affected,
          raw: (c.cwaText as string)?.slice(0, 600),
        });
      }

      // Density altitude: pair each METAR with its station's elevation.
      const densityAltitude: DensityAltitudeReport[] = [];
      for (const m of metarData) {
        const info = stationInfo.find((s) => s.icaoId === m.station);
        if (!info) continue;
        const da = computeDensityAltitude(info.elevFt, m.tempC, m.altimeterInHg);
        if (!da) continue;
        densityAltitude.push({
          station: m.station,
          fieldElevFt: info.elevFt,
          oatC: m.tempC!,
          altimeterInHg: m.altimeterInHg!,
          pressureAltFt: da.pressureAltFt,
          densityAltFt: da.densityAltFt,
          daAboveFieldFt: da.densityAltFt - info.elevFt,
        });
      }

      const current = metarData
        .map((m) => `${m.station} ${m.flightCategory || 'unknown'}`)
        .join(', ');
      const tafSummary = tafData
        .map((t) => `${t.station} forecast worst: ${worstCategory(t.periods)}`)
        .join('; ');
      // Fields with no reporting of their own. The brief should say so rather
      // than quietly using another field's weather for them.
      const silent = stations.filter(
        (s) => !metarData.some((m) => m.station === s) && !tafData.some((t) => t.station === s),
      );
      const tafless = stations.filter(
        (s) => metarData.some((m) => m.station === s) && !tafData.some((t) => t.station === s),
      );

      const hazardCount = airSigmetReports.length + gAirmetReports.length + cwaReports.length;
      const hazardNote = hazardCount
        ? `${hazardCount} hazard advisory(ies) intersect your stations.`
        : 'No SIGMETs/AIRMETs/CWAs near your stations.';

      return {
        source: 'aviation_weather',
        description:
          `Aviation weather for ${stationStr}. Current: ${current || 'no observations'}. ` +
          `${tafSummary ? `${tafSummary}. ` : 'No TAFs. '}` +
          (silent.length
            ? `No METAR or TAF at all for ${silent.join(', ')} — say so if someone flies there; never borrow another field's weather without naming the field. `
            : '') +
          (tafless.length
            ? `${tafless.join(', ')} report observations but issue no TAF — any forecast for them is another station's. `
            : '') +
          (unavailable.length
            ? `UNAVAILABLE this run (not "nothing to report"): ${unavailable.join('; ')}. `
            : '') +
          `${hazardNote} ${pireps.length} recent PIREP(s) within ${pirepRadius}nm of ${pirepStation ?? 'the first station'}. ` +
          'Flight categories follow FAA thresholds (ceiling = lowest BKN/OVC/VV base; MVFR at or below 3000 ft or 5 SM). ' +
          "A period's `categoryBasis` says which elements it rests on; a missing category means unknown — never assume VFR. " +
          'Wind speeds here are knots. A TAF only covers its valid hours — never quote it for a time outside them. ' +
          'TAF forecast periods are decoded into structured data with flight categories, winds, and ceiling for each time window. ' +
          '**Match TAF periods against flight lesson times on the calendar.** If a flight lesson is at 9 AM, check what the TAF ' +
          "forecasts for that specific hour — don't just report current conditions. " +
          'Flag IFR/LIFR/MVFR, gusting winds above 15kt, or ceilings below 3000. ' +
          'For SIGMETs/AIRMETs/G-AIRMETs/CWAs in the data, surface anything that affects a station the user is flying from/to today. ' +
          'Use PIREPs to ground-truth the forecast — if the TAF says VFR but a recent PIREP reports IFR, mention it. ' +
          'Density altitude: only flag when daAboveFieldFt exceeds 1500 ft (hot-and-high; uncommon outside summer in temperate regions). ' +
          'Area Forecast Discussion (afd) is plain text from the local NWS forecaster — quote a single relevant sentence about ' +
          'aviation impacts if it adds value beyond the structured data, otherwise skip it. ' +
          "For VFR with light winds at lesson time and no hazards, a simple 'good flying weather' suffices. " +
          'If no flying today, skip aviation weather entirely.',
        data: {
          metars: metarData,
          tafs: tafData,
          stationInfo,
          pireps,
          airSigmets: airSigmetReports,
          gAirmets: gAirmetReports,
          cwas: cwaReports,
          densityAltitude,
          afd: trimAfd(afdText),
          ...(unavailable.length ? { unavailable } : {}),
          ...(silent.length ? { stationsWithoutReports: silent } : {}),
        },
        priorityHint: hazardCount > 0 ? 'high' : 'normal',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const stations = (config.stations as string[]) ?? [];

  if (stations.length) {
    checks.push([PASS, `${stations.length} station(s) configured`, '']);
    for (const s of stations) checks.push([INFO, `  \u2192 ${s}`, '']);

    // A three-letter code here is almost always an IATA code pasted from a
    // booking site. Weather endpoints want the ICAO or FAA identifier, and
    // the wrong one returns no data rather than an error.
    for (const s of stations.filter((s) => /^[A-Z]{3}$/.test(s))) {
      checks.push([
        WARN,
        `Station "${s}" looks like an IATA code`,
        `Weather lookups need the ICAO or FAA identifier \u2014 try "K${s}"`,
      ]);
    }
    for (const s of stations.filter((s) => !/^[A-Z0-9]{3,4}$/.test(s))) {
      checks.push([WARN, `Station "${s}" is not a valid identifier shape`, '3-4 alphanumerics']);
    }
  } else if (config.derive_stations === false) {
    checks.push([FAIL, 'No stations configured', '']);
  } else {
    checks.push([
      INFO,
      'No stations configured \u2014 airports will be read from calendar events',
      'Add `stations` for fields you always want, or `airport_aliases` to map place names',
    ]);
  }

  const wfo = config.wfo as string | undefined;
  if (wfo) {
    checks.push([INFO, `WFO override for AFD: ${wfo}`, '']);
  } else if (stations.length && !stations[0].startsWith('K')) {
    checks.push([
      WARN,
      `First station ${stations[0]} is non-ICAO — AFD may not resolve`,
      'Set wfo explicitly to your local WFO',
    ]);
  }

  const pirepRadius = config.pirep_radius_nm as number | undefined;
  if (pirepRadius !== undefined) {
    checks.push([INFO, `PIREP radius: ${pirepRadius}nm`, '']);
  }

  return checks;
}
