import { jest } from '@jest/globals';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const { create, validate } = await import('../../src/connectors/aviation-weather.js');
const { PASS, FAIL } = await import('../../src/test-icons.js');

describe('aviation-weather connector', () => {
  function setupMockFetch() {
    globalThis.fetch = jest.fn(((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/metar')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                icaoId: 'KJFK',
                rawOb: 'KJFK 251156Z 21010KT 10SM SCT250 18/06 A3012',
                temp: 18,
                dewp: 6,
                wdir: 210,
                wspd: 10,
                wgst: null,
                visib: 10,
                ceil: null,
                fltcat: 'VFR',
              },
            ]),
        });
      }
      if (urlStr.includes('/taf')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                icaoId: 'KJFK',
                rawTAF: 'TAF KJFK 251130Z ...',
                fcsts: [
                  {
                    timeFrom: Math.floor(Date.now() / 1000),
                    timeTo: Math.floor(Date.now() / 1000) + 3600,
                    fcstChange: 'FM',
                    wdir: 210,
                    wspd: 12,
                    wgst: null,
                    visib: 10,
                    ceil: null,
                    wxString: '',
                    raw: 'FM251200 21012KT P6SM SKC',
                  },
                  {
                    timeFrom: Math.floor(Date.now() / 1000) + 3600,
                    timeTo: Math.floor(Date.now() / 1000) + 7200,
                    fcstChange: 'TEMPO',
                    wdir: 250,
                    wspd: 15,
                    wgst: 25,
                    visib: 3,
                    ceil: 800,
                    wxString: '-RA',
                    raw: 'TEMPO 2513/2516 25015G25KT 3SM -RA BKN008',
                  },
                ],
              },
            ]),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof fetch);
  }

  describe('create', () => {
    it('should create a connector with correct name', () => {
      const conn = create({ enabled: true, stations: ['KJFK'] });
      expect(conn.name).toBe('aviation_weather');
    });

    it('should return empty data when no stations configured', async () => {
      const conn = create({ enabled: true, stations: [] });
      const result = await conn.fetch();

      expect(result.source).toBe('aviation_weather');
      expect(result.data).toEqual({});
    });

    it('should fetch METAR and TAF data', async () => {
      setupMockFetch();
      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();

      expect(result.source).toBe('aviation_weather');
      expect(result.priorityHint).toBe('normal');

      const metars = result.data.metars as Record<string, unknown>[];
      expect(metars).toHaveLength(1);
      expect(metars[0].station).toBe('KJFK');
      expect(metars[0].flightCategory).toBe('VFR');

      const tafs = result.data.tafs as Record<string, unknown>[];
      expect(tafs).toHaveLength(1);
      expect(tafs[0].station).toBe('KJFK');
    });

    it('should parse TAF periods with flight categories', async () => {
      setupMockFetch();
      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();

      const tafs = result.data.tafs as { periods: Record<string, unknown>[] }[];
      expect(tafs[0].periods).toHaveLength(2);

      // First period: ceil=null coerces to 0 (<200), so LIFR
      expect(tafs[0].periods[0].flightCategory).toBe('LIFR');
      expect(tafs[0].periods[0].type).toBe('from');

      // Second period: ceil=800 (<1000) → MVFR
      expect(tafs[0].periods[1].flightCategory).toBe('MVFR');
      expect(tafs[0].periods[1].type).toBe('tempo');
      expect(tafs[0].periods[1].weather).toBe('-RA');
    });

    it('should classify IFR flight category correctly', async () => {
      // Test IFR: ceil < 500 or vis < 3
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/metar')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ icaoId: 'KJFK', rawOb: 'test', fltcat: 'IFR' }]),
          });
        }
        if (urlStr.includes('/taf')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                {
                  icaoId: 'KJFK',
                  rawTAF: 'TAF test',
                  fcsts: [
                    {
                      timeFrom: Math.floor(Date.now() / 1000),
                      timeTo: Math.floor(Date.now() / 1000) + 3600,
                      fcstChange: 'FM',
                      wdir: 180,
                      wspd: 10,
                      visib: 2,
                      ceil: 400,
                      wxString: 'BR',
                      raw: 'FM test IFR',
                    },
                  ],
                },
              ]),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      }) as typeof fetch);

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const tafs = result.data.tafs as { periods: Record<string, unknown>[] }[];
      expect(tafs[0].periods[0].flightCategory).toBe('IFR');
    });

    it('should classify VFR flight category when ceil and vis are high', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/metar')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ icaoId: 'KJFK', rawOb: 'test', fltcat: 'VFR' }]),
          });
        }
        if (urlStr.includes('/taf')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                {
                  icaoId: 'KJFK',
                  rawTAF: 'TAF test',
                  fcsts: [
                    {
                      timeFrom: Math.floor(Date.now() / 1000),
                      timeTo: Math.floor(Date.now() / 1000) + 3600,
                      fcstChange: 'FM',
                      wdir: 180,
                      wspd: 5,
                      visib: 10,
                      ceil: 5000,
                      wxString: '',
                      raw: 'FM test VFR',
                    },
                  ],
                },
              ]),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      }) as typeof fetch);

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const tafs = result.data.tafs as { periods: Record<string, unknown>[] }[];
      expect(tafs[0].periods[0].flightCategory).toBe('VFR');
    });

    it('should handle TAF periods with BECMG and PROB change types', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/metar')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ icaoId: 'KJFK', rawOb: 'test', fltcat: 'VFR' }]),
          });
        }
        if (urlStr.includes('/taf')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                {
                  icaoId: 'KJFK',
                  rawTAF: 'TAF test',
                  fcsts: [
                    {
                      timeFrom: Math.floor(Date.now() / 1000),
                      timeTo: Math.floor(Date.now() / 1000) + 3600,
                      fcstChange: 'BECMG',
                      wdir: 180,
                      wspd: 5,
                      visib: 10,
                      ceil: 5000,
                      wxString: '',
                      raw: 'BECMG test',
                    },
                    {
                      timeFrom: Math.floor(Date.now() / 1000) + 3600,
                      timeTo: Math.floor(Date.now() / 1000) + 7200,
                      fcstChange: 'PROB30',
                      wdir: 200,
                      wspd: 8,
                      visib: 6,
                      ceil: 3000,
                      wxString: '-RA',
                      raw: 'PROB30 test',
                    },
                  ],
                },
              ]),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      }) as typeof fetch);

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const tafs = result.data.tafs as { periods: Record<string, unknown>[] }[];
      expect(tafs[0].periods[0].type).toBe('becmg');
      expect(tafs[0].periods[1].type).toBe('prob');
    });

    it('should throw on METAR API error', async () => {
      globalThis.fetch = jest.fn((() =>
        Promise.resolve({ ok: false, status: 503 })) as unknown as typeof fetch);

      const conn = create({ enabled: true, stations: ['KJFK'] });
      await expect(conn.fetch()).rejects.toThrow('METAR API: 503');
    });
  });

  describe('validate', () => {
    it('should pass with stations configured', () => {
      const checks = validate({ enabled: true, stations: ['KJFK', 'KLGA'] });
      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
    });

    it('should fail with no stations', () => {
      const checks = validate({ enabled: true, stations: [] });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });
  });
});
