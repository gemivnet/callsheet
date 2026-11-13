import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, INFO } from '../test-icons.js';
import { retry, HttpError } from '../retry.js';

const HEADERS = { 'User-Agent': 'callsheet-brief/1.0' };

/** NWS occasionally 5xxs during model ingest cycles; retry a few times. */
const NWS_RETRIES = 3;
const NWS_BASE_DELAY_MS = 400;

function nwsOnRetry(label: string): (attempt: number, err: unknown, delayMs: number) => void {
  return (attempt, err, delayMs) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `  weather: ${label} attempt ${attempt} failed (${msg}), retrying in ${delayMs}ms...`,
    );
  };
}

interface NwsAlert {
  event: string;
  severity: string;
  urgency: string;
  headline: string;
  onset: string | null;
  /** When the hazard itself ends. */
  ends: string | null;
  /**
   * When this alert MESSAGE expires and is due to be reissued — not when the
   * hazard ends. Reading it as the end had briefs lifting a heat warning
   * hours early and putting a morning lesson "clear of the window" inside it.
   */
  messageExpires: string | null;
}

/** "Wed, Oct 14, 3:00 PM" in the household timezone, or null. */
function alertTime(iso: unknown, tz?: string): string | null {
  if (typeof iso !== 'string' || !iso) return null;
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(tz ? { timeZone: tz } : {}),
  });
}

/** Active alerts, or null when they could not be fetched (which is not the same as none). */
async function fetchAlerts(lat: number, lon: number, tz?: string): Promise<NwsAlert[] | null> {
  try {
    const data = await retry(
      async () => {
        const resp = await fetch(
          `https://api.weather.gov/alerts/active?point=${lat},${lon}&status=actual`,
          { headers: HEADERS, signal: AbortSignal.timeout(10_000) },
        );
        if (!resp.ok) throw new HttpError(resp.status, `alerts: ${resp.status}`);
        return (await resp.json()) as {
          features: { properties: Record<string, unknown> }[];
        };
      },
      {
        retries: NWS_RETRIES,
        baseDelayMs: NWS_BASE_DELAY_MS,
        onRetry: nwsOnRetry('alerts'),
      },
    );

    return (data.features ?? []).map((f) => {
      const p = f.properties;
      return {
        event: (p.event as string) ?? '',
        severity: (p.severity as string) ?? '',
        urgency: (p.urgency as string) ?? '',
        headline: (p.headline as string) ?? '',
        onset: alertTime(p.onset, tz),
        ends: alertTime(p.ends, tz),
        messageExpires: alertTime(p.expires, tz),
      };
    });
  } catch {
    return null;
  }
}

/**
 * The household weather hub (optional `source_url`): one local service that already merged NWS with its
 * backups, so a failing upstream does not blank the brief. Any failure returns null and the caller goes
 * straight to NWS, so the hub can only ever add a source, never remove one.
 */
async function fetchFromHub(
  baseUrl: string | undefined,
  tz?: string,
): Promise<{ forecast: Record<string, unknown>[]; alerts: NwsAlert[] | null } | null> {
  if (!baseUrl) return null;
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/callsheet`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      forecast?: Record<string, unknown>[];
      alerts?: Record<string, unknown>[];
      alerts_known?: boolean;
    };
    if (!Array.isArray(data.forecast) || data.forecast.length === 0) return null;
    // "No alerts" and "could not check" are different answers: only a known empty list means none.
    const alerts = data.alerts_known
      ? (data.alerts ?? []).map((a) => ({
          event: (a.event as string) ?? '',
          severity: (a.severity as string) ?? '',
          urgency: (a.urgency as string) ?? '',
          headline: (a.headline as string) ?? '',
          onset: alertTime(a.onset, tz),
          ends: alertTime(a.ends, tz),
          messageExpires: alertTime(a.expires, tz),
        }))
      : null;
    return { forecast: data.forecast, alerts };
  } catch {
    return null;
  }
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'weather',
    description: "Weather — today's forecast + active alerts from NWS (free, US only)",

    async fetch(): Promise<ConnectorResult> {
      const lat = config.lat as number;
      const lon = config.lon as number;
      const location = (config.location as string) ?? `${lat},${lon}`;

      const tz = config.timezone as string | undefined;
      const hub = await fetchFromHub(config.source_url as string | undefined, tz);
      let forecast: Record<string, unknown>[];
      let alerts: NwsAlert[];
      let fetched: NwsAlert[] | null;

      if (hub) {
        ({ forecast } = hub);
        fetched = hub.alerts;
        alerts = hub.alerts ?? [];
      } else {
        // Step 1: Get the forecast grid endpoint for this location
        const pointData = await retry(
          async () => {
            const resp = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
              headers: HEADERS,
              signal: AbortSignal.timeout(10_000),
            });
            if (!resp.ok) throw new HttpError(resp.status, `NWS points API: ${resp.status}`);
            return (await resp.json()) as {
              properties: { forecast: string; forecastHourly: string };
            };
          },
          { retries: NWS_RETRIES, baseDelayMs: NWS_BASE_DELAY_MS, onRetry: nwsOnRetry('points') },
        );
        const forecastUrl = pointData.properties.forecast;

        // Step 2: Get the forecast
        const forecastData = await retry(
          async () => {
            const resp = await fetch(forecastUrl, {
              headers: HEADERS,
              signal: AbortSignal.timeout(10_000),
            });
            if (!resp.ok) throw new HttpError(resp.status, `NWS forecast API: ${resp.status}`);
            return (await resp.json()) as {
              properties: { periods: Record<string, unknown>[] };
            };
          },
          { retries: NWS_RETRIES, baseDelayMs: NWS_BASE_DELAY_MS, onRetry: nwsOnRetry('forecast') },
        );
        const { periods } = forecastData.properties;

        // Take today + tonight + tomorrow (first 3-4 periods)
        forecast = periods.slice(0, 4).map((p: Record<string, unknown>) => ({
          name: p.name,
          temperature: p.temperature,
          unit: p.temperatureUnit,
          wind: `${p.windSpeed} ${p.windDirection}`,
          shortForecast: p.shortForecast,
          detailedForecast: p.detailedForecast,
          precipitationChance:
            (p.probabilityOfPrecipitation as Record<string, unknown> | undefined)?.value ?? null,
        }));

        // Step 3: Get active weather alerts
        fetched = await fetchAlerts(lat, lon, tz);
        alerts = fetched ?? [];
      }

      const alertSummary = alerts.length
        ? `${alerts.length} active alert(s): ${alerts.map((a) => a.event).join(', ')}. `
        : '';

      return {
        source: 'weather',
        description:
          `Weather forecast for ${location}. ${alertSummary}` +
          'Includes today, tonight, and tomorrow. ' +
          (alerts.length
            ? '**Active weather alerts are HIGH PRIORITY** — surface them prominently in the Executive Brief. ' +
              "Include the alert type, timing, and how it affects the day's plans (driving, flying, outdoor events). " +
              "An alert's `ends` is when the hazard ends; `messageExpires` is only when the alert text is reissued — " +
              'never present it as the end of the hazard. '
            : '') +
          (fetched === null
            ? 'Active alerts could NOT be fetched this run — do not say there are none. '
            : '') +
          'Forecast winds are in mph; aviation weather uses knots — never relabel one as the other. ' +
          'For routine weather, include a one-line summary. ' +
          'Mention weather if it affects plans (rain on outdoor event days, ' +
          'extreme temps, icy roads, high winds). Skip if unremarkable.',
        data: {
          location,
          periods: forecast,
          alerts,
          ...(fetched === null ? { alertsUnavailable: true } : {}),
        },
        priorityHint: alerts.length ? 'high' : 'low',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const lat = config.lat as number | undefined;
  const lon = config.lon as number | undefined;

  if (lat != null && lon != null) {
    checks.push([PASS, `Location: ${config.location ?? ''}`, `lat=${lat}, lon=${lon}`]);
  } else {
    checks.push([FAIL, 'Lat/lon not configured', '']);
  }

  if (config.source_url) {
    checks.push([INFO, 'Weather hub', 'Tried first; NWS is the fallback']);
  }
  checks.push([INFO, 'NWS API \u2014 no auth required', 'Forecast + active alerts (US only)']);
  return checks;
}
