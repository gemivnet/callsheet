import { jest } from '@jest/globals';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const { create, validate } = await import('../../src/connectors/market.js');
const { PASS, FAIL } = await import('../../src/test-icons.js');

describe('market connector', () => {
  function setupMockFetch() {
    globalThis.fetch = jest.fn(((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/v8/finance/chart')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              chart: {
                result: [
                  {
                    meta: {
                      regularMarketPrice: 185.5,
                      previousClose: 183.0,
                      shortName: 'Apple Inc.',
                      currency: 'USD',
                      marketState: 'REGULAR',
                    },
                    indicators: {
                      // Current 185.5, 1y high 200 — not near ATH.
                      quote: [{ close: [200, 190, 180.0, 181.5, 183.0, 184.0, 185.5] }],
                    },
                  },
                ],
              },
            }),
        });
      }
      if (urlStr.includes('/v1/finance/search')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              news: [
                {
                  title: 'Apple reports record earnings',
                  publisher: 'Reuters',
                  providerPublishTime: Math.floor(Date.now() / 1000) - 3600,
                },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: false });
    }) as typeof fetch);
  }

  describe('create', () => {
    it('should create a connector with correct name', () => {
      const conn = create({ enabled: true, symbols: ['AAPL'] });
      expect(conn.name).toBe('market');
    });

    it('should fetch market data with price, change, and news', async () => {
      setupMockFetch();
      const conn = create({ enabled: true, symbols: ['AAPL'] });
      const result = await conn.fetch();

      expect(result.source).toBe('market');
      expect(result.priorityHint).toBe('low');

      const symbols = result.data.symbols as Record<string, unknown>[];
      expect(symbols).toHaveLength(1);
      expect(symbols[0].symbol).toBe('AAPL');
      expect(symbols[0].price).toBe(185.5);
      expect(symbols[0].name).toBe('Apple Inc.');
      expect(symbols[0].currency).toBe('USD');
      expect(symbols[0].dayChangePct).toBeDefined();
      expect(symbols[0].weekChangePct).toBeDefined();
      expect((symbols[0].news as unknown[]).length).toBe(1);
    });

    it('should handle API errors per symbol gracefully', async () => {
      globalThis.fetch = jest.fn((() =>
        Promise.resolve({ ok: false, status: 500 })) as unknown as typeof fetch);

      const conn = create({ enabled: true, symbols: ['INVALID'] });
      const result = await conn.fetch();

      const symbols = result.data.symbols as Record<string, unknown>[];
      expect(symbols[0].error).toBeDefined();
      expect(symbols[0].symbol).toBe('INVALID');
    });

    it('should handle empty symbols list', async () => {
      const conn = create({ enabled: true, symbols: [] });
      const result = await conn.fetch();
      expect((result.data.symbols as unknown[]).length).toBe(0);
    });

    it('should fetch multiple symbols', async () => {
      setupMockFetch();
      const conn = create({ enabled: true, symbols: ['AAPL', 'GOOGL'] });
      const result = await conn.fetch();
      expect((result.data.symbols as unknown[]).length).toBe(2);
    });

    it('should show "just now" for very recent news', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/v8/finance/chart')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                chart: {
                  result: [
                    {
                      meta: {
                        regularMarketPrice: 100,
                        previousClose: 99,
                        shortName: 'Test',
                        currency: 'USD',
                        marketState: 'REGULAR',
                      },
                      indicators: {
                        quote: [{ close: [98, 99, 100] }],
                      },
                    },
                  ],
                },
              }),
          });
        }
        if (urlStr.includes('/v1/finance/search')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                news: [
                  {
                    title: 'Breaking news',
                    publisher: 'Reuters',
                    // Published just seconds ago (less than 1 hour)
                    providerPublishTime: Math.floor(Date.now() / 1000) - 60,
                  },
                  {
                    title: 'Old news',
                    publisher: 'AP',
                    // Published 2 days ago (>= 24 hours)
                    providerPublishTime: Math.floor(Date.now() / 1000) - 3600 * 48,
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: false });
      }) as typeof fetch);

      const conn = create({ enabled: true, symbols: ['TEST'] });
      const result = await conn.fetch();
      const symbols = result.data.symbols as Record<string, unknown>[];
      const news = symbols[0].news as { age: string }[];
      expect(news[0].age).toBe('just now');
      expect(news[1].age).toBe('2d ago');
    });

    it('should handle news fetch error gracefully', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/v8/finance/chart')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                chart: {
                  result: [
                    {
                      meta: {
                        regularMarketPrice: 100,
                        previousClose: 99,
                        shortName: 'Test',
                        currency: 'USD',
                        marketState: 'REGULAR',
                      },
                      indicators: {
                        quote: [{ close: [98, 99, 100] }],
                      },
                    },
                  ],
                },
              }),
          });
        }
        if (urlStr.includes('/v1/finance/search')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({ ok: false });
      }) as typeof fetch);

      const conn = create({ enabled: true, symbols: ['TEST'] });
      const result = await conn.fetch();
      const symbols = result.data.symbols as Record<string, unknown>[];
      // News should be empty array because of the catch
      expect(symbols[0].news).toEqual([]);
    });
  });

    it('should handle missing meta fields and sparse data', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/v8/finance/chart')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                chart: {
                  result: [
                    {
                      meta: {
                        // No regularMarketPrice, previousClose, shortName, longName, currency, marketState
                      },
                      indicators: {
                        quote: [{ close: [null, 50] }],
                      },
                    },
                  ],
                },
              }),
          });
        }
        if (urlStr.includes('/v1/finance/search')) {
          // Non-ok response to cover the !resp.ok branch in fetchNews
          return Promise.resolve({ ok: false, status: 403 });
        }
        return Promise.resolve({ ok: false });
      }) as typeof fetch);

      const conn = create({ enabled: true, symbols: ['SPARSE'] });
      const result = await conn.fetch();
      const symbols = result.data.symbols as Record<string, unknown>[];
      expect(symbols[0].symbol).toBe('SPARSE');
      // Falls back to close array last element
      expect(symbols[0].price).toBe(50);
      // No previousClose in meta, falls back to close[-2] but only 1 non-null, so dayChange from close
      expect(symbols[0].currency).toBe('USD'); // fallback
      expect(symbols[0].marketState).toBe('unknown'); // fallback
      expect(symbols[0].name).toBe('SPARSE'); // fallback to symbol itself
      expect(symbols[0].news).toEqual([]);
    });

    it('should handle missing symbols config', async () => {
      const conn = create({ enabled: true });
      const result = await conn.fetch();
      expect((result.data.symbols as unknown[]).length).toBe(0);
    });

    it('should handle news response with missing news field', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/v8/finance/chart')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                chart: {
                  result: [
                    {
                      meta: {
                        regularMarketPrice: 100,
                        previousClose: 95,
                        shortName: 'Test Co',
                        currency: 'EUR',
                        marketState: 'CLOSED',
                      },
                      indicators: { quote: [{ close: [90, 95, 100] }] },
                    },
                  ],
                },
              }),
          });
        }
        if (urlStr.includes('/v1/finance/search')) {
          // Response ok but no news field
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          });
        }
        return Promise.resolve({ ok: false });
      }) as typeof fetch);

      const conn = create({ enabled: true, symbols: ['TEST'] });
      const result = await conn.fetch();
      const symbols = result.data.symbols as Record<string, unknown>[];
      expect(symbols[0].news).toEqual([]);
      expect(symbols[0].currency).toBe('EUR');
    });

    it('should handle single close value (no week change)', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/v8/finance/chart')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                chart: { result: [{ meta: { regularMarketPrice: 50, previousClose: 48 }, indicators: { quote: [{ close: [50] }] } }] },
              }),
          });
        }
        if (urlStr.includes('/v1/finance/search')) {
          return Promise.resolve({ ok: false });
        }
        return Promise.resolve({ ok: false });
      }) as typeof fetch);

      const conn = create({ enabled: true, symbols: ['ONE'] });
      const result = await conn.fetch();
      const symbols = result.data.symbols as Record<string, unknown>[];
      expect(symbols[0].weekChangePct).toBeNull();
    });

    it('should show hours for mid-range news age', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/v8/finance/chart')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                chart: { result: [{ meta: { regularMarketPrice: 100, previousClose: 99 }, indicators: { quote: [{ close: [99, 100] }] } }] },
              }),
          });
        }
        if (urlStr.includes('/v1/finance/search')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                news: [{ title: 'Mid news', publisher: 'X', providerPublishTime: Math.floor(Date.now() / 1000) - 3600 * 5 }],
              }),
          });
        }
        return Promise.resolve({ ok: false });
      }) as typeof fetch);

      const conn = create({ enabled: true, symbols: ['MID'] });
      const result = await conn.fetch();
      const symbols = result.data.symbols as Record<string, unknown>[];
      const news = symbols[0].news as { age: string }[];
      expect(news[0].age).toBe('5h ago');
    });

    it('should flag atNear52wHigh when current price is at or near the 1y peak', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/v8/finance/chart')) {
          // Current 100.0, peak 100.05 (0.05% below high) → within 0.5% threshold
          const closes = Array.from({ length: 200 }, (_, i) => 80 + i * 0.1);
          closes[closes.length - 1] = 100;
          closes.push(100.05); // peak near the end
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                chart: {
                  result: [
                    {
                      meta: {
                        regularMarketPrice: 100,
                        previousClose: 99,
                        shortName: 'ATH Co',
                        currency: 'USD',
                        marketState: 'REGULAR',
                      },
                      indicators: { quote: [{ close: closes }] },
                    },
                  ],
                },
              }),
          });
        }
        if (urlStr.includes('/v1/finance/search')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ news: [] }) });
        }
        return Promise.resolve({ ok: false });
      }) as typeof fetch);

      const conn = create({ enabled: true, symbols: ['ATHCO'] });
      const result = await conn.fetch();
      const symbols = result.data.symbols as Record<string, unknown>[];
      expect(symbols[0].high52w).toBeCloseTo(100.05, 2);
      expect(symbols[0].atNear52wHigh).toBe(true);
      // priorityHint bumps to 'normal' when any symbol is at ATH
      expect(result.priorityHint).toBe('normal');
      // Description should remind the model to surface ATH
      expect(result.description).toContain('52-week high');
    });

    it('should flag atNear52wLow when current price is at or near the 1y trough', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/v8/finance/chart')) {
          const closes = Array.from({ length: 200 }, (_, i) => 100 - i * 0.1);
          closes[closes.length - 1] = 80;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                chart: {
                  result: [
                    {
                      meta: {
                        regularMarketPrice: 80,
                        previousClose: 81,
                        shortName: 'ATL Co',
                        currency: 'USD',
                        marketState: 'REGULAR',
                      },
                      indicators: { quote: [{ close: closes }] },
                    },
                  ],
                },
              }),
          });
        }
        if (urlStr.includes('/v1/finance/search')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ news: [] }) });
        }
        return Promise.resolve({ ok: false });
      }) as typeof fetch);

      const conn = create({ enabled: true, symbols: ['ATLCO'] });
      const result = await conn.fetch();
      const symbols = result.data.symbols as Record<string, unknown>[];
      expect(symbols[0].atNear52wLow).toBe(true);
    });

    it('should NOT flag ATH when current is comfortably below the 1y high', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/v8/finance/chart')) {
          // Peak 110, current 100 → 9% off high
          const closes = [...Array.from({ length: 200 }, (_, i) => 80 + i * 0.15), 110, 100];
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                chart: {
                  result: [
                    {
                      meta: {
                        regularMarketPrice: 100,
                        previousClose: 99,
                        shortName: 'Mid Co',
                        currency: 'USD',
                        marketState: 'REGULAR',
                      },
                      indicators: { quote: [{ close: closes }] },
                    },
                  ],
                },
              }),
          });
        }
        if (urlStr.includes('/v1/finance/search')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ news: [] }) });
        }
        return Promise.resolve({ ok: false });
      }) as typeof fetch);

      const conn = create({ enabled: true, symbols: ['MID'] });
      const result = await conn.fetch();
      const symbols = result.data.symbols as Record<string, unknown>[];
      expect(symbols[0].atNear52wHigh).toBe(false);
      expect(symbols[0].atNear52wLow).toBe(false);
    });

  describe('validate', () => {
    it('should pass with symbols configured', () => {
      const checks = validate({ enabled: true, symbols: ['AAPL', 'GOOGL'] });
      expect(checks[0][0]).toBe(PASS);
      expect(checks[0][1]).toContain('AAPL');
    });

    it('should fail with no symbols', () => {
      const checks = validate({ enabled: true });
      expect(checks[0][0]).toBe(FAIL);
    });
  });
});
