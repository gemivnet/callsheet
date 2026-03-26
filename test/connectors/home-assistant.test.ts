import { jest } from '@jest/globals';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.HA_TOKEN;
});

const { create, validate } = await import('../../src/connectors/home-assistant.js');
const { PASS, FAIL } = await import('../../src/test-icons.js');

describe('home-assistant connector', () => {
  function setupMockFetch() {
    process.env.HA_TOKEN = 'test-ha-token';
    globalThis.fetch = jest.fn(((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/api/states/sensor.temperature')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              entity_id: 'sensor.temperature',
              state: '72.5',
              attributes: {
                friendly_name: 'Living Room Temp',
                unit_of_measurement: '°F',
              },
              last_changed: '2026-03-25T08:00:00Z',
            }),
        });
      }
      if (urlStr.includes('/api/states') && !urlStr.includes('/api/states/')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                entity_id: 'sensor.temperature',
                state: '72.5',
                attributes: { friendly_name: 'Temp', unit_of_measurement: '°F' },
              },
              {
                entity_id: 'binary_sensor.door',
                state: 'off',
                attributes: { friendly_name: 'Front Door' },
              },
              {
                entity_id: 'light.living_room',
                state: 'on',
                attributes: { friendly_name: 'Living Room Light' },
              },
            ]),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof fetch);
  }

  describe('create', () => {
    it('should create a connector with correct name', () => {
      const conn = create({
        enabled: true,
        url: 'http://homeassistant.local:8123',
        token_env: 'HA_TOKEN',
      });
      expect(conn.name).toBe('home_assistant');
    });

    it('should fetch specific entities when configured', async () => {
      setupMockFetch();
      const conn = create({
        enabled: true,
        url: 'http://ha.local:8123',
        token_env: 'HA_TOKEN',
        entities: ['sensor.temperature'],
      });
      const result = await conn.fetch();

      expect(result.source).toBe('home_assistant');
      const sensors = result.data.sensors as Record<string, unknown>[];
      expect(sensors).toHaveLength(1);
      expect(sensors[0].state).toBe('72.5');
      expect(sensors[0].friendlyName).toBe('Living Room Temp');
    });

    it('should scan all sensors when no entities specified', async () => {
      setupMockFetch();
      const conn = create({
        enabled: true,
        url: 'http://ha.local:8123',
        token_env: 'HA_TOKEN',
      });
      const result = await conn.fetch();

      // Should include sensor + binary_sensor but not light
      const sensors = result.data.sensors as Record<string, unknown>[];
      expect(sensors.length).toBe(2);
    });

    it('should throw when token is missing', async () => {
      const conn = create({
        enabled: true,
        url: 'http://ha.local:8123',
        token_env: 'HA_TOKEN',
      });
      await expect(conn.fetch()).rejects.toThrow('HA_TOKEN not set');
    });
  });

  describe('validate', () => {
    it('should pass with url and token set', () => {
      process.env.HA_TOKEN = 'test';
      const checks = validate({
        enabled: true,
        url: 'http://ha.local:8123',
        token_env: 'HA_TOKEN',
      });
      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
    });

    it('should fail when url missing', () => {
      const checks = validate({ enabled: true });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('should fail when token env not set', () => {
      const checks = validate({
        enabled: true,
        url: 'http://ha.local:8123',
        token_env: 'HA_TOKEN',
      });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });
  });
});
