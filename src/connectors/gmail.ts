import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { google } from "googleapis";
import type { Connector, ConnectorConfig, ConnectorResult, Check, ConnectorAuth } from "../types.js";
import { PASS, FAIL, INFO } from "../test-icons.js";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

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
      `No valid Gmail credentials at ${tokenPath}. Run: callsheet --auth gmail:<account_name>`,
    );
  }

  return oauth2;
}

export async function auth(credsDir: string, accountName?: string, credsFile?: string): Promise<void> {
  const tokenFile = accountName
    ? `token_gmail_${accountName.toLowerCase()}.json`
    : "token_gmail.json";
  const tokenPath = join(credsDir, tokenFile);
  const oauth2 = loadOAuth2(credsDir, credsFile);

  (oauth2 as unknown as { redirectUri: string }).redirectUri = "http://localhost:3000/oauth2callback";

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });

  console.log(
    accountName
      ? `Authorizing Gmail for "${accountName}"...`
      : "Authorizing Gmail...",
  );
  console.log("Visit:", authUrl);

  const server = createServer();
  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Auth timeout (2 min)")), 120_000);
    server.on("request", (req, res) => {
      const url = new URL(req.url!, "http://localhost:3000");
      const c = url.searchParams.get("code");
      if (c) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Auth complete! You can close this tab.</h1>");
        clearTimeout(timeout);
        resolve(c);
      } else {
        res.writeHead(400);
        res.end("No code found");
      }
    });
    server.listen(3000);
  });

  server.close(() => server.unref());

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  mkdirSync(credsDir, { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`Gmail auth complete. Token saved to ${tokenPath}`);
  process.exit(0);
}

interface GmailAccount {
  name: string;
  credentials_file?: string;
  token_file?: string;
}

/** Resolve credentials file for an account: account-level > connector-level > default */
function resolveCredsFile(acct: GmailAccount | undefined, config: ConnectorConfig): string | undefined {
  return acct?.credentials_file
    ?? (config.credentials_file as string | undefined)
    ?? undefined;
}

async function fetchAccount(
  credsDir: string,
  tokenFile: string,
  label: string,
  query: string,
  maxMessages: number,
  credsFile?: string,
): Promise<Record<string, unknown>> {
  const oauth2 = getCredentials(credsDir, tokenFile, credsFile);
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  // Ensure we search everywhere (inbox, trash, archive, etc.) so that
  // trashed/archived messages are still found.
  const effectiveQuery = query.includes("in:anywhere")
    ? query
    : `in:anywhere ${query}`;

  // Build a label ID → name map so we can return human-readable names
  const labelsRes = await gmail.users.labels.list({ userId: "me" });
  const allLabels = labelsRes.data.labels ?? [];
  const labelMap = new Map<string, string>();
  const userLabels: string[] = [];
  for (const l of allLabels) {
    if (l.id && l.name) {
      labelMap.set(l.id, l.name);
      if (l.type === "user") userLabels.push(l.name);
    }
  }

  const listResult = await gmail.users.messages.list({
    userId: "me",
    q: effectiveQuery,
    maxResults: maxMessages,
  });

  const messages = listResult.data.messages ?? [];
  const emails = [];

  for (const msgRef of messages) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: msgRef.id!,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers: Record<string, string> = {};
    for (const h of msg.data.payload?.headers ?? []) {
      headers[h.name!.toLowerCase()] = h.value!;
    }

    // Resolve label IDs to readable names, keep only user + UNREAD/IMPORTANT
    const rawLabels = msg.data.labelIds ?? [];
    const readableLabels = rawLabels
      .map((id) => labelMap.get(id) ?? id)
      .filter(
        (name) =>
          name === "UNREAD" ||
          name === "IMPORTANT" ||
          name === "TRASH" ||
          !name.startsWith("CATEGORY_") && !["INBOX", "SENT", "CHAT", "DRAFT", "SPAM", "TRASH", "STARRED", "YELLOW_STAR"].includes(name),
      );

    emails.push({
      from: headers.from ?? "",
      subject: headers.subject ?? "",
      date: headers.date ?? "",
      snippet: msg.data.snippet ?? "",
      labels: readableLabels,
      trashed: rawLabels.includes("TRASH"),
    });
  }

  // Get inbox unread count — must include in:inbox, otherwise Gmail counts
  // unread across all labels (archived, labeled, etc.)
  const inboxLabel = await gmail.users.labels.get({ userId: "me", id: "INBOX" });
  const unreadTotal = inboxLabel.data.messagesUnread ?? 0;

  return {
    person: label,
    inboxUnread: unreadTotal,
    userLabels,
    emails,
  };
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: "gmail",
    description: "Gmail — recent email summaries for actionable signals",

    async fetch(): Promise<ConnectorResult> {
      const credsDir = (config.credentials_dir as string) ?? "secrets";
      const query =
        (config.query as string) ??
        "newer_than:2d -category:promotions -category:social";
      const maxMessages = (config.max_messages as number) ?? 25;

      const accounts = (config.accounts as GmailAccount[] | undefined) ?? [];

      let results: Record<string, unknown>[];

      if (accounts.length > 0) {
        // Multi-account mode
        results = [];
        for (const acct of accounts) {
          const tokenFile =
            acct.token_file ??
            `token_gmail_${acct.name.toLowerCase()}.json`;
          results.push(
            await fetchAccount(
              credsDir, tokenFile, acct.name, query, maxMessages,
              resolveCredsFile(acct, config),
            ),
          );
        }
      } else {
        // Legacy single-account mode
        results = [
          await fetchAccount(credsDir, "token_gmail.json", "default", query, maxMessages),
        ];
      }

      const totalEmails = results.reduce(
        (sum, r) => sum + (r.emails as unknown[]).length,
        0,
      );
      const totalUnread = results.reduce(
        (sum, r) => sum + (r.inboxUnread as number),
        0,
      );

      return {
        source: "gmail",
        description:
          `Gmail: ${results.length} account(s), ${totalEmails} recent emails (query: '${query}'), ${totalUnread} total inbox unread. ` +
          "Each account has: person name, inboxUnread count, userLabels (their custom label names), and email list. " +
          "Each email has human-readable labels — use these to understand context (e.g. 'KLM Issue', 'Medical', 'Travel Confirmations'). " +
          "Look for: billing/payment notifications (flag if action needed next day), " +
          "trial/subscription signups (warn about upcoming charges), " +
          "shipping confirmations (extract delivery dates), " +
          "important personal or work emails that need a response, " +
          "anything time-sensitive. Ignore routine newsletters and notifications.",
        data: { accounts: results },
        priorityHint: "normal",
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const credsDir = (config.credentials_dir as string) ?? "secrets";

  const accounts = (config.accounts as Array<{ name: string; credentials_file?: string; token_file?: string }> | undefined) ?? [];

  if (accounts.length > 0) {
    checks.push([PASS, `${accounts.length} account(s) configured`, ""]);
    for (const acct of accounts) {
      const credsFile = resolveCredsFile(acct, config) ?? "credentials.json";
      const credsPath = join(credsDir, credsFile);
      checks.push(
        existsSync(credsPath)
          ? [PASS, `${acct.name}: ${credsFile} found`, ""]
          : [FAIL, `${acct.name}: ${credsFile} NOT found`, credsPath],
      );
      const tokenFile = acct.token_file ?? `token_gmail_${acct.name.toLowerCase()}.json`;
      const tokenPath = join(credsDir, tokenFile);
      checks.push(
        existsSync(tokenPath)
          ? [PASS, `${acct.name}: ${tokenFile} found`, ""]
          : [FAIL, `${acct.name}: ${tokenFile} NOT found`, `Run: callsheet --auth gmail:${acct.name.toLowerCase()}`],
      );
    }
  } else {
    checks.push(
      existsSync(join(credsDir, "credentials.json"))
        ? [PASS, "credentials.json found", ""]
        : [FAIL, "credentials.json NOT found", ""],
    );
    const tokenFile = join(credsDir, "token_gmail.json");
    checks.push(
      existsSync(tokenFile)
        ? [PASS, "token_gmail.json found", ""]
        : [FAIL, "token_gmail.json NOT found", "Run: callsheet --auth gmail"],
    );
  }

  checks.push([INFO, `Query: ${config.query ?? "(default)"}`, ""]);
  checks.push([INFO, `Max messages: ${config.max_messages ?? 25}`, ""]);

  return checks;
}

export const authFromConfig: ConnectorAuth = async (credsDir, config, accountName) => {
  const accounts = (config.accounts as GmailAccount[] | undefined) ?? [];
  const matchedAcct = accountName
    ? accounts.find((a) => a.name.toLowerCase() === accountName.toLowerCase())
    : undefined;
  const credsFile = resolveCredsFile(matchedAcct, config);
  await auth(credsDir, accountName, credsFile);
};
