import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, INFO } from '../test-icons.js';

const AWC_API = 'https://aviationweather.gov/api/data';

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

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'aviation_weather',
    description: 'Aviation weather — METAR/TAF for flight planning',

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

      const metarResp = await fetch(
        `${AWC_API}/metar?ids=${encodeURIComponent(stationStr)}&format=json`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!metarResp.ok) throw new Error(`METAR API: ${metarResp.status}`);
      const metars = (await metarResp.json()) as Record<string, unknown>[];

      const tafResp = await fetch(
        `${AWC_API}/taf?ids=${encodeURIComponent(stationStr)}&format=json`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!tafResp.ok) throw new Error(`TAF API: ${tafResp.status}`);
      const tafs = (await tafResp.json()) as Record<string, unknown>[];

      const metarData = metars.map((m) => ({
        station: m.icaoId ?? '',
        raw: m.rawOb ?? '',
        tempC: m.temp,
        dewpointC: m.dewp,
        windDir: m.wdir,
        windSpeedKt: m.wspd,
        windGustKt: m.wgst,
        visibilityMi: m.visib,
        ceiling: m.ceil,
        flightCategory: m.fltcat ?? '',
      }));

      // Parse TAFs into structured forecast periods
      const tafData: TafForecast[] = tafs.map((t) => ({
        station: (t.icaoId as string) ?? '',
        raw: (t.rawTAF as string) ?? '',
        periods: parseTafPeriods(t),
      }));

      const categories = metarData.map((m) => m.flightCategory).filter(Boolean);

      // Summarize TAF outlook for the description
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

      return {
        source: 'aviation_weather',
        description:
          `Aviation weather for ${stationStr}. Current: ${categories.join(', ')}. ${tafSummary}. ` +
          'TAF forecast periods are decoded into structured data with flight categories, winds, and ceiling for each time window. ' +
          '**Match TAF periods against flight lesson times on the calendar.** If a flight lesson is at 9 AM, check what the TAF ' +
          "forecasts for that specific hour — don't just report current conditions. " +
          'Flag IFR/LIFR/MVFR, gusting winds above 15kt, or ceilings below 3000. ' +
          "For VFR with light winds at lesson time, a simple 'good flying weather' suffices. " +
          'If no flying today, skip aviation weather entirely.',
        data: { metars: metarData, tafs: tafData },
        priorityHint: 'normal',
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

  return checks;
}
