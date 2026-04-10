import type {
  Connector,
  ConnectorConfig,
  ConnectorFactory,
  ConnectorValidator,
  ConnectorAuth,
} from '../types.js';

import { create as createWeather, validate as validateWeather } from './weather.js';
import { create as createTodoist, validate as validateTodoist } from './todoist.js';
import {
  create as createGoogleCalendar,
  validate as validateGoogleCalendar,
  authFromConfig as authGoogleCalendar,
} from './google-calendar.js';
import {
  create as createGmail,
  validate as validateGmail,
  authFromConfig as authGmail,
} from './gmail.js';
import {
  create as createAviationWeather,
  validate as validateAviationWeather,
} from './aviation-weather.js';
import { create as createMarket, validate as validateMarket } from './market.js';
import {
  create as createHomeAssistant,
  validate as validateHomeAssistant,
} from './home-assistant.js';
import { create as createActualBudget, validate as validateActualBudget } from './actual-budget.js';
import {
  create as createGarbageRecycling,
  validate as validateGarbageRecycling,
} from './garbage-recycling.js';

export interface ConnectorEntry {
  factory: ConnectorFactory;
  validate?: ConnectorValidator;
  auth?: ConnectorAuth;
  /** OAuth scopes for connectors that support web-based auth. */
  authScopes?: string[];
  /** Token filename prefix (e.g. 'token_calendar'). */
  authTokenPrefix?: string;
  /** Human-readable label for auth flow. */
  authLabel?: string;
}

const registry = new Map<string, ConnectorEntry>([
  ['weather', { factory: createWeather, validate: validateWeather }],
  ['todoist', { factory: createTodoist, validate: validateTodoist }],
  [
    'google_calendar',
    {
      factory: createGoogleCalendar,
      validate: validateGoogleCalendar,
      auth: authGoogleCalendar,
      authScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      authTokenPrefix: 'token_calendar',
      authLabel: 'Google Calendar',
    },
  ],
  [
    'gmail',
    {
      factory: createGmail,
      validate: validateGmail,
      auth: authGmail,
      authScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      authTokenPrefix: 'token_gmail',
      authLabel: 'Gmail',
    },
  ],
  ['aviation_weather', { factory: createAviationWeather, validate: validateAviationWeather }],
  ['market', { factory: createMarket, validate: validateMarket }],
  ['home_assistant', { factory: createHomeAssistant, validate: validateHomeAssistant }],
  ['actual_budget', { factory: createActualBudget, validate: validateActualBudget }],
  ['garbage_recycling', { factory: createGarbageRecycling, validate: validateGarbageRecycling }],
]);

export function getRegistry(): Map<string, ConnectorEntry> {
  return new Map(registry);
}

export interface ConnectorInitError {
  connector: string;
  error: string;
}

export function loadConnectors(config: Record<string, unknown>): {
  connectors: Connector[];
  initErrors: ConnectorInitError[];
} {
  const connectorConfigs = (config.connectors ?? {}) as Record<string, ConnectorConfig>;
  const connectors: Connector[] = [];
  const initErrors: ConnectorInitError[] = [];

  for (const [name, connConfig] of Object.entries(connectorConfigs)) {
    if (!connConfig.enabled) continue;

    const entry = registry.get(name);
    if (!entry) {
      console.log(`  WARNING: No connector registered for '${name}', skipping.`);
      initErrors.push({ connector: name, error: 'No connector registered with this name' });
      continue;
    }

    try {
      connectors.push(entry.factory(connConfig));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  WARNING: Failed to initialize connector '${name}': ${msg}`);
      initErrors.push({ connector: name, error: `Init failed: ${msg}` });
    }
  }

  return { connectors, initErrors };
}

export type { Connector, ConnectorConfig };
