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

    it('should format alert onset and expires dates', async () => {
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
                      shortForecast: 'Cloudy',
                      detailedForecast: 'Cloudy.',
                      probabilityOfPrecipitation: null,
                    },
                  ],
                },
              }),
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
                      event: 'Winter Storm Warning',
                      severity: 'Severe',
                      urgency: 'Expected',
                      headline: 'Winter Storm Warning until Friday',
                      onset: '2026-03-28T06:00:00-05:00',
                      ends: '2026-03-29T22:00:00-05:00',
                      expires: '2026-03-29T10:00:00-05:00',
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

      const alerts = result.data.alerts as {
        onset: string | null;
        ends: string | null;
        messageExpires: string | null;
        event: string;
      }[];
      expect(alerts).toHaveLength(1);
      expect(alerts[0].event).toBe('Winter Storm Warning');
      // The hazard's end and the message's expiry are different things, and
      // the brief must be able to tell them apart.
      expect(typeof alerts[0].onset).toBe('string');
      expect(typeof alerts[0].ends).toBe('string');
      expect(typeof alerts[0].messageExpires).toBe('string');
      expect(alerts[0].ends).not.toBe(alerts[0].messageExpires);
      expect(result.description).toContain(
        '`messageExpires` is only when the alert text is reissued',
      );
    });

    it('formats alert times in the configured timezone, and handles missing ones', async () => {
      mockFetch((url) => {
        if (url.includes('/points/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ properties: { forecast: 'https://x/forecast' } }),
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
                  { properties: { event: 'Heat Advisory', ends: '2026-07-01T03:00:00Z' } },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      const result = await create({ ...baseConfig, timezone: 'UTC' }).fetch();
      const [alert] = result.data.alerts as {
        ends: string;
        onset: string | null;
        messageExpires: string | null;
      }[];
      expect(alert.ends).toContain('3:00 AM');
      expect(alert.onset).toBeNull();
      expect(alert.messageExpires).toBeNull();
    });

    it('should handle null precipitationChance', async () => {
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
            json: () =>
              Promise.resolve({
                properties: {
                  periods: [
                    {
                      name: 'Today',
                      temperature: 70,
                      temperatureUnit: 'F',
                      windSpeed: '5 mph',
                      windDirection: 'N',
                      shortForecast: 'Clear',
                      detailedForecast: 'Clear skies.',
                      // No probabilityOfPrecipitation key at all
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
        return Promise.resolve({ ok: false });
      });

      const conn = create(baseConfig);
      const result = await conn.fetch();
      const periods = result.data.periods as { precipitationChance: number | null }[];
      expect(periods[0].precipitationChance).toBeNull();
    });

    it('should handle alerts API returning not ok', async () => {
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
          return Promise.resolve({ ok: false, status: 500 });
        }
        return Promise.resolve({ ok: false });
      });

      const conn = create(baseConfig);
      const result = await conn.fetch();
      // Should still succeed with empty alerts — but say they are unavailable,
      // because an outage is not the same as a quiet day.
      expect(result.data.alerts).toEqual([]);
      expect(result.data.alertsUnavailable).toBe(true);
      expect(result.description).toContain('could NOT be fetched');
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

  describe('weather hub source_url', () => {
    const hubConfig: ConnectorConfig = { ...baseConfig, source_url: 'http://hub.test:9300/' };
    const hubBody = {
      forecast: [
        {
          name: 'Tonight',
          temperature: 34,
          unit: 'F',
          wind: '10 mph N',
          shortForecast: 'Cloudy',
          detailedForecast: 'Cloudy, low 34.',
          precipitationChance: 20,
        },
      ],
      alerts: [
        {
          event: 'Wind Advisory',
          severity: 'Moderate',
          urgency: 'Expected',
          headline: 'Wind Advisory until 6 AM',
          onset: '2026-01-02T03:00:00Z',
          ends: '2026-01-02T12:00:00Z',
          expires: '2026-01-02T09:00:00Z',
        },
      ],
      alerts_known: true,
    };

    it('uses the hub first and never calls NWS', async () => {
      const urls: string[] = [];
      mockFetch((url) => {
        urls.push(url);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(hubBody) });
      });
      const result = await create(hubConfig).fetch();
      expect(urls).toEqual(['http://hub.test:9300/api/callsheet']);
      expect((result.data.periods as { name: string }[])[0].name).toBe('Tonight');
      expect((result.data.alerts as { event: string }[])[0].event).toBe('Wind Advisory');
      expect(result.priorityHint).toBe('high');
    });

    it('reports alerts as unavailable when the hub could not check them', async () => {
      mockFetch(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...hubBody, alerts: [], alerts_known: false }),
        }),
      );
      const result = await create(hubConfig).fetch();
      expect(result.data.alertsUnavailable).toBe(true);
      expect(result.data.alerts).toEqual([]);
    });

    it('falls back to NWS when the hub is down', async () => {
      const urls: string[] = [];
      mockFetch((url) => {
        urls.push(url);
        if (new URL(url).hostname === 'hub.test') return Promise.reject(new Error('refused'));
        if (url.includes('/points/')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                properties: { forecast: 'https://api.weather.gov/gridpoints/X/1,1/forecast' },
              }),
          });
        }
        if (url.includes('/alerts/')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              properties: { periods: [{ name: 'Today', temperature: 60, temperatureUnit: 'F' }] },
            }),
        });
      });
      const result = await create(hubConfig).fetch();
      expect(urls[0]).toContain('hub.test');
      expect(urls.some((u) => u.includes('api.weather.gov/points'))).toBe(true);
      expect((result.data.periods as { name: string }[])[0].name).toBe('Today');
    });

    it('falls back to NWS when the hub answers with an empty forecast', async () => {
      mockFetch((url) => {
        if (new URL(url).hostname === 'hub.test') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ forecast: [], alerts: [], alerts_known: true }),
          });
        }
        return Promise.reject(new Error('nws down too'));
      });
      await expect(create(hubConfig).fetch()).rejects.toThrow();
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

    it('mentions the hub when source_url is set', () => {
      const checks = validate({ ...baseConfig, source_url: 'http://hub.test:9300' });
      expect(checks.some(([, name]) => name === 'Weather hub')).toBe(true);
    });

    it('should include location in check message', () => {
      const checks = validate(baseConfig);
      const passCheck = checks.find(([icon]) => icon === PASS);
      expect(passCheck?.[1]).toContain('NYC');
    });
  });
});
