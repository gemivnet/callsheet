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

function simplifyEvent(e: CalendarEvent) {
  const start = e.start ?? {};
  const end = e.end ?? {};
  return {
    summary: e.summary ?? '(no title)',
    start: start.dateTime ?? start.date ?? '',
    end: end.dateTime ?? end.date ?? '',
    location: e.location ?? '',
    description: (e.description ?? '').slice(0, 200),
    allDay: 'date' in start && !('dateTime' in start),
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
        today: todayEvents.map(simplifyEvent),
        upcoming: upcomingEvents.map(simplifyEvent),
      };
      if (lookback > 0) {
        data.recent = recentEvents.map(simplifyEvent);
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
          'highlight things that need preparation.',
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
