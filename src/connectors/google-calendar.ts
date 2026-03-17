import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { google } from "googleapis";
import type { Connector, ConnectorConfig, ConnectorResult, Check } from "../types.js";
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

function getCredentials(credsDir: string, credsFile?: string) {
  const tokenPath = join(credsDir, "token_calendar.json");
  const oauth2 = loadOAuth2(credsDir, credsFile);

  if (existsSync(tokenPath)) {
    oauth2.setCredentials(JSON.parse(readFileSync(tokenPath, "utf-8")));
  } else {
    throw new Error(
      "No valid Google Calendar credentials. Run: callsheet --auth google_calendar",
    );
  }

  return oauth2;
}

export async function auth(credsDir: string, credsFile?: string): Promise<void> {
  const tokenPath = join(credsDir, "token_calendar.json");
  const oauth2 = loadOAuth2(credsDir, credsFile);

  // Override redirect for local server
  (oauth2 as unknown as { redirectUri: string }).redirectUri = "http://localhost:3000/oauth2callback";

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });

  console.log("Authorize this app by visiting:", authUrl);

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
  console.log("Google Calendar auth complete.");
}

interface CalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
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

export function create(config: ConnectorConfig): Connector {
  return {
    name: "google_calendar",
    description: "Google Calendar — today's schedule and upcoming events",

    async fetch(): Promise<ConnectorResult> {
      const credsDir = (config.credentials_dir as string) ?? "secrets";
      const credsFile = config.credentials_file as string | undefined;
      const oauth2 = getCredentials(credsDir, credsFile);
      const calendar = google.calendar({ version: "v3", auth: oauth2 });

      const calendarIds = (config.calendar_ids as string[]) ?? ["primary"];
      const lookahead = (config.lookahead_days as number) ?? 7;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayEnd = new Date(today);
      todayEnd.setHours(23, 59, 59, 999);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const lookaheadEnd = new Date(today);
      lookaheadEnd.setDate(lookaheadEnd.getDate() + lookahead);

      async function fetchRange(
        startDate: Date,
        endDate: Date,
      ): Promise<CalendarEvent[]> {
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

        const seen = new Set<string>();
        return allEvents
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

      const todayEvents = await fetchRange(today, todayEnd);
      const upcomingEvents = await fetchRange(tomorrow, lookaheadEnd);

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
    for (const cid of calIds) checks.push([INFO, `  \u2192 ${cid}`, ""]);
  }

  return checks;
}
