import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, WARN, INFO } from '../test-icons.js';

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'home_assistant',
    description: 'Home Assistant — smart home sensor states and anomalies',

    async fetch(): Promise<ConnectorResult> {
      const url = (config.url as string).replace(/\/$/, '');
      const tokenEnv = (config.token_env as string) ?? 'HA_TOKEN';
      const token = process.env[tokenEnv] ?? '';
      if (!token) throw new Error(`${tokenEnv} not set`);

      const headers = { Authorization: `Bearer ${token}` };
      const entityIds = (config.entities as string[]) ?? [];
      const sensors: Record<string, unknown>[] = [];

      if (entityIds.length > 0) {
        for (const eid of entityIds) {
          const resp = await fetch(`${url}/api/states/${eid}`, {
            headers,
            signal: AbortSignal.timeout(10_000),
          });
          if (resp.ok) {
            const state = (await resp.json()) as Record<string, unknown>;
            const attrs = (state.attributes ?? {}) as Record<string, unknown>;
            sensors.push({
              entityId: state.entity_id,
              friendlyName: attrs.friendly_name ?? eid,
              state: state.state,
              unit: attrs.unit_of_measurement ?? '',
              lastChanged: state.last_changed ?? '',
            });
          }
        }
      } else {
        const resp = await fetch(`${url}/api/states`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) throw new Error(`HA API: ${resp.status}`);
        for (const state of (await resp.json()) as Record<string, unknown>[]) {
          const eid = state.entity_id as string;
          const domain = eid.split('.')[0];
          if (
            ['sensor', 'binary_sensor', 'lock', 'cover', 'climate', 'alarm_control_panel'].includes(
              domain,
            )
          ) {
            const attrs = (state.attributes ?? {}) as Record<string, unknown>;
            sensors.push({
              entityId: eid,
              friendlyName: attrs.friendly_name ?? eid,
              state: state.state,
              unit: attrs.unit_of_measurement ?? '',
            });
          }
        }
      }

      return {
        source: 'home_assistant',
        description:
          `Home Assistant: ${sensors.length} sensor/device states. ` +
          'Flag anything unusual: doors/locks left open, extreme temperatures, ' +
          "sensors in 'unavailable' state (may indicate device issues), " +
          'or maintenance-related sensors (filter age, etc.). ' +
          'Only mention items that are noteworthy — skip if everything is normal.',
        data: { sensors },
        priorityHint: 'low',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const url = config.url as string | undefined;
  const tokenEnv = (config.token_env as string) ?? 'HA_TOKEN';

  checks.push(url ? [PASS, `URL: ${url}`, ''] : [FAIL, 'No URL configured', '']);

  const token = process.env[tokenEnv] ?? '';
  checks.push(token ? [PASS, `${tokenEnv} is set`, ''] : [FAIL, `${tokenEnv} is NOT set`, '']);

  const entities = (config.entities as string[]) ?? [];
  if (entities.length) {
    checks.push([INFO, `${entities.length} specific entities configured`, '']);
  } else {
    checks.push([WARN, 'No specific entities \u2014 will scan all sensors', '']);
  }

  return checks;
}
