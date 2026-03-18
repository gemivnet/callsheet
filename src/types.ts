export interface ConnectorResult {
  source: string;
  description: string;
  data: Record<string, unknown>;
  priorityHint: "high" | "normal" | "low";
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

export interface CallsheetConfig {
  model?: string;
  printer?: string;
  output_dir?: string;
  credentials_dir?: string;
  context?: Record<string, string>;
  connectors?: Record<string, ConnectorConfig>;
  extras?: BriefExtra[];
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
