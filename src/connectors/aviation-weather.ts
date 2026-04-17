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
  ceiling?: number;
  flightCategory?: string;
  weather?: string;
  raw: string;
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
function parseTafPeriods(taf: Record<string, unknown>): TafPeriod[] {
  const fcsts = taf.fcsts as Record<string, unknown>[] | undefined;
  if (!fcsts?.length) return [];

  return fcsts.map((f) => {
    // Determine flight category from ceiling and visibility
    const ceil = f.ceil as number | undefined;
    const vis = f.visib as number | undefined;
    let flightCategory: string | undefined;

    if (ceil !== undefined || vis !== undefined) {
      if ((ceil !== undefined && ceil < 200) || (vis !== undefined && vis < 1)) {
        flightCategory = 'LIFR';
      } else if ((ceil !== undefined && ceil < 500) || (vis !== undefined && vis < 3)) {
        flightCategory = 'IFR';
      } else if ((ceil !== undefined && ceil < 1000) || (vis !== undefined && vis < 5)) {
        flightCategory = 'MVFR';
      } else {
        flightCategory = 'VFR';
      }
    }

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
    const changeType = (f.fcstChange as string) ?? '';
    if (changeType.startsWith('TEMPO')) type = 'tempo';
    else if (changeType.startsWith('BECMG')) type = 'becmg';
    else if (changeType.startsWith('PROB')) type = 'prob';

    // Collect weather phenomena
    const wxString = (f.wxString as string) ?? '';

    return {
      from: fromStr,
      to: toStr,
      type,
      windDir: f.wdir as number | string | undefined,
      windSpeedKt: f.wspd as number | undefined,
      windGustKt: f.wgst as number | undefined,
      visibilityMi: vis,
      ceiling: ceil,
      flightCategory,
      weather: wxString || undefined,
      raw: (f.raw as string) ?? '',
    };
  });
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
async function safeFetchJson<T>(url: string, label: string): Promise<T | null> {
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
      return null;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  aviation_weather: ${label} failed after retries: ${msg}`);
    return null;
  }
}

async function safeFetchText(url: string, label: string): Promise<string | null> {
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
      // Allow user to pin a specific WFO for the AFD; otherwise default to
      // the first configured station (e.g. KLOT). Most WFO IDs map cleanly
      // from a nearby ICAO airport — KLOT for Chicago, KMKE for Milwaukee.
      const afdStation =
        (config.wfo as string | undefined) ?? (stations[0].startsWith('K') ? stations[0] : 'KLOT');

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
        ),
        safeFetchJson<Record<string, unknown>[]>(
          `${AWC_API}/taf?ids=${encodeURIComponent(stationStr)}&format=json`,
          'TAF',
        ),
        safeFetchJson<Record<string, unknown>[]>(
          `${AWC_API}/stationinfo?ids=${encodeURIComponent(stationStr)}&format=json`,
          'stationinfo',
        ),
        safeFetchJson<Record<string, unknown>[]>(
          `${AWC_API}/pirep?id=${encodeURIComponent(stations[0])}` +
            `&distance=${pirepRadius}&age=${pirepAge}&format=json`,
          'PIREPs',
        ),
        safeFetchJson<Record<string, unknown>[]>(`${AWC_API}/airsigmet?format=json`, 'AIRSIGMET'),
        Promise.all(
          GAIRMET_TYPES.map((t) =>
            safeFetchJson<Record<string, unknown>[]>(
              `${AWC_API}/gairmet?format=json&type=${t}`,
              `G-AIRMET ${t}`,
            ),
          ),
        ),
        safeFetchJson<Record<string, unknown>[]>(`${AWC_API}/cwa?format=json`, 'CWA'),
        safeFetchText(`${AWC_API}/fcstdisc?cwa=${encodeURIComponent(afdStation)}&type=afd`, 'AFD'),
      ]);

      // METAR is the floor — without it the whole connector is degraded.
      // We still return whatever we got rather than throwing.
      const metars = metarRaw ?? [];
      const tafs = tafRaw ?? [];

      const metarData = metars.map((m) => ({
        station: (m.icaoId as string) ?? '',
        raw: (m.rawOb as string) ?? '',
        tempC: m.temp as number | undefined,
        dewpointC: m.dewp as number | undefined,
        windDir: m.wdir as number | string | undefined,
        windSpeedKt: m.wspd as number | undefined,
        windGustKt: m.wgst as number | undefined,
        visibilityMi: m.visib as number | string | undefined,
        ceiling: m.ceil as number | undefined,
        altimeterInHg: altimMbToInHg(m.altim as number | undefined),
        flightCategory: (m.fltcat as string) ?? '',
      }));

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
      // huge and almost all of it is irrelevant to a Chicago-area pilot.
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
      // report so Claude sees "IFR active hours 0/3/6 over KLOT" instead of
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

      const categories = metarData.map((m) => m.flightCategory).filter(Boolean);
      const tafSummary = tafData
        .map((t) => {
          const worst = t.periods.reduce((w, p) => {
            const rank = { LIFR: 0, IFR: 1, MVFR: 2, VFR: 3 };
            const pRank = rank[p.flightCategory as keyof typeof rank] ?? 3;
            const wRank = rank[w as keyof typeof rank] ?? 3;
            return pRank < wRank ? (p.flightCategory ?? w) : w;
          }, 'VFR');
          return `${t.station} forecast worst: ${worst}`;
        })
        .join('; ');

      const hazardCount = airSigmetReports.length + gAirmetReports.length + cwaReports.length;
      const hazardNote = hazardCount
        ? `${hazardCount} hazard advisory(ies) intersect your stations.`
        : 'No SIGMETs/AIRMETs/CWAs near your stations.';

      return {
        source: 'aviation_weather',
        description:
          `Aviation weather for ${stationStr}. Current: ${categories.join(', ') || 'unknown'}. ${tafSummary}. ` +
          `${hazardNote} ${pireps.length} recent PIREP(s) within ${pirepRadius}nm. ` +
          'TAF forecast periods are decoded into structured data with flight categories, winds, and ceiling for each time window. ' +
          '**Match TAF periods against flight lesson times on the calendar.** If a flight lesson is at 9 AM, check what the TAF ' +
          "forecasts for that specific hour — don't just report current conditions. " +
          'Flag IFR/LIFR/MVFR, gusting winds above 15kt, or ceilings below 3000. ' +
          'For SIGMETs/AIRMETs/G-AIRMETs/CWAs in the data, surface anything that affects a station the user is flying from/to today. ' +
          'Use PIREPs to ground-truth the forecast — if the TAF says VFR but a recent PIREP reports IFR, mention it. ' +
          'Density altitude: only flag when daAboveFieldFt exceeds 1500 ft (hot-and-high — uncommon for Chicago in spring/fall). ' +
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
  } else {
    checks.push([FAIL, 'No stations configured', '']);
  }

  const wfo = config.wfo as string | undefined;
  if (wfo) {
    checks.push([INFO, `WFO override for AFD: ${wfo}`, '']);
  } else if (stations.length && !stations[0].startsWith('K')) {
    checks.push([
      WARN,
      `First station ${stations[0]} is non-ICAO — AFD may not resolve`,
      'Set wfo: KLOT (or your local WFO) explicitly',
    ]);
  }

  const pirepRadius = config.pirep_radius_nm as number | undefined;
  if (pirepRadius !== undefined) {
    checks.push([INFO, `PIREP radius: ${pirepRadius}nm`, '']);
  }

  return checks;
}
