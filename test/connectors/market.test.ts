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
                      quote: [{ close: [180.0, 181.5, 183.0, 184.0, 185.5] }],
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
