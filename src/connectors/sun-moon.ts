import SunCalc from 'suncalc';
import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, INFO } from '../test-icons.js';

/**
 * Sun and moon facts for a fixed location, computed locally with suncalc.
 *
 * Pure math, no network calls — never fails. Useful for:
 *   - Civil twilight times (FAA night-currency boundary is end of civil
 *     twilight + 1 hour for student pilots; sunset → end of civil twilight is
 *     "night for VFR purposes" but not for currency).
 *   - Sunrise/sunset for the household-side of the brief (golf, walks, etc.).
 *   - Moon phase + illumination, relevant when night flying or stargazing.
 */

interface SunMoonReport {
  date: string;
  /** Local time strings, formatted in the host's timezone. */
  sunrise?: string;
  sunset?: string;
  solarNoon?: string;
  /** Civil dawn = ~6° below horizon in the morning. */
  civilDawn?: string;
  /** Civil dusk = ~6° below horizon in the evening; "end of civil twilight". */
  civilDusk?: string;
  /** Daylight duration in hours, rounded to one decimal. */
  daylightHours?: number;
  /** Moon illuminated fraction 0–1. */
  moonIllumination?: number;
  /** Moon phase 0–1 (0=new, 0.25=first quarter, 0.5=full, 0.75=last quarter). */
  moonPhase?: number;
  /** Human-readable phase name. */
  moonPhaseName?: string;
  moonrise?: string;
  moonset?: string;
}

function fmtTime(d: Date | undefined | null): string | undefined {
  if (!d || isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Map a 0–1 phase number to the standard 8-phase name. Boundaries are at the
 * usual 1/8 marks; "new" and "full" get a small window so a near-full moon
 * still reads as "Full" rather than the unhelpful "Waxing Gibbous".
 */
export function moonPhaseName(phase: number): string {
  if (phase < 0.03 || phase > 0.97) return 'New Moon';
  if (phase < 0.22) return 'Waxing Crescent';
  if (phase < 0.28) return 'First Quarter';
  if (phase < 0.47) return 'Waxing Gibbous';
  if (phase < 0.53) return 'Full Moon';
  if (phase < 0.72) return 'Waning Gibbous';
  if (phase < 0.78) return 'Last Quarter';
  return 'Waning Crescent';
}

export function computeSunMoon(date: Date, lat: number, lon: number): SunMoonReport {
  const times = SunCalc.getTimes(date, lat, lon);
  const moonTimes = SunCalc.getMoonTimes(date, lat, lon);
  const moonIll = SunCalc.getMoonIllumination(date);

  const daylightHours =
    times.sunrise &&
    times.sunset &&
    !isNaN(times.sunrise.getTime()) &&
    !isNaN(times.sunset.getTime())
      ? Math.round(((times.sunset.getTime() - times.sunrise.getTime()) / 3_600_000) * 10) / 10
      : undefined;

  return {
    date: date.toISOString().slice(0, 10),
    sunrise: fmtTime(times.sunrise),
    sunset: fmtTime(times.sunset),
    solarNoon: fmtTime(times.solarNoon),
    civilDawn: fmtTime(times.dawn),
    civilDusk: fmtTime(times.dusk),
    daylightHours,
    moonIllumination: Math.round(moonIll.fraction * 100) / 100,
    moonPhase: Math.round(moonIll.phase * 100) / 100,
    moonPhaseName: moonPhaseName(moonIll.phase),
    moonrise: fmtTime(moonTimes.rise),
    moonset: fmtTime(moonTimes.set),
  };
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'sun_moon',
    description: 'Sun and moon facts (local computation, no API calls)',

    fetch(): Promise<ConnectorResult> {
      const lat = config.lat as number | undefined;
      const lon = config.lon as number | undefined;

      if (lat === undefined || lon === undefined) {
        return Promise.resolve({
          source: 'sun_moon',
          description: 'No lat/lon configured.',
          data: {},
          priorityHint: 'low',
        });
      }

      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todayReport = computeSunMoon(today, lat, lon);
      const tomorrowReport = computeSunMoon(tomorrow, lat, lon);

      // Check whether the moon's daylight overlap is meaningful — i.e. is
      // tonight a moonlit night? Useful both for night flight planning and
      // for the household side ("good moon for stargazing tonight").
      const brightMoon = (todayReport.moonIllumination ?? 0) >= 0.7;

      return Promise.resolve({
        source: 'sun_moon',
        description:
          `Sunrise ${todayReport.sunrise}, sunset ${todayReport.sunset}, ` +
          `${todayReport.daylightHours}h daylight. Moon: ${todayReport.moonPhaseName} ` +
          `(${Math.round((todayReport.moonIllumination ?? 0) * 100)}% illuminated). ` +
          'Use sunrise/sunset only when relevant to the day (commute, walk, golf, flight). ' +
          'Civil twilight (civilDawn/civilDusk) matters for VFR night flying — student pilots ' +
          'cannot count flight time after end of civil twilight + 1h toward day currency. ' +
          'Mention the moon phase only when it adds value: a Full Moon when night flight is on the calendar, ' +
          'or a notably dark sky if the household has a stargazing or astrophotography interest. ' +
          'Skip the moon entirely on routine days. Do NOT include this section if the day has nothing tied to sun or moon.',
        data: {
          today: todayReport,
          tomorrow: tomorrowReport,
          brightMoon,
        },
        priorityHint: 'low',
      });
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const lat = config.lat as number | undefined;
  const lon = config.lon as number | undefined;

  if (lat === undefined || lon === undefined) {
    checks.push([FAIL, 'lat/lon not configured', 'Set lat and lon in sun_moon config']);
    return checks;
  }
  if (lat < -90 || lat > 90) {
    checks.push([FAIL, `lat ${lat} out of range`, 'Must be between -90 and 90']);
  } else if (lon < -180 || lon > 180) {
    checks.push([FAIL, `lon ${lon} out of range`, 'Must be between -180 and 180']);
  } else {
    checks.push([PASS, `Location: ${lat}, ${lon}`, '']);
    // Spot-check that suncalc returns a sensible time for this location.
    const today = new Date();
    const t = SunCalc.getTimes(today, lat, lon);
    if (t.sunrise && !isNaN(t.sunrise.getTime())) {
      checks.push([INFO, `Today's sunrise: ${fmtTime(t.sunrise)}`, '']);
    }
  }

  return checks;
}
