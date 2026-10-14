import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { google } from 'googleapis';
import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, WARN, INFO } from '../test-icons.js';
import { todayYmd, shiftYmd, zonedDayStart } from '../dates.js';
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

/** An event plus the household member(s) whose calendar it appeared on. */
interface TaggedEvent extends CalendarEvent {
  people?: string[];
}

/** Optional config: label events matching a regex so they can be counted. */
export interface EventCategory {
  label: string;
  pattern: string;
}

interface FetchOutcome {
  events: CalendarEvent[];
  errors: string[];
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

/**
 * Who an event is about, from its title.
 *
 * `people` used to be whoever's calendar the event sat on, so a household
 * member with no calendar of their own vanished into whoever carried their
 * events: "Name: Practice" on a parent's calendar was printed as the parent's
 * practice. A title that starts with a household member's name (followed by a
 * colon or a space) is that member's event; the calendar owners are kept
 * separately so the brief can still see whose calendar holds it.
 */
export function attributeByTitle(
  summary: string,
  owners: string[] | undefined,
  householdNames: string[],
): { people?: string[]; onCalendarOf?: string[] } {
  const title = summary.trimStart().toLowerCase();
  const named = householdNames.find((n) => {
    const lower = n.toLowerCase();
    return title.startsWith(`${lower}:`) || title.startsWith(`${lower} `);
  });
  if (!named || (owners?.length === 1 && owners[0] === named)) return { people: owners };
  return { people: [named], onCalendarOf: owners };
}

/**
 * The span of an all-day event. Google's `end.date` is EXCLUSIVE — an event on
 * Friday through Sunday ends "Monday" — and passing it through raw had briefs
 * announcing that a weekend away lasted until Monday.
 */
export function allDaySpan(
  startYmd: string,
  endYmdExclusive: string,
  todayYmd: string,
): {
  lastDay: string;
  spanDays: number;
  spanLabel?: string;
  ongoing?: boolean;
  dayOfSpan?: string;
} {
  const lastDay = endYmdExclusive > startYmd ? shiftYmd(endYmdExclusive, -1) : startYmd;
  const spanDays =
    Math.round(
      (Date.UTC(+lastDay.slice(0, 4), +lastDay.slice(5, 7) - 1, +lastDay.slice(8, 10)) -
        Date.UTC(+startYmd.slice(0, 4), +startYmd.slice(5, 7) - 1, +startYmd.slice(8, 10))) /
        86_400_000,
    ) + 1;
  if (spanDays <= 1) return { lastDay, spanDays };
  const day = (ymd: string) => formatInTz(ymd, 'UTC', true).dayOfWeek.slice(0, 3);
  const out: ReturnType<typeof allDaySpan> = {
    lastDay,
    spanDays,
    spanLabel: `${day(startYmd)} ${startYmd} – ${day(lastDay)} ${lastDay} (${spanDays} days)`,
  };
  if (startYmd <= todayYmd && todayYmd <= lastDay) {
    out.ongoing = startYmd < todayYmd;
    const n =
      Math.round(
        (Date.UTC(+todayYmd.slice(0, 4), +todayYmd.slice(5, 7) - 1, +todayYmd.slice(8, 10)) -
          Date.UTC(+startYmd.slice(0, 4), +startYmd.slice(5, 7) - 1, +startYmd.slice(8, 10))) /
          86_400_000,
      ) + 1;
    out.dayOfSpan = `day ${n} of ${spanDays}`;
  }
  return out;
}

/** A timed event reduced to what overlap and free-time checks need. */
export interface TimedSlot {
  summary: string;
  people: string[];
  startMs: number;
  endMs: number;
  date: string;
  timeLabel: string;
  endTimeLabel: string;
}

/**
 * Overlapping timed events for the same person, computed here so the brief
 * reports real conflicts only. Left to the writer it both missed real overlaps
 * and invented them between two different people's events.
 */
export function findConflicts(slots: TimedSlot[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const people = [...new Set(slots.flatMap((s) => s.people))];
  for (const person of people) {
    const mine = slots
      .filter((s) => s.people.includes(person))
      .sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length && mine[j].startMs < mine[i].endMs; j++) {
        const overlap = Math.min(mine[i].endMs, mine[j].endMs) - mine[j].startMs;
        if (overlap <= 0) continue;
        out.push({
          person,
          date: mine[i].date,
          first: `${mine[i].summary} ${mine[i].timeLabel}–${mine[i].endTimeLabel}`,
          second: `${mine[j].summary} ${mine[j].timeLabel}–${mine[j].endTimeLabel}`,
          overlapMinutes: Math.round(overlap / 60_000),
        });
      }
    }
  }
  return out;
}

/**
 * Each person's open stretches today between `dayStartMs` and `dayEndMs`, at
 * least `minMinutes` long, as "12:00 PM–3:30 PM" labels. This is what lets
 * the brief suggest when to do a task instead of only listing it.
 */
export function freeWindows(
  slots: TimedSlot[],
  people: string[],
  dayStartMs: number,
  dayEndMs: number,
  tz: string,
  minMinutes = 45,
  nowMs?: number,
): Record<string, string[]> {
  const fmt = (ms: number) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(ms));
  const out: Record<string, string[]> = {};
  const from = Math.max(dayStartMs, nowMs ?? dayStartMs);
  for (const person of people) {
    const busy = slots
      .filter((s) => s.people.includes(person) && s.endMs > from && s.startMs < dayEndMs)
      .sort((a, b) => a.startMs - b.startMs);
    const windows: string[] = [];
    let cursor = from;
    for (const b of busy) {
      if (b.startMs - cursor >= minMinutes * 60_000) {
        windows.push(`${fmt(cursor)}–${fmt(b.startMs)}`);
      }
      cursor = Math.max(cursor, b.endMs);
    }
    if (dayEndMs - cursor >= minMinutes * 60_000) windows.push(`${fmt(cursor)}–${fmt(dayEndMs)}`);
    out[person] = windows;
  }
  return out;
}

/**
 * Generic medical vocabulary: a clinician, a credential, a specialty, a
 * procedure or a place of care. The page sits on a kitchen counter, and the
 * writer, told never to print these, still printed a clinician's name and the
 * kind of appointment. Matching titles never reach it.
 */
const HEALTH_TITLE = [
  /\b(?:dr\.?|doctor)\s/i,
  /,\s*(?:M\.?D|D\.?O|D\.?D\.?S|D\.?M\.?D|Psy\.?\s?D|Ph\.?D|LCSW|LPC|LMFT|LMHC|PA-C|N\.?P|DPT|O\.?D)\b/,
  /\b(?:therap|counsel(?:l)?ing|psychiatr|psycholog|dentist|dental|orthodont|dermatolog|cardiolog|oncolog|neurolog|urolog|gastroenterolog|endocrinolog|rheumatolog|gyn|ob\/?gyn|obstetric|pediatric|podiatr|chiropract|optometr|ophthalmolog|physio|allerg|audiolog|radiolog|mammogra|colonoscop|endoscop|biops|ultrasound|bloodwork|infusion|vaccin|immuniz|clinic|hospital|surger|surgical|medical|telehealth|pharmac|prescription|dialysis|chemo)/i,
  /\b(?:mri|ct scan|x-?ray|blood (?:work|draw|test)|lab work|flu shot|urgent care|physical exam|check-?up|mental health|health cent(?:er|re)|post-op|pre-op)\b/i,
];
const HEALTH_PLACE =
  /\b(?:medical|clinic|hospital|urgent care|dental|surgery center|health cent(?:er|re))\b/i;
const ANIMAL_CARE = /\b(?:vet|veterinar\w*|animal|pets?|cats?|dogs?|kittens?|pupp(?:y|ies))\b/i;

/** What a health appointment is called on its way to the writer. */
export const PRIVATE_TITLE = 'Private appointment';

/**
 * True when an event is someone's health appointment: its title names medical
 * care, it takes place somewhere that does, or its title contains one of the
 * household's own `private_patterns` (a practice known only by its name). A
 * visit to the vet is not one.
 */
export function isHealthAppointment(
  title: string,
  location = '',
  privatePatterns: string[] = [],
): boolean {
  const lower = title.toLowerCase();
  if (privatePatterns.some((p) => p && lower.includes(p.toLowerCase()))) return true;
  if (ANIMAL_CARE.test(title)) return false;
  return HEALTH_TITLE.some((re) => re.test(title)) || HEALTH_PLACE.test(location);
}

function simplifyEvent(
  e: TaggedEvent,
  tz: string,
  todayYmd: string,
  householdNames: string[] = [],
  privatePatterns: string[] = [],
) {
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

  const title = e.summary ?? '(no title)';
  // Attribution reads the real title; everything after it sees the private one.
  const who = attributeByTitle(title, e.people, householdNames);
  const health = isHealthAppointment(title, e.location ?? '', privatePatterns);
  const summary = health ? PRIVATE_TITLE : title;
  const span = allDay && rawStart && rawEnd ? allDaySpan(rawStart, rawEnd, todayYmd) : undefined;
  const endTimeLabel =
    !allDay && rawEnd ? (formatInTz(rawEnd, tz, false).timeLabel ?? undefined) : undefined;

  return {
    summary,
    start: rawStart,
    end: rawEnd,
    location: health ? '' : (e.location ?? ''),
    description: health ? '' : (e.description ?? '').slice(0, 200),
    allDay,
    ...(health ? { health: true } : {}),
    // Who the event is for. An event on two people's calendars keeps both
    // names, so a shared appointment is one event attended by two people;
    // a title naming a household member makes it that member's.
    people: who.people,
    ...(who.onCalendarOf ? { onCalendarOf: who.onCalendarOf } : {}),
    ...(endTimeLabel ? { endTimeLabel } : {}),
    ...(span && span.spanDays > 1 ? span : {}),
    // Pre-computed so the brief writer never has to derive weekday from an
    // ISO string — that's where the April-20-labelled-Sunday bug came from.
    date: dateLabel,
    dayOfWeek,
    timeLabel,
    whenLabel,
  };
}

type SimplifiedEvent = ReturnType<typeof simplifyEvent>;

/**
 * Per-person event tallies computed here rather than left to the brief writer.
 *
 * A model asked to count rows in a JSON array gets it wrong often enough to
 * matter — it has undercounted a person's week by one and overcounted
 * another's in the same sentence, on data that was completely correct. The
 * weekday fields above exist for the same reason. Anything the brief states
 * as a number should be computed here and cited, not derived downstream.
 */
export function buildAggregates(
  buckets: { recent: SimplifiedEvent[]; today: SimplifiedEvent[]; upcoming: SimplifiedEvent[] },
  categories: EventCategory[],
): Record<string, unknown> {
  const byPerson: Record<string, Record<string, unknown>> = {};

  const ensure = (name: string): Record<string, unknown> => {
    byPerson[name] ??= { recent: 0, today: 0, upcoming: 0 };
    return byPerson[name];
  };

  for (const [bucket, events] of Object.entries(buckets)) {
    for (const ev of events) {
      for (const person of ev.people ?? []) {
        const rec = ensure(person);
        rec[bucket] = (rec[bucket] as number) + 1;

        for (const cat of categories) {
          let re: RegExp;
          try {
            re = new RegExp(cat.pattern, 'i');
          } catch {
            continue; // a bad pattern in config shouldn't take the brief down
          }
          if (re.test(`${ev.summary} ${ev.location}`)) {
            const key = `${bucket}_by_category`;
            const counts = (rec[key] ??= {}) as Record<string, number>;
            counts[cat.label] = (counts[cat.label] ?? 0) + 1;
          }
        }
      }
    }
  }

  return {
    by_person: byPerson,
    totals: {
      recent: buckets.recent.length,
      today: buckets.today.length,
      upcoming: buckets.upcoming.length,
    },
  };
}

/** Google caps a page at 250 events and signals more via nextPageToken. */
const PAGE_SIZE = 250;
const MAX_PAGES = 20;

async function fetchAccountEvents(
  credsDir: string,
  tokenFile: string,
  calendarIds: string[],
  startDate: Date,
  endDate: Date,
  credsFile?: string,
): Promise<FetchOutcome> {
  const oauth2 = getCredentials(credsDir, tokenFile, credsFile);
  const calendar = google.calendar({ version: 'v3', auth: oauth2 });

  const allEvents: CalendarEvent[] = [];
  const errors: string[] = [];
  for (const calId of calendarIds) {
    try {
      let pageToken: string | undefined;
      let pages = 0;
      do {
        const result = await calendar.events.list({
          calendarId: calId,
          timeMin: startDate.toISOString(),
          timeMax: endDate.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: PAGE_SIZE,
          pageToken,
        });
        allEvents.push(...((result.data.items ?? []) as CalendarEvent[]));
        pageToken = result.data.nextPageToken ?? undefined;
        pages += 1;
      } while (pageToken && pages < MAX_PAGES);

      if (pageToken) {
        errors.push(
          `${calId}: stopped paginating after ${MAX_PAGES} pages — events may be missing`,
        );
      }
    } catch (e) {
      // Surfaced in the payload as well as logged: a calendar that silently
      // stops loading looks identical to a quiet week in the finished brief.
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  Warning: Failed to fetch calendar ${calId}: ${msg}`);
      errors.push(`${calId}: ${msg}`);
    }
  }

  return { events: allEvents, errors };
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'google_calendar',
    description: "Google Calendar — today's schedule and upcoming events",

    async fetch(): Promise<ConnectorResult> {
      const credsDir = (config.credentials_dir as string) ?? 'secrets';
      const lookahead = (config.lookahead_days as number) ?? 7;
      // Past events are what a week-in-review and any per-person tally are
      // built from. Defaulting this to 0 meant the brief was asked to
      // summarise a week it could not see on six days out of seven.
      const lookback = (config.lookback_days as number) ?? 7;
      const accounts = config.accounts as CalendarAccount[] | undefined;
      const categories = (config.event_categories as EventCategory[] | undefined) ?? [];
      const householdNames = (config.household_names as string[] | undefined) ?? [];
      const privatePatterns = (config.private_patterns as string[] | undefined) ?? [];
      // Events that exist on the calendar for reference only (a team's whole
      // schedule, "not attending"). Printing them crowded out real plans and
      // produced invented conflicts with games nobody was going to.
      const excludePatterns = ((config.exclude_patterns as string[] | undefined) ?? []).flatMap(
        (p) => {
          try {
            return [new RegExp(p, 'i')];
          } catch {
            return [];
          }
        },
      );
      const dayStartHour = (config.day_start_hour as number | undefined) ?? 8;
      const dayEndHour = (config.day_end_hour as number | undefined) ?? 21;
      const tz =
        (config.timezone as string) ??
        process.env.TZ ??
        Intl.DateTimeFormat().resolvedOptions().timeZone;

      // "Today" for the brief is local-wall-clock today in the configured TZ,
      // not UTC. If we used UTC here, a brief running at 4 AM CT on Monday
      // (9 AM UTC — still Monday there) would work, but at 10 PM CT on
      // Sunday (3 AM UTC Monday) we'd call Sunday's brief "Monday".
      const today_ymd = todayYmd(tz);

      // Query boundaries follow the configured zone too. Using Date.setHours
      // here anchored the window to whatever timezone the process happened to
      // run in, so a UTC-defaulted container fetched a window offset from the
      // one whose labels the brief displayed.
      const today = zonedDayStart(today_ymd, tz);
      const tomorrow = zonedDayStart(shiftYmd(today_ymd, 1), tz);
      const todayEnd = new Date(tomorrow.getTime() - 1);
      const lookaheadEnd = zonedDayStart(shiftYmd(today_ymd, lookahead), tz);
      const lookbackStart = zonedDayStart(shiftYmd(today_ymd, -lookback), tz);

      const allTodayEvents: TaggedEvent[] = [];
      const allUpcomingEvents: TaggedEvent[] = [];
      const allRecentEvents: TaggedEvent[] = [];
      const fetchErrors: string[] = [];

      const tag = (events: CalendarEvent[], person?: string): TaggedEvent[] =>
        events.map((e) => ({ ...e, people: person ? [person] : undefined }));

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

          allTodayEvents.push(...tag(todayEvents.events, acct.name));
          allUpcomingEvents.push(...tag(upcomingEvents.events, acct.name));
          fetchErrors.push(
            ...[...todayEvents.errors, ...upcomingEvents.errors].map((m) => `${acct.name}/${m}`),
          );

          if (lookback > 0) {
            const recent = await fetchAccountEvents(
              credsDir,
              tokenFile,
              calIds,
              lookbackStart,
              today,
              credsFile,
            );
            allRecentEvents.push(...tag(recent.events, acct.name));
            fetchErrors.push(...recent.errors.map((m) => `${acct.name}/${m}`));
          }
        }
      } else {
        // Legacy single-account mode
        const credsFile = config.credentials_file as string | undefined;
        const tokenFile = 'token_calendar.json';
        const calIds = (config.calendar_ids as string[]) ?? ['primary'];

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
        allTodayEvents.push(...tag(todayEvents.events));
        allUpcomingEvents.push(...tag(upcomingEvents.events));
        fetchErrors.push(...todayEvents.errors, ...upcomingEvents.errors);

        if (lookback > 0) {
          const recent = await fetchAccountEvents(
            credsDir,
            tokenFile,
            calIds,
            lookbackStart,
            today,
            credsFile,
          );
          allRecentEvents.push(...tag(recent.events));
          fetchErrors.push(...recent.errors);
        }
      }

      // Merge duplicates by event ID, then sort chronologically.
      //
      // The same event on two household members' calendars is one event with
      // two attendees. Dropping the second copy (the old behaviour) lost the
      // fact that both people were there, so a shared commitment counted for
      // only one of them.
      function mergeAndSort(events: TaggedEvent[]): TaggedEvent[] {
        const byId = new Map<string, TaggedEvent>();
        for (const e of events) {
          const existing = byId.get(e.id);
          if (!existing) {
            byId.set(e.id, { ...e, people: e.people ? [...e.people] : undefined });
            continue;
          }
          for (const person of e.people ?? []) {
            existing.people ??= [];
            if (!existing.people.includes(person)) existing.people.push(person);
          }
        }
        return [...byId.values()].sort((a, b) => {
          const aStart = a.start?.dateTime ?? a.start?.date ?? '';
          const bStart = b.start?.dateTime ?? b.start?.date ?? '';
          return aStart.localeCompare(bStart);
        });
      }

      let omitted = 0;
      const keep = (events: TaggedEvent[]): TaggedEvent[] =>
        events.filter((e) => {
          const text = `${e.summary ?? ''} ${e.description ?? ''}`;
          const drop = excludePatterns.some((re) => re.test(text));
          if (drop) omitted++;
          return !drop;
        });
      const simplify = (e: TaggedEvent) =>
        simplifyEvent(e, tz, today_ymd, householdNames, privatePatterns);
      const todayEvents = keep(mergeAndSort(allTodayEvents)).map(simplify);
      const upcomingEvents = keep(mergeAndSort(allUpcomingEvents)).map(simplify);
      const recentEvents = keep(mergeAndSort(allRecentEvents)).map(simplify);

      const slots: TimedSlot[] = [...todayEvents, ...upcomingEvents]
        .filter((ev) => !ev.allDay && ev.start && ev.end && ev.people?.length)
        .map((ev) => ({
          summary: ev.summary,
          people: ev.people ?? [],
          startMs: new Date(ev.start).getTime(),
          endMs: new Date(ev.end).getTime(),
          date: ev.date ?? '',
          timeLabel: ev.timeLabel ?? '',
          endTimeLabel: ev.endTimeLabel ?? '',
        }));
      const conflicts = findConflicts(slots);
      const dayStart = zonedDayStart(today_ymd, tz).getTime();
      const roster = [...new Set([...(accounts ?? []).map((a) => a.name), ...householdNames])];
      // Count from now when the brief is written after the day has begun (a
      // dashboard regeneration in the afternoon), rounded up to the quarter
      // hour, so no stretch that has already passed is offered for a task.
      const nowMs = Math.ceil(Date.now() / 900_000) * 900_000;
      const freeToday = freeWindows(
        slots.filter((sl) => sl.date === today_ymd),
        roster,
        dayStart + dayStartHour * 3_600_000,
        dayStart + dayEndHour * 3_600_000,
        tz,
        45,
        nowMs,
      );

      const aggregates = buildAggregates(
        { recent: recentEvents, today: todayEvents, upcoming: upcomingEvents },
        categories,
      );
      aggregates.window = {
        recent_from: shiftYmd(today_ymd, -lookback),
        recent_to_exclusive: today_ymd,
        today: today_ymd,
        upcoming_through: shiftYmd(today_ymd, lookahead),
      };

      const data: Record<string, unknown> = {
        timezone: tz,
        today_ymd,
        today: todayEvents,
        upcoming: upcomingEvents,
        aggregates,
        conflicts,
        free_time_today: freeToday,
      };
      if (omitted > 0) data.omitted_reference_events = omitted;
      if (lookback > 0) {
        data.recent = recentEvents;
      }
      if (fetchErrors.length > 0) {
        data.fetch_errors = fetchErrors;
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
          "Each event's `people` array lists who the event is for: the household member named at " +
          "the start of its title, otherwise whoever's calendar holds it (`onCalendarOf` says whose " +
          'calendar it sits on when that differs). An event with two names is one shared commitment, ' +
          'not two. Never infer that someone attends an event from whose calendar it is on. ' +
          'Multi-day all-day events carry `lastDay`, `spanLabel` and, while running, `dayOfSpan` — ' +
          "use them; an all-day event's raw `end` is the day AFTER it ends. " +
          '`conflicts` lists overlapping events for the same person, computed from the times — report ' +
          "only those, and never treat two different people's events as a clash. " +
          "`free_time_today` lists each person's open stretches today, for suggesting when a task " +
          'fits. ' +
          `An event with \`health: true\` is a health appointment, renamed "${PRIVATE_TITLE}" with ` +
          'its place and notes removed: print it as "Appointment" with the person and time, and never ' +
          'guess what it is. ' +
          '**CRITICAL: any number you state about how many events someone had must be read from ' +
          '`aggregates.by_person`, which is computed from this data. Do NOT count events yourself — ' +
          'hand-counting has produced both over- and under-counts on correct data.** ' +
          "**Also always use each event's pre-computed `dayOfWeek`, `date`, `timeLabel`, and `whenLabel` fields. " +
          'Do NOT derive weekday names from raw ISO `start`/`end` strings — that math has been wrong before ' +
          '(April 20 was labeled "Sunday" when it was Monday). The pre-computed fields are authoritative ' +
          `and already resolved in the configured timezone (${tz}).**` +
          (fetchErrors.length > 0
            ? ` NOTE: ${fetchErrors.length} calendar(s) failed to load — see \`fetch_errors\`. Data may be incomplete.`
            : '') +
          (omitted > 0
            ? ` ${omitted} reference-only event(s) were left out on purpose; do not look for them.`
            : ''),
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
