export interface ConnectorResult {
  source: string;
  description: string;
  data: Record<string, unknown>;
  priorityHint: 'high' | 'normal' | 'low';
}

export interface Connector {
  readonly name: string;
  readonly description: string;
  fetch(): Promise<ConnectorResult>;
}

export type ConnectorFactory = (config: ConnectorConfig) => Connector;

/** Diagnostic check result: [icon, message, detail]. */
export type Check = [icon: string, msg: string, detail: string];

/** Optional per-connector config validator for --test mode. */
export type ConnectorValidator = (config: ConnectorConfig) => Check[];

/** Optional per-connector auth handler for --auth mode. */
export type ConnectorAuth = (
  credsDir: string,
  config: ConnectorConfig,
  accountName?: string,
) => Promise<void>;

export interface ConnectorConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface BriefExtra {
  name: string;
  instruction: string;
}

/**
 * A person the brief is about.
 *
 * Connector accounts only cover household members who have their own calendar,
 * inbox or task list. Anyone else — a child, a guest, a visiting student —
 * previously existed nowhere the brief writer could see, so their events were
 * read as belonging to whoever's calendar carried them. Listing people here
 * makes the household explicit and independent of which services they use.
 */
export interface HouseholdMember {
  name: string;
  /** Their relationship to the household, e.g. "partner", "guest". */
  role?: string;
  /** Anything the brief should know when writing about them. */
  notes?: string;
  /** Names of the matching `accounts[].name` entries, when they differ. */
  calendar_account?: string;
  gmail_account?: string;
  todoist_account?: string;
}

export interface CallsheetConfig {
  model?: string;
  printer?: string;
  output_dir?: string;
  credentials_dir?: string;
  /**
   * Optional webhook posted to when brief generation fails outright, as
   * `{ title, message }`. Kept generic — any endpoint that accepts that shape
   * works. Without it a failed brief is silent apart from the printed error
   * page, which is how a 16-day outage went unnoticed in mid-2026.
   */
  notify_webhook?: string;
  /**
   * IANA timezone for the household, e.g. "America/Chicago". Used for the
   * brief's date, output filenames, connector query windows and the
   * scheduler. Falls back to `process.env.TZ`, then the system zone.
   */
  timezone?: string;
  /** Everyone the brief is about, including people with no connector accounts. */
  household?: HouseholdMember[];
  context?: Record<string, string>;
  connectors?: Record<string, ConnectorConfig>;
  extras?: BriefExtra[];
  auto_close_tasks?: boolean;
  /** Per-connector deadline in milliseconds. Defaults to 60_000 (60s). */
  connector_timeout_ms?: number;
  /**
   * Day of the week (name like "saturday" or number 0-6 where 0=Sunday) on
   * which the daily brief is prepended with a compact "Week in Review"
   * section — a short retrospective blurb reflecting on the past 7 days.
   * On this day the calendar connector's lookback is auto-bumped to 7 days
   * so the retrospective has past events to reference. The daily brief is
   * NOT replaced — the Week in Review is a small supplemental section at
   * the top. Omit to disable.
   */
  weekly_review_day?: string | number;
  /**
   * Vacation date ranges during which the scheduled brief should not run.
   * Each range is inclusive on both ends. Dates are YYYY-MM-DD strings
   * interpreted in the configured timezone (`process.env.TZ` or system
   * default). Manual CLI runs are unaffected — only the scheduler skips.
   * Example: `[{ start: "2026-07-01", end: "2026-07-14" }]`.
   */
  vacation?: VacationRange[];
}

export interface VacationRange {
  start: string;
  end: string;
}

/** A task that Claude recommends closing based on resolution signals. */
export interface AutoCloseRecommendation {
  task_id: string;
  task_content: string;
  person: string;
  reason: string;
}

/** Brief structure that Claude outputs. */
export interface Brief {
  title: string;
  subtitle?: string;
  sections: BriefSection[];
}

export interface BriefSection {
  heading: string;
  items?: BriefItem[];
  body?: string;
}

export interface BriefItem {
  label: string;
  time?: string;
  note?: string;
  checkbox?: boolean;
  highlight?: boolean;
  urgent?: boolean;
}
