import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, INFO } from '../test-icons.js';

/**
 * Pure config-driven pickup scheduler. No API calls. Supports:
 *
 *   - weekly: same day every week
 *       { name: 'Garbage', weekly: 'thursday' }
 *
 *   - biweekly: every other week, anchored to a known pickup date
 *       { name: 'Recycling', biweekly: { day: 'tuesday', anchor: '2026-04-21' } }
 *
 * Emits all pickups in the next `lookahead_days` (default 7) so the brief
 * can surface "Garbage tonight" or "Recycling tomorrow morning".
 */

type DayName = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

const DAY_NAMES: DayName[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

interface WeeklySchedule {
  name: string;
  weekly: DayName;
}

interface BiweeklySchedule {
  name: string;
  biweekly: {
    day: DayName;
    /** A known pickup date in YYYY-MM-DD format. Future dates are derived from this. */
    anchor: string;
  };
}

type ScheduleConfig = WeeklySchedule | BiweeklySchedule;

interface UpcomingPickup {
  name: string;
  date: string;
  dayOfWeek: DayName;
  daysFromNow: number;
  /** "today", "tomorrow", or the weekday name. */
  whenLabel: string;
}

function dayIndex(day: string): number {
  const i = DAY_NAMES.indexOf(day.toLowerCase() as DayName);
  if (i < 0) throw new Error(`Invalid day name: ${day}`);
  return i;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Compute day-difference between two YYYY-MM-DD strings, ignoring local time. */
function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.UTC(
    Number(fromYmd.slice(0, 4)),
    Number(fromYmd.slice(5, 7)) - 1,
    Number(fromYmd.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(toYmd.slice(0, 4)),
    Number(toYmd.slice(5, 7)) - 1,
    Number(toYmd.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000);
}

/** Return all upcoming pickup dates (YYYY-MM-DD) for one schedule within `windowDays`. */
export function nextPickups(
  schedule: ScheduleConfig,
  today: Date,
  windowDays: number,
): { name: string; date: string; dayOfWeek: DayName }[] {
  const todayYmd = ymd(today);
  const todayDow = today.getUTCDay(); // use UTC to match ymd() above
  const out: { name: string; date: string; dayOfWeek: DayName }[] = [];

  if ('weekly' in schedule) {
    const target = dayIndex(schedule.weekly);
    // Distance forward to the next occurrence (including today if today matches)
    let offset = (target - todayDow + 7) % 7;
    while (offset <= windowDays) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() + offset);
      out.push({ name: schedule.name, date: ymd(d), dayOfWeek: DAY_NAMES[target] });
      offset += 7;
    }
    return out;
  }

  if ('biweekly' in schedule) {
    const target = dayIndex(schedule.biweekly.day);
    const anchorYmd = schedule.biweekly.anchor;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorYmd)) {
      throw new Error(`Invalid biweekly anchor date: ${anchorYmd} (expected YYYY-MM-DD)`);
    }
    // Walk forward in 14-day strides from the anchor (or backwards then forwards
    // until we find one in or after today's window).
    const diff = daysBetween(anchorYmd, todayYmd);
    // First occurrence at or after today: anchor + ceil(diff/14)*14, clamped >= 0
    const stridesAhead = Math.max(0, Math.ceil(diff / 14));
    const anchorDate = new Date(`${anchorYmd}T00:00:00Z`);
    const verifyDow = anchorDate.getUTCDay();
    if (verifyDow !== target) {
      throw new Error(
        `biweekly anchor ${anchorYmd} is a ${DAY_NAMES[verifyDow]} but day says ${schedule.biweekly.day}`,
      );
    }
    const first = new Date(anchorDate);
    first.setUTCDate(first.getUTCDate() + stridesAhead * 14);

    const lastAllowed = new Date(today);
    lastAllowed.setUTCDate(lastAllowed.getUTCDate() + windowDays);

    const cursor = new Date(first);
    while (cursor.getTime() <= lastAllowed.getTime()) {
      out.push({ name: schedule.name, date: ymd(cursor), dayOfWeek: DAY_NAMES[target] });
      cursor.setUTCDate(cursor.getUTCDate() + 14);
    }
    return out;
  }

  return out;
}

function whenLabel(daysFromNow: number, dayOfWeek: DayName): string {
  if (daysFromNow === 0) return 'today';
  if (daysFromNow === 1) return 'tomorrow';
  return dayOfWeek.charAt(0).toUpperCase() + dayOfWeek.slice(1);
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'garbage_recycling',
    description: 'Garbage and recycling pickup schedule (config-driven, no API)',

    async fetch(): Promise<ConnectorResult> {
      const schedules = (config.schedules as ScheduleConfig[] | undefined) ?? [];
      const lookahead = (config.lookahead_days as number | undefined) ?? 7;

      // UTC midnight for "today" so day arithmetic stays stable across DST.
      const now = new Date();
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const todayYmd = ymd(today);

      const all: UpcomingPickup[] = [];
      for (const sched of schedules) {
        const picks = nextPickups(sched, today, lookahead);
        for (const p of picks) {
          const days = daysBetween(todayYmd, p.date);
          all.push({
            ...p,
            daysFromNow: days,
            whenLabel: whenLabel(days, p.dayOfWeek),
          });
        }
      }

      // Sort by date ascending
      all.sort((a, b) => a.date.localeCompare(b.date));

      const todayPickups = all.filter((p) => p.daysFromNow === 0).map((p) => p.name);
      const tomorrowPickups = all.filter((p) => p.daysFromNow === 1).map((p) => p.name);

      return {
        source: 'garbage_recycling',
        description:
          'Trash/recycling pickup schedule. ' +
          (todayPickups.length
            ? `TODAY: ${todayPickups.join(', ')}. Surface in Executive Brief — they need to put bins out tonight or this morning. `
            : '') +
          (tomorrowPickups.length
            ? `TOMORROW: ${tomorrowPickups.join(', ')}. Mention in Executive Brief or Tasks — bins need to go out tonight. `
            : '') +
          'Otherwise mention only if relevant to today (e.g. "Recycling Thursday"). ' +
          'Use upcoming[] for the next 7 days of pickups.',
        data: {
          today: todayPickups,
          tomorrow: tomorrowPickups,
          upcoming: all,
        },
        priorityHint: todayPickups.length || tomorrowPickups.length ? 'high' : 'normal',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const schedules = config.schedules as ScheduleConfig[] | undefined;

  if (!schedules || !Array.isArray(schedules) || schedules.length === 0) {
    checks.push([FAIL, 'No schedules configured', 'Add at least one weekly or biweekly schedule']);
    return checks;
  }

  for (const sched of schedules) {
    if (!sched.name) {
      checks.push([FAIL, 'Schedule missing name', '']);
      continue;
    }
    if ('weekly' in sched) {
      try {
        dayIndex(sched.weekly);
        checks.push([PASS, `${sched.name}: weekly on ${sched.weekly}`, '']);
      } catch (e) {
        checks.push([FAIL, `${sched.name}: invalid weekly day`, String(e)]);
      }
    } else if ('biweekly' in sched) {
      try {
        nextPickups(sched, new Date(), 14);
        checks.push([
          PASS,
          `${sched.name}: biweekly ${sched.biweekly.day} (anchor ${sched.biweekly.anchor})`,
          '',
        ]);
      } catch (e) {
        checks.push([FAIL, `${sched.name}: invalid biweekly config`, String(e)]);
      }
    } else {
      checks.push([
        FAIL,
        `${(sched as { name: string }).name}: missing 'weekly' or 'biweekly'`,
        '',
      ]);
    }
  }

  const lookahead = (config.lookahead_days as number | undefined) ?? 7;
  checks.push([INFO, `Lookahead: ${lookahead} days`, '']);

  return checks;
}
