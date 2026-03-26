import { jest } from '@jest/globals';
import type { ConnectorConfig } from '../../src/types.js';

// Save original fetch
const originalFetch = globalThis.fetch;

// Helper to create mock fetch
function mockFetch(handler: (url: string) => Promise<unknown>) {
  globalThis.fetch = jest.fn(((url: string | URL | Request) =>
    handler(url.toString())) as typeof fetch);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Import the module (no mocks needed for weather — it only uses fetch)
const { create, validate } = await import('../../src/connectors/weather.js');
const { PASS, FAIL } = await import('../../src/test-icons.js');

describe('weather connector', () => {
  const baseConfig: ConnectorConfig = { enabled: true, lat: 40.7, lon: -74.0, location: 'NYC' };

  function setupNormalWeather() {
    mockFetch((url) => {
      if (url.includes('/points/')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              properties: {
                forecast: 'https://api.weather.gov/gridpoints/OKX/33,37/forecast',
              },
            }),
        });
      }
      if (url.includes('/forecast')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              properties: {
                periods: [
                  {
                    name: 'Today',
                    temperature: 65,
                    temperatureUnit: 'F',
                    windSpeed: '10 mph',
                    windDirection: 'SW',
                    shortForecast: 'Partly Cloudy',
                    detailedForecast: 'Partly cloudy, high of 65.',
                    probabilityOfPrecipitation: { value: 10 },
                  },
                  {
                    name: 'Tonight',
                    temperature: 48,
                    temperatureUnit: 'F',
                    windSpeed: '5 mph',
                    windDirection: 'NW',
                    shortForecast: 'Clear',
                    detailedForecast: 'Clear skies.',
                    probabilityOfPrecipitation: { value: 0 },
                  },
                ],
              },
            }),
        });
      }
      if (url.includes('/alerts/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ features: [] }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
  }

  describe('create', () => {
    it('should create a connector with correct name and description', () => {
      const conn = create(baseConfig);
      expect(conn.name).toBe('weather');
      expect(conn.description).toContain('Weather');
    });

    it('should fetch weather data and return periods', async () => {
      setupNormalWeather();
      const conn = create(baseConfig);
      const result = await conn.fetch();

      expect(result.source).toBe('weather');
      expect(result.data.location).toBe('NYC');
      expect(result.data.periods).toHaveLength(2);
      expect(result.data.alerts).toEqual([]);
      expect(result.priorityHint).toBe('low');
    });

    it('should use lat,lon as fallback location', async () => {
      setupNormalWeather();
      const conn = create({ enabled: true, lat: 40.7, lon: -74.0 });
      const result = await conn.fetch();
      expect(result.data.location).toBe('40.7,-74');
    });

    it('should set high priority when alerts are present', async () => {
      mockFetch((url) => {
        if (url.includes('/points/')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                properties: { forecast: 'https://api.weather.gov/test/forecast' },
              }),
          });
        }
        if (url.includes('/forecast')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ properties: { periods: [] } }),
          });
        }
        if (url.includes('/alerts/')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                features: [
                  {
                    properties: {
                      event: 'Tornado Warning',
                      severity: 'Extreme',
                      urgency: 'Immediate',
                      headline: 'Tornado Warning in effect',
                      onset: null,
                      expires: null,
                    },
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const conn = create(baseConfig);
      const result = await conn.fetch();

      expect(result.priorityHint).toBe('high');
      expect((result.data.alerts as unknown[]).length).toBe(1);
      expect(result.description).toContain('alert');
    });

    it('should throw on NWS points API error', async () => {
      mockFetch(() => Promise.resolve({ ok: false, status: 503 }));

      const conn = create(baseConfig);
      await expect(conn.fetch()).rejects.toThrow('NWS points API: 503');
    });

    it('should throw on forecast API error', async () => {
      mockFetch((url) => {
        if (url.includes('/points/')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                properties: { forecast: 'https://api.weather.gov/test/forecast' },
              }),
          });
        }
        return Promise.resolve({ ok: false, status: 500 });
      });

      const conn = create(baseConfig);
      await expect(conn.fetch()).rejects.toThrow('NWS forecast API: 500');
    });

    it('should gracefully handle alerts API failure', async () => {
      mockFetch((url) => {
        if (url.includes('/points/')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                properties: { forecast: 'https://api.weather.gov/test/forecast' },
              }),
          });
        }
        if (url.includes('/forecast')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ properties: { periods: [] } }),
          });
        }
        // alerts fetch throws
        return Promise.reject(new Error('network error'));
      });

      const conn = create(baseConfig);
      const result = await conn.fetch();
      // Should still succeed — alerts are non-critical
      expect(result.data.alerts).toEqual([]);
    });
  });

  describe('validate', () => {
    it('should pass when lat/lon configured', () => {
      const checks = validate(baseConfig);
      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
    });

    it('should fail when lat/lon missing', () => {
      const checks = validate({ enabled: true });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('should include location in check message', () => {
      const checks = validate(baseConfig);
      const passCheck = checks.find(([icon]) => icon === PASS);
      expect(passCheck?.[1]).toContain('NYC');
    });
  });
});
