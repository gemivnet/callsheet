import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { google } from "googleapis";
import type { Connector, ConnectorConfig, ConnectorResult, Check, ConnectorAuth } from "../types.js";
import { PASS, FAIL, WARN, INFO } from "../test-icons.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

function loadOAuth2(credsDir: string, credsFile = "credentials.json") {
  const credsPath = join(credsDir, credsFile);
  if (!existsSync(credsPath))
    throw new Error(`${credsFile} not found at ${credsPath}`);

  const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
  const { client_id, client_secret, redirect_uris } =
    creds.installed ?? creds.web;
  return new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0],
  );
}

function getCredentials(credsDir: string, tokenFile: string, credsFile?: string) {
  const tokenPath = join(credsDir, tokenFile);
  const oauth2 = loadOAuth2(credsDir, credsFile);

  if (existsSync(tokenPath)) {
    oauth2.setCredentials(JSON.parse(readFileSync(tokenPath, "utf-8")));
  } else {
    throw new Error(
      `No valid Google Calendar credentials at ${tokenPath}. Run: callsheet --auth google_calendar:<account_name>`,
    );
  }

  return oauth2;
}

export async function auth(credsDir: string, accountName?: string, credsFile?: string): Promise<void> {
  const tokenFile = accountName
    ? `token_calendar_${accountName.toLowerCase()}.json`
    : "token_calendar.json";
  const tokenPath = join(credsDir, tokenFile);
  const oauth2 = loadOAuth2(credsDir, credsFile);

  // Override redirect for local server
  (oauth2 as unknown as { redirectUri: string }).redirectUri = "http://localhost:3000/oauth2callback";

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });

  console.log(
    accountName
      ? `Authorizing Google Calendar for "${accountName}"...`
      : "Authorizing Google Calendar...",
  );
  console.log("Visit:", authUrl);

  const server = createServer();
  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url!, "http://localhost:3000");
      const c = url.searchParams.get("code");
      if (c) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Auth complete! You can close this tab.</h1>");
        resolve(c);
      } else {
        res.writeHead(400);
        res.end("No code found");
      }
    });
    server.listen(3000);
    setTimeout(() => reject(new Error("Auth timeout (2 min)")), 120_000);
  });

  server.close();

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  mkdirSync(credsDir, { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`Google Calendar auth complete. Token saved to ${tokenPath}`);
}

interface CalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
}

interface CalendarAccount {
  name: string;
  credentials_file?: string;
  token_file?: string;
  calendar_ids?: string[];
}

function simplifyEvent(e: CalendarEvent) {
  const start = e.start ?? {};
  const end = e.end ?? {};
  return {
    summary: e.summary ?? "(no title)",
    start: start.dateTime ?? start.date ?? "",
    end: end.dateTime ?? end.date ?? "",
    location: e.location ?? "",
    description: (e.description ?? "").slice(0, 200),
    allDay: "date" in start && !("dateTime" in start),
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
  const calendar = google.calendar({ version: "v3", auth: oauth2 });

  const allEvents: CalendarEvent[] = [];
  for (const calId of calendarIds) {
    try {
      const result = await calendar.events.list({
        calendarId: calId,
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });
      allEvents.push(
        ...((result.data.items ?? []) as CalendarEvent[]),
      );
    } catch (e) {
      console.log(
        `  Warning: Failed to fetch calendar ${calId}: ${e}`,
      );
    }
  }

  return allEvents;
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: "google_calendar",
    description: "Google Calendar — today's schedule and upcoming events",

    async fetch(): Promise<ConnectorResult> {
      const credsDir = (config.credentials_dir as string) ?? "secrets";
      const lookahead = (config.lookahead_days as number) ?? 7;
      const accounts = config.accounts as CalendarAccount[] | undefined;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayEnd = new Date(today);
      todayEnd.setHours(23, 59, 59, 999);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const lookaheadEnd = new Date(today);
      lookaheadEnd.setDate(lookaheadEnd.getDate() + lookahead);

      let allTodayEvents: CalendarEvent[] = [];
      let allUpcomingEvents: CalendarEvent[] = [];

      if (accounts && accounts.length > 0) {
        // Multi-account mode
        for (const acct of accounts) {
          const tokenFile =
            acct.token_file ??
            `token_calendar_${acct.name.toLowerCase()}.json`;
          const calIds = acct.calendar_ids ?? ["primary"];

          const todayEvents = await fetchAccountEvents(
            credsDir, tokenFile, calIds, today, todayEnd,
            acct.credentials_file,
          );
          const upcomingEvents = await fetchAccountEvents(
            credsDir, tokenFile, calIds, tomorrow, lookaheadEnd,
            acct.credentials_file,
          );

          allTodayEvents.push(...todayEvents);
          allUpcomingEvents.push(...upcomingEvents);
        }
      } else {
        // Legacy single-account mode
        const credsFile = config.credentials_file as string | undefined;
        const tokenFile = "token_calendar.json";
        const calIds = (config.calendar_ids as string[]) ?? ["primary"];

        allTodayEvents = await fetchAccountEvents(
          credsDir, tokenFile, calIds, today, todayEnd, credsFile,
        );
        allUpcomingEvents = await fetchAccountEvents(
          credsDir, tokenFile, calIds, tomorrow, lookaheadEnd, credsFile,
        );
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
            const aStart = a.start?.dateTime ?? a.start?.date ?? "";
            const bStart = b.start?.dateTime ?? b.start?.date ?? "";
            return aStart.localeCompare(bStart);
          });
      }

      const todayEvents = dedupeAndSort(allTodayEvents);
      const upcomingEvents = dedupeAndSort(allUpcomingEvents);

      return {
        source: "google_calendar",
        description:
          `Google Calendar events. 'today' has ${todayEvents.length} events. ` +
          `'upcoming' has ${upcomingEvents.length} events over the next ${lookahead} days. ` +
          "Use today's events for the schedule section. Use upcoming for the lookahead section — " +
          "highlight things that need preparation.",
        data: {
          today: todayEvents.map(simplifyEvent),
          upcoming: upcomingEvents.map(simplifyEvent),
        },
        priorityHint: "high",
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const credsDir = (config.credentials_dir as string) ?? "secrets";
  const accounts = config.accounts as CalendarAccount[] | undefined;

  if (accounts && accounts.length > 0) {
    checks.push([PASS, `${accounts.length} account(s) configured`, ""]);
    for (const acct of accounts) {
      const credsFile = acct.credentials_file ?? "credentials.json";
      const credsPath = join(credsDir, credsFile);
      checks.push(
        existsSync(credsPath)
          ? [PASS, `${acct.name}: ${credsFile} found`, ""]
          : [FAIL, `${acct.name}: ${credsFile} NOT found`, credsPath],
      );
      const tokenFile = acct.token_file ?? `token_calendar_${acct.name.toLowerCase()}.json`;
      const tokenPath = join(credsDir, tokenFile);
      if (existsSync(tokenPath)) {
        checks.push([PASS, `${acct.name}: ${tokenFile} found`, ""]);
        try {
          const data = JSON.parse(readFileSync(tokenPath, "utf-8"));
          checks.push(
            data.refresh_token
              ? [PASS, `${acct.name}: Refresh token present`, ""]
              : [WARN, `${acct.name}: No refresh token`, "Token may expire"],
          );
        } catch (e) {
          checks.push([FAIL, `${acct.name}: Token file corrupted`, String(e)]);
        }
      } else {
        checks.push([FAIL, `${acct.name}: ${tokenFile} NOT found`, `Run: callsheet --auth google_calendar:${acct.name.toLowerCase()}`]);
      }

      const calIds = acct.calendar_ids ?? ["primary"];
      checks.push([INFO, `${acct.name}: ${calIds.length} calendar(s)`, ""]);
      for (const cid of calIds) checks.push([INFO, `  → ${cid}`, ""]);
    }
  } else {
    // Legacy single-account validation
    const credsFileName = (config.credentials_file as string) ?? "credentials.json";
    const credsFile = join(credsDir, credsFileName);
    const tokenFile = join(credsDir, "token_calendar.json");

    checks.push(
      existsSync(credsFile)
        ? [PASS, `${credsFileName} found`, credsFile]
        : [FAIL, `${credsFileName} NOT found`, `Expected at ${credsFile}`],
    );

    if (existsSync(tokenFile)) {
      checks.push([PASS, "token_calendar.json found (OAuth complete)", tokenFile]);
      try {
        const data = JSON.parse(readFileSync(tokenFile, "utf-8"));
        checks.push(
          data.refresh_token
            ? [PASS, "Refresh token present", "Token can auto-renew"]
            : [WARN, "No refresh token", "Token may expire"],
        );
      } catch (e) {
        checks.push([FAIL, "Token file corrupted", String(e)]);
      }
    } else {
      checks.push([FAIL, "token_calendar.json NOT found", "Run: callsheet --auth google_calendar"]);
    }

    const calIds = (config.calendar_ids as string[]) ?? [];
    if (!calIds.length) {
      checks.push([FAIL, "No calendar IDs configured", "Add at least 'primary'"]);
    } else {
      checks.push([PASS, `${calIds.length} calendar(s) configured`, ""]);
      for (const cid of calIds) checks.push([INFO, `  → ${cid}`, ""]);
    }
  }

  return checks;
}

export const authFromConfig: ConnectorAuth = async (credsDir, config, accountName) => {
  const accounts = (config.accounts as CalendarAccount[] | undefined) ?? [];
  const matchedAcct = accountName
    ? accounts.find((a) => a.name.toLowerCase() === accountName.toLowerCase())
    : undefined;
  const credsFile = matchedAcct?.credentials_file
    ?? (config.credentials_file as string)
    ?? undefined;
  await auth(credsDir, accountName, credsFile);
};
