import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, INFO } from '../test-icons.js';

const HEADERS = { 'User-Agent': 'callsheet-brief/1.0' };

interface NwsAlert {
  event: string;
  severity: string;
  urgency: string;
  headline: string;
  onset: string | null;
  expires: string | null;
}

async function fetchAlerts(lat: number, lon: number): Promise<NwsAlert[]> {
  try {
    const resp = await fetch(
      `https://api.weather.gov/alerts/active?point=${lat},${lon}&status=actual`,
      { headers: HEADERS, signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) return [];

    const data = (await resp.json()) as {
      features: {
        properties: Record<string, unknown>;
      }[];
    };

    return (data.features ?? []).map((f) => {
      const p = f.properties;
      const onset = p.onset as string | null;
      const expires = p.expires as string | null;

      return {
        event: (p.event as string) ?? '',
        severity: (p.severity as string) ?? '',
        urgency: (p.urgency as string) ?? '',
        headline: (p.headline as string) ?? '',
        onset: onset
          ? new Date(onset).toLocaleString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })
          : null,
        expires: expires
          ? new Date(expires).toLocaleString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })
          : null,
      };
    });
  } catch {
    return [];
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

      // Step 1: Get the forecast grid endpoint for this location
      const pointResp = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(10_000),
      });
      if (!pointResp.ok) throw new Error(`NWS points API: ${pointResp.status}`);
      const pointData = (await pointResp.json()) as {
        properties: { forecast: string; forecastHourly: string };
      };
      const forecastUrl = pointData.properties.forecast;

      // Step 2: Get the forecast
      const forecastResp = await fetch(forecastUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(10_000),
      });
      if (!forecastResp.ok) throw new Error(`NWS forecast API: ${forecastResp.status}`);
      const forecastData = (await forecastResp.json()) as {
        properties: { periods: Record<string, unknown>[] };
      };
      const { periods } = forecastData.properties;

      // Take today + tonight + tomorrow (first 3-4 periods)
      const forecast = periods.slice(0, 4).map((p: Record<string, unknown>) => ({
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
      const alerts = await fetchAlerts(lat, lon);

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
              "Include the alert type, timing, and how it affects the day's plans (driving, flying, outdoor events). "
            : '') +
          'For routine weather, include a one-line summary. ' +
          'Mention weather if it affects plans (rain on outdoor event days, ' +
          'extreme temps, icy roads, high winds). Skip if unremarkable.',
        data: { location, periods: forecast, alerts },
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

  checks.push([INFO, 'NWS API \u2014 no auth required', 'Forecast + active alerts (US only)']);
  return checks;
}
