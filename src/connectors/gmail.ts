import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { google } from 'googleapis';
import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, INFO } from '../test-icons.js';
import {
  getCredentials,
  resolveCredsFile,
  makeAuthFromConfig,
  type GoogleAccount,
} from './google-auth.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

/** An email as the brief sees it. */
export interface BriefEmail {
  from: string;
  to?: string;
  subject: string;
  /** The raw Date header, kept for reference. */
  date: string;
  /** Local date and time in the household timezone, and a relative day. */
  dateLocal?: string;
  timeLabel?: string;
  whenLabel?: string;
  snippet: string;
  labels: string[];
  trashed: boolean;
  /** Sent from this account. */
  sent: boolean;
  threadId?: string;
  /** Messages in the whole conversation, and whether the last one came from this account. */
  threadMessages?: number;
  lastFromUs?: boolean;
}

/**
 * Decode the HTML entities Gmail leaves in snippets ("We&#39;ve", "&amp;"),
 * which otherwise reach the page verbatim.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Remove one-time codes from text that mentions them. A sign-in or
 * verification code in a snippet is sent to the model and stored on disk with
 * the day's data, and has no business on a printed page either.
 */
export function redactCodes(text: string): string {
  const mentionsCode =
    /\b(code|verification|verify|one[- ]time|otp|passcode|pin|security|sign[- ]in|login|2fa|two[- ]factor)\b/i;
  if (!mentionsCode.test(text)) return text;
  return text
    .replace(/\b([A-Z]-)?\d{4,8}\b/g, '[code]')
    .replace(/\b(?=[A-Z0-9]{6,8}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]+\b/g, '[code]');
}

/** "today", "yesterday", or the weekday, for a local date relative to `today`. */
function relativeDay(dateYmd: string, todayYmdStr: string): string {
  const d = Date.UTC(+dateYmd.slice(0, 4), +dateYmd.slice(5, 7) - 1, +dateYmd.slice(8, 10));
  const t = Date.UTC(
    +todayYmdStr.slice(0, 4),
    +todayYmdStr.slice(5, 7) - 1,
    +todayYmdStr.slice(8, 10),
  );
  const diff = Math.round((t - d) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  const weekday = new Date(d + 12 * 3_600_000).toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  });
  return diff > 1 && diff < 7 ? `${weekday} (${diff} days ago)` : dateYmd;
}

interface FetchOutcome {
  emails: BriefEmail[];
  /** True when the query matched more messages than were fetched. */
  truncated: boolean;
}

/** Fetch a list of message objects from a Gmail query, deduplicating by ID. */
async function fetchMessages(
  gmail: ReturnType<typeof google.gmail>,
  query: string,
  maxResults: number,
  seenIds: Set<string>,
  labelMap: Map<string, string>,
  tz: string,
): Promise<FetchOutcome> {
  const listResult = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  const messages = listResult.data.messages ?? [];
  const truncated = Boolean(listResult.data.nextPageToken);
  const emails: BriefEmail[] = [];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

  for (const msgRef of messages) {
    if (seenIds.has(msgRef.id!)) continue;
    seenIds.add(msgRef.id!);

    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: msgRef.id!,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
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
          name === 'UNREAD' ||
          name === 'IMPORTANT' ||
          name === 'TRASH' ||
          (!name.startsWith('CATEGORY_') &&
            !['INBOX', 'SENT', 'CHAT', 'DRAFT', 'SPAM', 'TRASH', 'STARRED', 'YELLOW_STAR'].includes(
              name,
            )),
      );

    // internalDate is when Gmail received it, in ms — reliable where Date
    // headers carry a mix of offsets that a model compared digit by digit.
    const at = msg.data.internalDate ? new Date(Number(msg.data.internalDate)) : undefined;
    const local =
      at && !Number.isNaN(at.getTime())
        ? {
            dateLocal: new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at),
            timeLabel: new Intl.DateTimeFormat('en-US', {
              timeZone: tz,
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            }).format(at),
          }
        : undefined;

    const email: BriefEmail = {
      from: headers.from ?? '',
      subject: redactCodes(decodeEntities(headers.subject ?? '')),
      date: headers.date ?? '',
      snippet: redactCodes(decodeEntities(msg.data.snippet ?? '')),
      labels: readableLabels,
      trashed: rawLabels.includes('TRASH'),
      sent: rawLabels.includes('SENT'),
    };
    if (headers.to) email.to = headers.to.slice(0, 200);
    if (local) {
      email.dateLocal = local.dateLocal;
      email.timeLabel = local.timeLabel;
      email.whenLabel = relativeDay(local.dateLocal, today);
    }
    if (msg.data.threadId) email.threadId = msg.data.threadId;
    emails.push(email);
  }

  return { emails, truncated };
}

/**
 * Who spoke last in each conversation.
 *
 * Without this the brief had no way to know the household had already
 * answered, and kept printing "reply to …" for emails replied to hours
 * earlier, or "still hasn't replied" about a reply sitting in the same data.
 * One lightweight call per distinct thread, capped.
 */
async function annotateThreads(
  gmail: ReturnType<typeof google.gmail>,
  emails: BriefEmail[],
  cap = 40,
): Promise<void> {
  const ids = [...new Set(emails.map((e) => e.threadId).filter((t): t is string => Boolean(t)))];
  const state = new Map<string, { count: number; lastFromUs: boolean }>();
  for (const id of ids.slice(0, cap)) {
    try {
      const thread = await gmail.users.threads.get({ userId: 'me', id, format: 'minimal' });
      const msgs = (thread.data.messages ?? [])
        .slice()
        .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
      const last = msgs[msgs.length - 1];
      state.set(id, {
        count: msgs.length,
        lastFromUs: Boolean(last?.labelIds?.includes('SENT')),
      });
    } catch {
      /* a thread we cannot read just goes without the annotation */
    }
  }
  for (const e of emails) {
    const st = e.threadId ? state.get(e.threadId) : undefined;
    if (!st) continue;
    e.threadMessages = st.count;
    e.lastFromUs = st.lastFromUs;
  }
}

async function fetchAccount(
  credsDir: string,
  tokenFile: string,
  label: string,
  query: string,
  maxMessages: number,
  credsFile?: string,
  trashMaxAge?: string,
  pinnedLabels?: string[],
  tz: string = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<Record<string, unknown>> {
  const oauth2 = getCredentials(credsDir, tokenFile, credsFile);
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  // Build a label ID → name map so we can return human-readable names
  const labelsRes = await gmail.users.labels.list({ userId: 'me' });
  const allLabels = labelsRes.data.labels ?? [];
  const labelMap = new Map<string, string>();
  const userLabels: string[] = [];
  for (const l of allLabels) {
    if (l.id && l.name) {
      labelMap.set(l.id, l.name);
      if (l.type === 'user') userLabels.push(l.name);
    }
  }

  const seenIds = new Set<string>();

  // Phase 1: Non-trash emails (inbox, archive, labeled — everything except trash)
  const mainQuery = `${query} -in:trash`;
  const main = await fetchMessages(gmail, mainQuery, maxMessages, seenIds, labelMap, tz);
  const mainEmails = main.emails;

  // Phase 2: Trash emails with a shorter time window (resolution signals only)
  const effectiveTrashAge = trashMaxAge ?? '1d';
  const trashQuery = `in:trash newer_than:${effectiveTrashAge}`;
  const trashEmails = (await fetchMessages(gmail, trashQuery, 15, seenIds, labelMap, tz)).emails;

  // Phase 3: Pinned labels — important folders fetched with a longer window
  // These are labels like "Travel Confirmations" where older emails still matter.
  const pinnedEmails = [];
  if (pinnedLabels?.length) {
    for (const pinnedLabel of pinnedLabels) {
      // Check this label actually exists for this account
      if (!userLabels.includes(pinnedLabel)) continue;
      const pinnedQuery = `label:${pinnedLabel.replace(/ /g, '-')}`;
      const results = await fetchMessages(gmail, pinnedQuery, 5, seenIds, labelMap, tz);
      pinnedEmails.push(...results.emails);
    }
  }

  const emails = [...mainEmails, ...trashEmails, ...pinnedEmails];
  await annotateThreads(gmail, emails);

  // Get inbox unread count — must include in:inbox, otherwise Gmail counts
  // unread across all labels (archived, labeled, etc.)
  const inboxLabel = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' });
  const unreadTotal = inboxLabel.data.messagesUnread ?? 0;

  return {
    person: label,
    inboxUnread: unreadTotal,
    userLabels,
    emails,
    // The query matched more than max_messages: the oldest part of the window
    // is missing. It used to be cut silently on most days for one account.
    ...(main.truncated ? { truncated: true } : {}),
  };
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'gmail',
    description: 'Gmail — recent email summaries for actionable signals',

    async fetch(): Promise<ConnectorResult> {
      const credsDir = (config.credentials_dir as string) ?? 'secrets';
      const query =
        (config.query as string) ?? 'newer_than:2d -category:promotions -category:social';
      const maxMessages = (config.max_messages as number) ?? 40;
      const tz =
        (config.timezone as string | undefined) ??
        process.env.TZ ??
        Intl.DateTimeFormat().resolvedOptions().timeZone;
      const trashMaxAge = config.trash_max_age as string | undefined;
      const pinnedLabels = config.pinned_labels as string[] | undefined;

      const accounts = (config.accounts as GoogleAccount[] | undefined) ?? [];

      let results: Record<string, unknown>[];

      if (accounts.length > 0) {
        // Multi-account mode
        results = [];
        for (const acct of accounts) {
          const tokenFile = acct.token_file ?? `token_gmail_${acct.name.toLowerCase()}.json`;
          results.push(
            await fetchAccount(
              credsDir,
              tokenFile,
              acct.name,
              query,
              maxMessages,
              resolveCredsFile(acct, config),
              trashMaxAge,
              pinnedLabels,
              tz,
            ),
          );
        }
      } else {
        // Legacy single-account mode
        results = [
          await fetchAccount(
            credsDir,
            'token_gmail.json',
            'default',
            query,
            maxMessages,
            undefined,
            trashMaxAge,
            pinnedLabels,
            tz,
          ),
        ];
      }

      const totalEmails = results.reduce((sum, r) => sum + (r.emails as unknown[]).length, 0);
      const totalUnread = results.reduce((sum, r) => sum + (r.inboxUnread as number), 0);

      const pinnedNote = pinnedLabels?.length
        ? ` Pinned labels (${pinnedLabels.join(', ')}) are fetched separately with no time restriction — these contain important reference emails like booking confirmations.`
        : '';

      return {
        source: 'gmail',
        description:
          `Gmail: ${results.length} account(s), ${totalEmails} recent emails (query: '${query}'), ${totalUnread} total inbox unread. ` +
          'Emails are fetched in phases: (1) non-trash emails matching the query, (2) recently trashed emails as resolution signals, ' +
          `(3) pinned label emails for important reference data.${pinnedNote} ` +
          'Each account has: person name, inboxUnread count, userLabels (their custom label names), and email list. ' +
          'Each email has human-readable labels — use these to understand context. ' +
          'Trashed emails (trashed: true) indicate the person already handled that item — use as resolution signals, not action items. ' +
          '`sent: true` marks a message the household wrote. `lastFromUs: true` means the household sent the latest message in ' +
          'that conversation — they are waiting on the other side, so NEVER turn it into a reply or follow-up task. ' +
          'Use `dateLocal`, `timeLabel` and `whenLabel` (household timezone) for when an email arrived; the raw `date` ' +
          'header mixes time zones. One-time codes are redacted as [code]; never print a code, password or full account number. ' +
          (results.some((r) => r.truncated)
            ? `The window was CUT OFF for ${results
                .filter((r) => r.truncated)
                .map((r) => r.person as string)
                .join(
                  ', ',
                )} (more matching emails than max_messages) — older emails in it are missing. `
            : '') +
          'Look for: billing/payment notifications (flag if action needed next day), ' +
          'trial/subscription signups (warn about upcoming charges), ' +
          'shipping confirmations (extract delivery dates), ' +
          'important personal or work emails that need a response, ' +
          'anything time-sensitive. Ignore routine newsletters and notifications.',
        data: { accounts: results },
        priorityHint: 'normal',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const credsDir = (config.credentials_dir as string) ?? 'secrets';

  const accounts = (config.accounts as GoogleAccount[] | undefined) ?? [];

  if (accounts.length > 0) {
    checks.push([PASS, `${accounts.length} account(s) configured`, '']);
    for (const acct of accounts) {
      const credsFile = resolveCredsFile(acct, config) ?? 'credentials.json';
      const credsPath = join(credsDir, credsFile);
      checks.push(
        existsSync(credsPath)
          ? [PASS, `${acct.name}: ${credsFile} found`, '']
          : [FAIL, `${acct.name}: ${credsFile} NOT found`, credsPath],
      );
      const tokenFile = acct.token_file ?? `token_gmail_${acct.name.toLowerCase()}.json`;
      const tokenPath = join(credsDir, tokenFile);
      checks.push(
        existsSync(tokenPath)
          ? [PASS, `${acct.name}: ${tokenFile} found`, '']
          : [
              FAIL,
              `${acct.name}: ${tokenFile} NOT found`,
              `Run: callsheet --auth gmail:${acct.name.toLowerCase()}`,
            ],
      );
    }
  } else {
    checks.push(
      existsSync(join(credsDir, 'credentials.json'))
        ? [PASS, 'credentials.json found', '']
        : [FAIL, 'credentials.json NOT found', ''],
    );
    const tokenFile = join(credsDir, 'token_gmail.json');
    checks.push(
      existsSync(tokenFile)
        ? [PASS, 'token_gmail.json found', '']
        : [FAIL, 'token_gmail.json NOT found', 'Run: callsheet --auth gmail'],
    );
  }

  checks.push([INFO, `Query: ${config.query ?? '(default)'}`, '']);
  checks.push([INFO, `Max messages per account: ${config.max_messages ?? 25}`, '']);
  checks.push([INFO, `Trash max age: ${config.trash_max_age ?? '1d (default)'}`, '']);
  const pinned = config.pinned_labels as string[] | undefined;
  checks.push([INFO, `Pinned labels: ${pinned?.length ? pinned.join(', ') : '(none)'}`, '']);

  return checks;
}

export const authFromConfig = makeAuthFromConfig(SCOPES, 'Gmail', 'token_gmail');
