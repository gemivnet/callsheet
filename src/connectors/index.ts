import type {
  Connector,
  ConnectorConfig,
  ConnectorFactory,
  ConnectorValidator,
  ConnectorAuth,
} from "../types.js";

import { create as createWeather, validate as validateWeather } from "./weather.js";
import { create as createTodoist, validate as validateTodoist } from "./todoist.js";
import { create as createGoogleCalendar, validate as validateGoogleCalendar, authFromConfig as authGoogleCalendar } from "./google-calendar.js";
import { create as createGmail, validate as validateGmail, authFromConfig as authGmail } from "./gmail.js";
import { create as createAviationWeather, validate as validateAviationWeather } from "./aviation-weather.js";
import { create as createMarket, validate as validateMarket } from "./market.js";
import { create as createHomeAssistant, validate as validateHomeAssistant } from "./home-assistant.js";
import { create as createActualBudget, validate as validateActualBudget } from "./actual-budget.js";

export interface ConnectorEntry {
  factory: ConnectorFactory;
  validate?: ConnectorValidator;
  auth?: ConnectorAuth;
}

const registry = new Map<string, ConnectorEntry>([
  ["weather", { factory: createWeather, validate: validateWeather }],
  ["todoist", { factory: createTodoist, validate: validateTodoist }],
  ["google_calendar", { factory: createGoogleCalendar, validate: validateGoogleCalendar, auth: authGoogleCalendar }],
  ["gmail", { factory: createGmail, validate: validateGmail, auth: authGmail }],
  ["aviation_weather", { factory: createAviationWeather, validate: validateAviationWeather }],
  ["market", { factory: createMarket, validate: validateMarket }],
  ["home_assistant", { factory: createHomeAssistant, validate: validateHomeAssistant }],
  ["actual_budget", { factory: createActualBudget, validate: validateActualBudget }],
]);

export function getRegistry(): Map<string, ConnectorEntry> {
  return new Map(registry);
}

export function loadConnectors(config: Record<string, unknown>): Connector[] {
  const connectorConfigs = (config.connectors ?? {}) as Record<
    string,
    ConnectorConfig
  >;
  const connectors: Connector[] = [];

  for (const [name, connConfig] of Object.entries(connectorConfigs)) {
    if (!connConfig.enabled) continue;

    const entry = registry.get(name);
    if (!entry) {
      console.log(
        `  WARNING: No connector registered for '${name}', skipping.`,
      );
      continue;
    }

    try {
      connectors.push(entry.factory(connConfig));
    } catch (e) {
      console.log(
        `  WARNING: Failed to initialize connector '${name}': ${e}`,
      );
    }
  }

  return connectors;
}

export type { Connector, ConnectorConfig };
