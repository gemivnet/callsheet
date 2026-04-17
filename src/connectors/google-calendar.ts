import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { google } from 'googleapis';
import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, WARN, INFO } from '../test-icons.js';
import {
  getCredentials,
  resolveCredsFile,
  makeAuthFromConfig,
  type GoogleAccount,
} from './google-auth.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

interface CalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
}

interface CalendarAccount extends GoogleAccount {
  calendar_ids?: string[];
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Format an ISO date/time (or all-day date) into human-friendly fields in a
 * specific IANA timezone. Returns:
 *   - date:          YYYY-MM-DD in the target TZ
 *   - dayOfWeek:     e.g. "Monday"
 *   - timeLabel:     e.g. "7:00 AM" — null for all-day events
 *
 * The reason this matters: the daily brief LLM was labeling April 20 as
 * "Sunday" and April 21 as "Monday" — both wrong by one day. The raw ISO
 * strings were correct, but the model guessed the weekday instead of
 * computing it, and got it consistently wrong. Pre-computing the day name
 * here removes that failure mode entirely.
 */
export function formatInTz(
  isoOrDate: string,
  tz: string,
  isAllDay: boolean,
): { date: string; dayOfWeek: string; timeLabel: string | null } {
  // All-day events come through as "YYYY-MM-DD". These are timezone-agnostic —
  // the weekday is inherent to the date. Anchor at noon UTC so local-TZ
  // formatting can't tip it to the adjacent day anywhere on earth.
  if (isAllDay) {
    const [y, m, d] = isoOrDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    return {
      date: isoOrDate,
      dayOfWeek: WEEKDAY_NAMES[dt.getUTCDay()],
      timeLabel: null,
    };
  }

  const dt = new Date(isoOrDate);
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const weekdayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
  });
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return {
    date: dateFmt.format(dt), // en-CA gives YYYY-MM-DD
    dayOfWeek: weekdayFmt.format(dt),
    timeLabel: timeFmt.format(dt),
  };
}

/**
 * Compute a plain-English "when" phrase relative to today. Callers pass
 * today's YYYY-MM-DD (in the same timezone the event was formatted in)
 * and the event's YYYY-MM-DD. Returns e.g. "today", "tomorrow", "yesterday",
 * "this Monday (in 4 days)", "last Wednesday (3 days ago)".
 *
 * Having this pre-computed means the LLM can't mis-derive the weekday or
 * count days — a regression that shipped a whole day-off brief in prod
 * before this fix.
 */
export function relativeDayLabel(todayYmd: string, eventYmd: string, dayOfWeek: string): string {
  const today = Date.UTC(
    Number(todayYmd.slice(0, 4)),
    Number(todayYmd.slice(5, 7)) - 1,
    Number(todayYmd.slice(8, 10)),
  );
  const ev = Date.UTC(
    Number(eventYmd.slice(0, 4)),
    Number(eventYmd.slice(5, 7)) - 1,
    Number(eventYmd.slice(8, 10)),
  );
  const diff = Math.round((ev - today) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff <= 6) return `${dayOfWeek} (in ${diff} days)`;
  if (diff > 6) return `${dayOfWeek} ${eventYmd} (in ${diff} days)`;
  if (diff < -1 && diff >= -6) return `last ${dayOfWeek} (${-diff} days ago)`;
  return `${dayOfWeek} ${eventYmd} (${-diff} days ago)`;
}

function simplifyEvent(e: CalendarEvent, tz: string, todayYmd: string) {
  const start = e.start ?? {};
  const end = e.end ?? {};
  const rawStart = start.dateTime ?? start.date ?? '';
  const rawEnd = end.dateTime ?? end.date ?? '';
  const allDay = 'date' in start && !('dateTime' in start);

  let dayOfWeek: string | undefined;
  let dateLabel: string | undefined;
  let timeLabel: string | null = null;
  let whenLabel: string | undefined;
  if (rawStart) {
    const fmt = formatInTz(rawStart, tz, allDay);
    dayOfWeek = fmt.dayOfWeek;
    dateLabel = fmt.date;
    timeLabel = fmt.timeLabel;
    whenLabel = relativeDayLabel(todayYmd, dateLabel, dayOfWeek);
  }

  return {
    summary: e.summary ?? '(no title)',
    start: rawStart,
    end: rawEnd,
    location: e.location ?? '',
    description: (e.description ?? '').slice(0, 200),
    allDay,
    // Pre-computed so the brief writer never has to derive weekday from an
    // ISO string — that's where the April-20-labelled-Sunday bug came from.
    date: dateLabel,
    dayOfWeek,
    timeLabel,
    whenLabel,
  };
}

async function fetchAccountEvents(
  credsDir: string,
  tokenFile: string,
  calendarIds: string[],
  startDate: Date,
  endDate: Date,
  credsFile?: string,
): Promise<CalendarEvent[]> {
  const oauth2 = getCredentials(credsDir, tokenFile, credsFile);
  const calendar = google.calendar({ version: 'v3', auth: oauth2 });

  const allEvents: CalendarEvent[] = [];
  for (const calId of calendarIds) {
    try {
      const result = await calendar.events.list({
        calendarId: calId,
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      allEvents.push(...((result.data.items ?? []) as CalendarEvent[]));
    } catch (e) {
      console.log(`  Warning: Failed to fetch calendar ${calId}: ${e}`);
    }
  }

  return allEvents;
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'google_calendar',
    description: "Google Calendar — today's schedule and upcoming events",

    async fetch(): Promise<ConnectorResult> {
      const credsDir = (config.credentials_dir as string) ?? 'secrets';
      const lookahead = (config.lookahead_days as number) ?? 7;
      const lookback = (config.lookback_days as number) ?? 0;
      const accounts = config.accounts as CalendarAccount[] | undefined;
      const tz =
        (config.timezone as string) ??
        process.env.TZ ??
        Intl.DateTimeFormat().resolvedOptions().timeZone;

      // "Today" for the brief is local-wall-clock today in the configured TZ,
      // not UTC. If we used UTC here, a brief running at 4 AM CT on Monday
      // (9 AM UTC — still Monday there) would work, but at 10 PM CT on
      // Sunday (3 AM UTC Monday) we'd call Sunday's brief "Monday". Forcing
      // en-CA gives us a clean YYYY-MM-DD in the target TZ.
      const todayYmd = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayEnd = new Date(today);
      todayEnd.setHours(23, 59, 59, 999);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const lookaheadEnd = new Date(today);
      lookaheadEnd.setDate(lookaheadEnd.getDate() + lookahead);
      const lookbackStart = new Date(today);
      lookbackStart.setDate(lookbackStart.getDate() - lookback);

      let allTodayEvents: CalendarEvent[] = [];
      let allUpcomingEvents: CalendarEvent[] = [];
      let allRecentEvents: CalendarEvent[] = [];

      if (accounts && accounts.length > 0) {
        // Multi-account mode
        for (const acct of accounts) {
          const tokenFile = acct.token_file ?? `token_calendar_${acct.name.toLowerCase()}.json`;
          const calIds = acct.calendar_ids ?? ['primary'];

          const credsFile = resolveCredsFile(acct, config);
          const todayEvents = await fetchAccountEvents(
            credsDir,
            tokenFile,
            calIds,
            today,
            todayEnd,
            credsFile,
          );
          const upcomingEvents = await fetchAccountEvents(
            credsDir,
            tokenFile,
            calIds,
            tomorrow,
            lookaheadEnd,
            credsFile,
          );

          allTodayEvents.push(...todayEvents);
          allUpcomingEvents.push(...upcomingEvents);

          if (lookback > 0) {
            const recent = await fetchAccountEvents(
              credsDir,
              tokenFile,
              calIds,
              lookbackStart,
              today,
              credsFile,
            );
            allRecentEvents.push(...recent);
          }
        }
      } else {
        // Legacy single-account mode
        const credsFile = config.credentials_file as string | undefined;
        const tokenFile = 'token_calendar.json';
        const calIds = (config.calendar_ids as string[]) ?? ['primary'];

        allTodayEvents = await fetchAccountEvents(
          credsDir,
          tokenFile,
          calIds,
          today,
          todayEnd,
          credsFile,
        );
        allUpcomingEvents = await fetchAccountEvents(
          credsDir,
          tokenFile,
          calIds,
          tomorrow,
          lookaheadEnd,
          credsFile,
        );
        if (lookback > 0) {
          allRecentEvents = await fetchAccountEvents(
            credsDir,
            tokenFile,
            calIds,
            lookbackStart,
            today,
            credsFile,
          );
        }
      }

      // Deduplicate by event ID and sort chronologically
      function dedupeAndSort(events: CalendarEvent[]): CalendarEvent[] {
        const seen = new Set<string>();
        return events
          .filter((e) => {
            if (seen.has(e.id)) return false;
            seen.add(e.id);
            return true;
          })
          .sort((a, b) => {
            const aStart = a.start?.dateTime ?? a.start?.date ?? '';
            const bStart = b.start?.dateTime ?? b.start?.date ?? '';
            return aStart.localeCompare(bStart);
          });
      }

      const todayEvents = dedupeAndSort(allTodayEvents);
      const upcomingEvents = dedupeAndSort(allUpcomingEvents);
      const recentEvents = dedupeAndSort(allRecentEvents);

      const data: Record<string, unknown> = {
        timezone: tz,
        today_ymd: todayYmd,
        today: todayEvents.map((e) => simplifyEvent(e, tz, todayYmd)),
        upcoming: upcomingEvents.map((e) => simplifyEvent(e, tz, todayYmd)),
      };
      if (lookback > 0) {
        data.recent = recentEvents.map((e) => simplifyEvent(e, tz, todayYmd));
      }

      return {
        source: 'google_calendar',
        description:
          `Google Calendar events. 'today' has ${todayEvents.length} events. ` +
          `'upcoming' has ${upcomingEvents.length} events over the next ${lookahead} days. ` +
          (lookback > 0
            ? `'recent' has ${recentEvents.length} events from the past ${lookback} days (for week-in-review). `
            : '') +
          "Use today's events for the schedule section. Use upcoming for the lookahead section — " +
          'highlight things that need preparation. ' +
          "**CRITICAL: always use each event's pre-computed `dayOfWeek`, `date`, `timeLabel`, and `whenLabel` fields. " +
          'Do NOT derive weekday names from raw ISO `start`/`end` strings — that math has been wrong before ' +
          '(April 20 was labeled "Sunday" when it was Monday). The pre-computed fields are authoritative ' +
          `and already resolved in the configured timezone (${tz}).**`,
        data,
        priorityHint: 'high',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const credsDir = (config.credentials_dir as string) ?? 'secrets';
  const accounts = config.accounts as CalendarAccount[] | undefined;

  if (accounts && accounts.length > 0) {
    checks.push([PASS, `${accounts.length} account(s) configured`, '']);
    for (const acct of accounts) {
      const credsFile = resolveCredsFile(acct, config) ?? 'credentials.json';
      const credsPath = join(credsDir, credsFile);
      checks.push(
        existsSync(credsPath)
          ? [PASS, `${acct.name}: ${credsFile} found`, '']
          : [FAIL, `${acct.name}: ${credsFile} NOT found`, credsPath],
      );
      const tokenFile = acct.token_file ?? `token_calendar_${acct.name.toLowerCase()}.json`;
      const tokenPath = join(credsDir, tokenFile);
      if (existsSync(tokenPath)) {
        checks.push([PASS, `${acct.name}: ${tokenFile} found`, '']);
        try {
          const data = JSON.parse(readFileSync(tokenPath, 'utf-8'));
          checks.push(
            data.refresh_token
              ? [PASS, `${acct.name}: Refresh token present`, '']
              : [WARN, `${acct.name}: No refresh token`, 'Token may expire'],
          );
        } catch (e) {
          checks.push([FAIL, `${acct.name}: Token file corrupted`, String(e)]);
        }
      } else {
        checks.push([
          FAIL,
          `${acct.name}: ${tokenFile} NOT found`,
          `Run: callsheet --auth google_calendar:${acct.name.toLowerCase()}`,
        ]);
      }

      const calIds = acct.calendar_ids ?? ['primary'];
      checks.push([INFO, `${acct.name}: ${calIds.length} calendar(s)`, '']);
      for (const cid of calIds) checks.push([INFO, `  → ${cid}`, '']);
    }
  } else {
    // Legacy single-account validation
    const credsFileName = (config.credentials_file as string) ?? 'credentials.json';
    const credsFile = join(credsDir, credsFileName);
    const tokenFile = join(credsDir, 'token_calendar.json');

    checks.push(
      existsSync(credsFile)
        ? [PASS, `${credsFileName} found`, credsFile]
        : [FAIL, `${credsFileName} NOT found`, `Expected at ${credsFile}`],
    );

    if (existsSync(tokenFile)) {
      checks.push([PASS, 'token_calendar.json found (OAuth complete)', tokenFile]);
      try {
        const data = JSON.parse(readFileSync(tokenFile, 'utf-8'));
        checks.push(
          data.refresh_token
            ? [PASS, 'Refresh token present', 'Token can auto-renew']
            : [WARN, 'No refresh token', 'Token may expire'],
        );
      } catch (e) {
        checks.push([FAIL, 'Token file corrupted', String(e)]);
      }
    } else {
      checks.push([FAIL, 'token_calendar.json NOT found', 'Run: callsheet --auth google_calendar']);
    }

    const calIds = (config.calendar_ids as string[]) ?? [];
    if (!calIds.length) {
      checks.push([FAIL, 'No calendar IDs configured', "Add at least 'primary'"]);
    } else {
      checks.push([PASS, `${calIds.length} calendar(s) configured`, '']);
      for (const cid of calIds) checks.push([INFO, `  → ${cid}`, '']);
    }
  }

  return checks;
}

export const authFromConfig = makeAuthFromConfig(SCOPES, 'Google Calendar', 'token_calendar');
