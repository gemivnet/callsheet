import { jest } from '@jest/globals';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const {
  create,
  validate,
  nmDistance,
  pointInPolygon,
  computeDensityAltitude,
  parseVisibility,
  ceilingFrom,
  flightCategory,
  parseTafPeriods,
  worstCategory,
  pirepAnchor,
} = await import('../../src/connectors/aviation-weather.js');
const { PASS, FAIL, WARN, INFO } = await import('../../src/test-icons.js');

/**
 * Build a fetch mock that dispatches on URL path to the handlers passed in.
 * Anything not matched returns an empty-array 200 so the connector degrades
 * cleanly on that endpoint.
 */
function mockFetch(handlers: Record<string, unknown>): void {
  globalThis.fetch = jest.fn(((url: string | URL | Request) => {
    const urlStr = url.toString();
    for (const [key, body] of Object.entries(handlers)) {
      if (urlStr.includes(key)) {
        // safeFetchJson now reads text() then JSON.parses it, so JSON
        // handlers must surface their payload via text() too. String
        // handlers (METAR raw, AFD text) pass through unchanged.
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return Promise.resolve({ ok: true, text: () => Promise.resolve(text) });
      }
    }
    // Default: empty 200 so the endpoint "succeeds" with nothing.
    return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
  }) as typeof fetch);
}

const EPOCH_NOW = Math.floor(Date.now() / 1000);

describe('aviation-weather helpers', () => {
  describe('nmDistance', () => {
    it('returns 0 for identical points', () => {
      expect(nmDistance(41.9, -87.6, 41.9, -87.6)).toBeCloseTo(0, 5);
    });

    it('computes approximately correct distance between KJFK and KLAX', () => {
      // JFK ~40.64N/-73.78W, LAX ~33.94N/-118.41W → ~2144 nm great-circle.
      const d = nmDistance(40.6413, -73.7781, 33.9425, -118.4081);
      expect(d).toBeGreaterThan(2100);
      expect(d).toBeLessThan(2200);
    });

    it('computes short distance for adjacent airports', () => {
      // KLOT Lewis Univ (~41.6/-88.1) to KORD Chicago O'Hare (~41.98/-87.9) ≈ 27 nm
      const d = nmDistance(41.6, -88.1, 41.98, -87.9);
      expect(d).toBeGreaterThan(15);
      expect(d).toBeLessThan(40);
    });
  });

  describe('pointInPolygon', () => {
    const square = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 10 },
      { lat: 10, lon: 10 },
      { lat: 10, lon: 0 },
    ];

    it('returns true for an interior point', () => {
      expect(pointInPolygon(5, 5, square)).toBe(true);
    });

    it('returns false for an exterior point', () => {
      expect(pointInPolygon(15, 5, square)).toBe(false);
      expect(pointInPolygon(5, -1, square)).toBe(false);
    });
  });

  describe('computeDensityAltitude', () => {
    it('returns null when OAT is missing', () => {
      expect(computeDensityAltitude(600, undefined, 29.92)).toBeNull();
    });

    it('returns null when altimeter is missing', () => {
      expect(computeDensityAltitude(600, 15, undefined)).toBeNull();
    });

    it('returns pressure altitude = field elevation at standard altimeter', () => {
      const result = computeDensityAltitude(1000, 13, 29.92);
      // At 29.92 inHg, PA == field elev
      expect(result?.pressureAltFt).toBe(1000);
      // ISA @ 1000 ft = 15 - 2 = 13, so DA == PA
      expect(result?.densityAltFt).toBe(1000);
    });

    it('reports DA above field elevation on a hot day', () => {
      // 1000 ft field, 35C (hot), 29.92 inHg.
      // PA = 1000. ISA = 13. DA = 1000 + 120*(35-13) = 3640.
      const result = computeDensityAltitude(1000, 35, 29.92);
      expect(result?.pressureAltFt).toBe(1000);
      expect(result?.densityAltFt).toBe(3640);
    });

    it('reports DA below field elevation on a cold day with high pressure', () => {
      // 600 ft field, -5C, 30.20 inHg.
      // PA = 600 + (29.92-30.20)*1000 = 600 - 280 = 320.
      // ISA @ 600 ft = 13.8. DA = 320 + 120*(-5-13.8) = 320 - 2256 = -1936.
      const result = computeDensityAltitude(600, -5, 30.2);
      expect(result?.pressureAltFt).toBe(320);
      expect(result?.densityAltFt).toBe(-1936);
    });
  });
});

describe('flight category helpers', () => {
  describe('parseVisibility', () => {
    it('reads numbers and the API\'s "more than" strings', () => {
      expect(parseVisibility(7)).toBe(7);
      expect(parseVisibility('10+')).toBe(10);
      expect(parseVisibility('6+')).toBe(6);
      expect(parseVisibility('P6SM')).toBe(6);
    });

    it('reads fractions, mixed numbers and "less than"', () => {
      expect(parseVisibility('1/2')).toBe(0.5);
      expect(parseVisibility('1 1/2')).toBe(1.5);
      expect(parseVisibility('M1/4')).toBe(0.25);
      expect(parseVisibility('3SM')).toBe(3);
    });

    it('returns undefined for anything else', () => {
      expect(parseVisibility(undefined)).toBeUndefined();
      expect(parseVisibility(null)).toBeUndefined();
      expect(parseVisibility('')).toBeUndefined();
      expect(parseVisibility('n/a')).toBeUndefined();
      expect(parseVisibility(Number.NaN)).toBeUndefined();
    });
  });

  describe('ceilingFrom', () => {
    it('is the lowest broken or overcast base', () => {
      expect(
        ceilingFrom([
          { cover: 'FEW', base: 800 },
          { cover: 'BKN', base: 2500 },
          { cover: 'OVC', base: 1800 },
        ]),
      ).toBe(1800);
    });

    it('is null when no layer forms a ceiling', () => {
      expect(ceilingFrom([{ cover: 'SCT', base: 900 }])).toBeNull();
      expect(ceilingFrom([])).toBeNull();
    });

    it('uses vertical visibility when present', () => {
      expect(ceilingFrom([], 200)).toBe(200);
      expect(ceilingFrom([{ cover: 'VV', base: 100 }])).toBe(100);
    });

    it('is undefined when the report says nothing about clouds', () => {
      expect(ceilingFrom(undefined)).toBeUndefined();
    });

    it('ignores malformed layers', () => {
      expect(ceilingFrom([{ cover: 'BKN' }, { cover: 7, base: 100 }, null])).toBeNull();
    });
  });

  describe('flightCategory', () => {
    it('applies the FAA thresholds at their boundaries', () => {
      expect(flightCategory(499, 10).category).toBe('LIFR');
      expect(flightCategory(500, 10).category).toBe('IFR');
      expect(flightCategory(999, 10).category).toBe('IFR');
      expect(flightCategory(1000, 10).category).toBe('MVFR');
      expect(flightCategory(3000, 10).category).toBe('MVFR');
      expect(flightCategory(3100, 10).category).toBe('VFR');
      expect(flightCategory(null, 0.75).category).toBe('LIFR');
      expect(flightCategory(null, 2).category).toBe('IFR');
      expect(flightCategory(null, 5).category).toBe('MVFR');
      expect(flightCategory(null, 6).category).toBe('VFR');
    });

    it('never calls it VFR when an element is unknown', () => {
      expect(flightCategory(undefined, 10)).toEqual({ basis: 'visibility only' });
      expect(flightCategory(5000, undefined)).toEqual({ basis: 'ceiling only' });
      expect(flightCategory(undefined, undefined)).toEqual({});
    });

    it('still reports bad weather from a single known element', () => {
      expect(flightCategory(undefined, 2)).toEqual({ category: 'IFR', basis: 'visibility only' });
      expect(flightCategory(400, undefined)).toEqual({ category: 'LIFR', basis: 'ceiling only' });
    });
  });

  describe('parseTafPeriods', () => {
    it('returns nothing for a TAF without periods', () => {
      expect(parseTafPeriods({})).toEqual([]);
    });

    it('decodes low-level wind shear', () => {
      const [p] = parseTafPeriods({
        fcsts: [
          {
            fcstChange: 'FM',
            visib: '6+',
            clouds: [],
            wshearHgt: 20,
            wshearDir: 270,
            wshearSpd: 45,
          },
          { fcstChange: 'FM', visib: '6+', clouds: [], wshearHgt: 20, wshearSpd: 40 },
        ],
      });
      expect(p.windShear).toBe('2000 ft 270° 45 kt');
    });

    it('omits wind shear when the TAF has none', () => {
      const [p] = parseTafPeriods({ fcsts: [{ visib: '6+', clouds: [] }] });
      expect(p.windShear).toBeUndefined();
      expect(p.flightCategory).toBe('VFR');
    });
  });

  describe('worstCategory', () => {
    it('picks the worst classified period', () => {
      expect(worstCategory([{ flightCategory: 'VFR' }, { flightCategory: 'IFR' }, {}])).toBe('IFR');
    });

    it('says unknown rather than VFR when nothing could be classified', () => {
      expect(worstCategory([{}, {}])).toBe('unknown');
      expect(worstCategory([])).toBe('unknown');
    });
  });

  describe('pirepAnchor', () => {
    it('skips identifiers the PIREP endpoint rejects', () => {
      expect(pirepAnchor(['9X9', 'KABC', 'KDEF'])).toBe('KABC');
    });

    it('falls back to the first station when none is ICAO-shaped', () => {
      expect(pirepAnchor(['9X9'])).toBe('9X9');
      expect(pirepAnchor([])).toBeUndefined();
    });
  });
});

describe('aviation-weather connector', () => {
  describe('create', () => {
    it('has the correct name', () => {
      const conn = create({ enabled: true, stations: ['KJFK'] });
      expect(conn.name).toBe('aviation_weather');
    });

    it('returns empty data when no stations configured', async () => {
      const conn = create({ enabled: true, stations: [] });
      const result = await conn.fetch();
      expect(result.source).toBe('aviation_weather');
      expect(result.data).toEqual({});
      expect(result.priorityHint).toBe('low');
    });

    // Fixtures follow the shape aviationweather.gov actually returns, recorded
    // from live responses: `fltCat` (not `fltcat`), a `clouds` array (there is
    // no `ceil` field), and visibilities that are sometimes strings like "10+".
    // The old fixtures used the field names the code assumed, which is how a
    // connector that could not read a single ceiling passed its tests.
    it('fetches METAR and TAF data', async () => {
      mockFetch({
        '/metar': [
          {
            icaoId: 'KJFK',
            rawOb: 'KJFK 251156Z 21010KT 10SM SCT250 18/06 A3012',
            temp: 18,
            dewp: 6,
            wdir: 210,
            wspd: 10,
            visib: '10+',
            clouds: [{ cover: 'SCT', base: 25000 }],
            altim: 1020,
            fltCat: 'VFR',
          },
        ],
        '/taf': [
          {
            icaoId: 'KJFK',
            rawTAF: 'TAF KJFK 251130Z ...',
            fcsts: [
              {
                timeFrom: EPOCH_NOW,
                timeTo: EPOCH_NOW + 3600,
                fcstChange: 'FM',
                wdir: 210,
                wspd: 12,
                visib: '6+',
                clouds: [{ cover: 'BKN', base: 5000, type: null }],
                wxString: null,
                raw: 'FM251200 21012KT P6SM BKN050',
              },
              {
                timeFrom: EPOCH_NOW + 3600,
                timeTo: EPOCH_NOW + 7200,
                fcstChange: 'TEMPO',
                wdir: 250,
                wspd: 15,
                wgst: 25,
                visib: 3,
                clouds: [{ cover: 'BKN', base: 1500, type: null }],
                wxString: '-RA',
                raw: 'TEMPO 2513/2516 25015G25KT 3SM -RA BKN015',
              },
            ],
          },
        ],
      });

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();

      expect(result.source).toBe('aviation_weather');
      expect(result.priorityHint).toBe('normal');

      const metars = result.data.metars as Record<string, unknown>[];
      expect(metars).toHaveLength(1);
      expect(metars[0].station).toBe('KJFK');
      expect(metars[0].flightCategory).toBe('VFR');
      expect(metars[0].visibilityMi).toBe(10);
      expect(metars[0].ceiling).toBeNull();

      const tafs = result.data.tafs as { periods: Record<string, unknown>[] }[];
      expect(tafs).toHaveLength(1);
      expect(tafs[0].periods).toHaveLength(2);
      expect(tafs[0].periods[0].flightCategory).toBe('VFR');
      expect(tafs[0].periods[0].ceiling).toBe(5000);
      expect(tafs[0].periods[0].type).toBe('from');
      expect(tafs[0].periods[1].flightCategory).toBe('MVFR');
      expect(tafs[0].periods[1].type).toBe('tempo');
      expect(tafs[0].periods[1].weather).toBe('-RA');
      expect(result.description).toContain('Current: KJFK VFR');
      expect(result.description).toContain('KJFK forecast worst: MVFR');
    });

    it('classifies a low overcast with good visibility as IFR, not VFR', async () => {
      mockFetch({
        '/metar': [
          {
            icaoId: 'KJFK',
            rawOb: 'KJFK 251156Z 00000KT 10SM OVC006 12/11 A3001',
            visib: '10+',
            clouds: [{ cover: 'OVC', base: 600 }],
            fltCat: null,
          },
        ],
        '/taf': [
          {
            icaoId: 'KJFK',
            rawTAF: 'TAF test',
            fcsts: [
              {
                timeFrom: EPOCH_NOW,
                timeTo: EPOCH_NOW + 3600,
                fcstChange: null,
                visib: '6+',
                clouds: [{ cover: 'OVC', base: 400, type: null }],
                raw: 'P6SM OVC004',
              },
              {
                timeFrom: EPOCH_NOW,
                timeTo: EPOCH_NOW + 3600,
                fcstChange: 'BECMG',
                visib: 0.5,
                clouds: [{ cover: 'VV', base: 100, type: null }],
                wxString: 'FG',
                raw: 'BECMG 1/2SM FG VV001',
              },
            ],
          },
        ],
      });

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const metars = result.data.metars as Record<string, unknown>[];
      const tafs = result.data.tafs as { periods: Record<string, unknown>[] }[];
      // No fltCat from the API: computed from the 600 ft overcast.
      expect(metars[0].flightCategory).toBe('IFR');
      expect(tafs[0].periods[0].flightCategory).toBe('LIFR');
      expect(tafs[0].periods[1].flightCategory).toBe('LIFR');
      expect(tafs[0].periods[1].type).toBe('becmg');
      expect(result.description).toContain('KJFK forecast worst: LIFR');
    });

    it('fills a TEMPO group from the prevailing conditions it does not mention', async () => {
      mockFetch({
        '/taf': [
          {
            icaoId: 'KJFK',
            rawTAF: 'TAF test',
            fcsts: [
              {
                timeFrom: EPOCH_NOW,
                timeTo: EPOCH_NOW + 7200,
                fcstChange: 'FM',
                visib: '6+',
                clouds: [{ cover: 'OVC', base: 800, type: null }],
                raw: 'FM P6SM OVC008',
              },
              {
                timeFrom: EPOCH_NOW,
                timeTo: EPOCH_NOW + 3600,
                fcstChange: 'TEMPO',
                visib: 4,
                raw: 'TEMPO 4SM -SHRA',
              },
            ],
          },
        ],
      });

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const tafs = result.data.tafs as { periods: Record<string, unknown>[] }[];
      // The TEMPO changes visibility only; the 800 ft overcast still applies.
      expect(tafs[0].periods[1].ceiling).toBe(800);
      expect(tafs[0].periods[1].flightCategory).toBe('IFR');
    });

    it('handles PROB change type in TAF', async () => {
      mockFetch({
        '/taf': [
          {
            icaoId: 'KJFK',
            rawTAF: 'TAF test',
            fcsts: [
              {
                timeFrom: EPOCH_NOW,
                timeTo: EPOCH_NOW + 3600,
                fcstChange: 'PROB30',
                visib: 6,
                clouds: [{ cover: 'BKN', base: 3000 }],
                wxString: '-RA',
                raw: 'PROB30 test',
              },
            ],
          },
        ],
      });
      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const tafs = result.data.tafs as { periods: Record<string, unknown>[] }[];
      expect(tafs[0].periods[0].type).toBe('prob');
      // A 3,000 ft ceiling is MVFR (at or below 3,000), not VFR.
      expect(tafs[0].periods[0].flightCategory).toBe('MVFR');
    });

    it('reports a product that failed, instead of reading it as quiet', async () => {
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const u = url.toString();
        if (u.includes('/pirep')) {
          return Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve('') });
        }
        return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
      }) as typeof fetch);
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();

      expect(result.data.unavailable).toEqual([expect.stringMatching(/^PIREPs: .*400/)]);
      expect(result.description).toContain('UNAVAILABLE this run');
      logSpy.mockRestore();
    });

    it('anchors the PIREP search on an ICAO station, and names fields with no reports', async () => {
      const urls: string[] = [];
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        urls.push(url.toString());
        if (url.toString().includes('/metar')) {
          return Promise.resolve({
            ok: true,
            text: () =>
              Promise.resolve(
                JSON.stringify([
                  { icaoId: 'KJFK', rawOb: 'x', visib: 10, clouds: [], fltCat: 'VFR' },
                ]),
              ),
          });
        }
        return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
      }) as typeof fetch);

      const conn = create({ enabled: true, stations: ['9X9', 'KJFK'] });
      const result = await conn.fetch();

      expect(urls.find((u) => u.includes('/pirep'))).toContain('id=KJFK');
      expect(result.data.stationsWithoutReports).toEqual(['9X9']);
      expect(result.description).toContain('No METAR or TAF at all for 9X9');
      expect(result.description).toContain('KJFK report observations but issue no TAF');
    });

    it('degrades gracefully when fetch throws (network error path)', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      // Every endpoint throws — hits the catch block in both safeFetchJson and safeFetchText.
      globalThis.fetch = jest.fn((() =>
        Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch);

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      expect(result.source).toBe('aviation_weather');
      expect(result.data.metars).toEqual([]);
      expect(result.data.afd).toBeUndefined();
      // At least one warning for the METAR failure path.
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
      logSpy.mockRestore();
    });

    it('logs and returns null when fetch throws a non-Error value', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      // eslint-disable-next-line prefer-promise-reject-errors
      globalThis.fetch = jest.fn((() => Promise.reject('plain string')) as unknown as typeof fetch);
      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      expect(result.data.metars).toEqual([]);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('plain string'));
      logSpy.mockRestore();
    });

    it('treats a 200 with empty body as silent null (quiet PIREPs/CWAs)', async () => {
      // AWC returns 200 with empty body when a product has no reports —
      // that's valid nothing-to-report, not a parse failure. Before the
      // fix, this path logged "Unexpected end of JSON input" every day.
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/pirep') || urlStr.includes('/cwa')) {
          // Empty 200 — the exact behavior observed in production.
          return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
        }
        return Promise.resolve({ ok: true, text: () => Promise.resolve('[]') });
      }) as typeof fetch);

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();

      expect(result.source).toBe('aviation_weather');
      // No noisy "Unexpected end of JSON input" log for the quiet case.
      const calls = logSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((m) => m.includes('Unexpected end of JSON'))).toBe(false);
      expect(calls.some((m) => m.includes('PIREPs failed'))).toBe(false);
      expect(calls.some((m) => m.includes('CWA failed'))).toBe(false);
      logSpy.mockRestore();
    });

    it('logs and returns null when a 200 body is unparseable JSON', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/metar')) {
          // Non-empty, non-JSON — distinct from the quiet-null case above.
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve('<html>500 error</html>'),
          });
        }
        return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
      }) as typeof fetch);

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();

      expect(result.data.metars).toEqual([]);
      const calls = logSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((m) => m.includes('unparseable JSON'))).toBe(true);
      logSpy.mockRestore();
    });

    it('degrades gracefully when the METAR endpoint errors', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/metar')) {
          return Promise.resolve({ ok: false, status: 503 });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
          text: () => Promise.resolve(''),
        });
      }) as typeof fetch);

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();

      // Expect an empty-but-shaped payload, not a throw.
      expect(result.source).toBe('aviation_weather');
      expect(result.data.metars).toEqual([]);
      expect(result.data.tafs).toEqual([]);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('METAR returned 503'));
      logSpy.mockRestore();
    });

    it('converts station elevation from meters to feet', async () => {
      mockFetch({
        '/stationinfo': [{ icaoId: 'KJFK', site: 'JFK INTL', lat: 40.64, lon: -73.78, elev: 4 }],
      });
      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const info = result.data.stationInfo as {
        station?: string;
        icaoId?: string;
        elevFt: number;
      }[];
      expect(info).toHaveLength(1);
      // 4 m × 3.28084 ≈ 13.12 → rounds to 13
      expect(info[0].elevFt).toBe(13);
    });

    it('shapes PIREP reports with turbulence, icing, and clouds', async () => {
      mockFetch({
        '/pirep': [
          {
            icaoId: 'KJFK',
            obsTime: EPOCH_NOW,
            acType: 'C172',
            lat: 40.64,
            lon: -73.78,
            fltLvl: 45,
            clouds: [{ cover: 'BKN', base: 3500 }],
            wxString: '-RA',
            tbInt1: 'LGT',
            tbType1: 'CHOP',
            icgInt1: 'TRC',
            icgType1: 'RIME',
            rawOb: 'UA /OV KJFK /TM 1200 /FL045 /TP C172 /SK BKN035 /TB LGT CHOP /IC TRC RIME',
          },
        ],
      });

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const pireps = result.data.pireps as Record<string, unknown>[];
      expect(pireps).toHaveLength(1);
      expect(pireps[0].station).toBe('KJFK');
      expect(pireps[0].altitudeFt).toBe(4500);
      expect(pireps[0].acType).toBe('C172');
      expect(pireps[0].turbulence).toBe('LGT CHOP');
      expect(pireps[0].icing).toBe('TRC RIME');
      expect(pireps[0].cloudsRaw).toContain('BKN');
    });

    it('caps PIREPs at 15', async () => {
      const many = Array.from({ length: 25 }, (_, i) => ({
        icaoId: 'KJFK',
        obsTime: EPOCH_NOW - i * 60,
        lat: 40.64,
        lon: -73.78,
        rawOb: `UA test ${i}`,
      }));
      mockFetch({ '/pirep': many });
      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      expect((result.data.pireps as unknown[]).length).toBe(15);
    });

    it('filters AIRMET/SIGMET polygons to stations within proximity', async () => {
      // Station at 40/-74. Polygon A surrounds it, polygon B is far away.
      mockFetch({
        '/stationinfo': [{ icaoId: 'KJFK', site: 'JFK', lat: 40, lon: -74, elev: 0 }],
        '/airsigmet': [
          {
            airSigmetType: 'SIGMET',
            hazard: 'CONVECTIVE',
            validTimeFrom: EPOCH_NOW,
            validTimeTo: EPOCH_NOW + 3600,
            coords: [
              { lat: 39, lon: -75 },
              { lat: 39, lon: -73 },
              { lat: 41, lon: -73 },
              { lat: 41, lon: -75 },
            ],
            rawAirSigmet: 'SIGMET ALPHA 1 CONVECTIVE TEST',
          },
          {
            airSigmetType: 'AIRMET',
            hazard: 'TURB',
            coords: [
              { lat: 30, lon: -100 },
              { lat: 30, lon: -98 },
              { lat: 32, lon: -98 },
              { lat: 32, lon: -100 },
            ],
            rawAirSigmet: 'AIRMET TURB TEST — far away',
          },
        ],
      });

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const hazards = result.data.airSigmets as {
        type: string;
        hazard: string;
        affectedStations: string[];
      }[];
      expect(hazards).toHaveLength(1);
      expect(hazards[0].type).toBe('SIGMET');
      expect(hazards[0].hazard).toBe('CONVECTIVE');
      expect(hazards[0].affectedStations).toContain('KJFK');
      // Hazard intersects → priorityHint escalates.
      expect(result.priorityHint).toBe('high');
    });

    it('collapses G-AIRMET forecast hours per (hazard, product)', async () => {
      const polygon = [
        { lat: 39, lon: -75 },
        { lat: 39, lon: -73 },
        { lat: 41, lon: -73 },
        { lat: 41, lon: -75 },
      ];
      // 3 forecast hours for the same hazard/product + 1 different one.
      // The sierra endpoint returns the mock body; tango/zulu default to [].
      const gAirmets = [
        {
          hazard: 'IFR',
          product: 'sierra',
          forecastHour: 0,
          validTime: '2026-04-11T12:00',
          coords: polygon,
        },
        {
          hazard: 'IFR',
          product: 'sierra',
          forecastHour: 3,
          validTime: '2026-04-11T15:00',
          coords: polygon,
        },
        {
          hazard: 'IFR',
          product: 'sierra',
          forecastHour: 6,
          validTime: '2026-04-11T18:00',
          coords: polygon,
        },
        {
          hazard: 'MTN OBSC',
          product: 'sierra',
          forecastHour: 0,
          validTime: '2026-04-11T12:00',
          coords: polygon,
        },
      ];
      mockFetch({
        '/stationinfo': [{ icaoId: 'KJFK', site: 'JFK', lat: 40, lon: -74, elev: 0 }],
        // Only sierra returns data; tango/zulu fall through to [].
        '/gairmet?format=json&type=sierra': gAirmets,
      });

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const gs = result.data.gAirmets as { hazard: string; forecastHours?: number[] }[];
      // Two distinct hazards → two entries (IFR collapsed, MTN OBSC on its own).
      expect(gs).toHaveLength(2);
      const ifr = gs.find((g) => g.hazard === 'IFR');
      expect(ifr?.forecastHours).toEqual([0, 3, 6]);
      const mtn = gs.find((g) => g.hazard === 'MTN OBSC');
      expect(mtn?.forecastHours).toEqual([0]);
    });

    it('filters CWAs by station proximity and shapes the report', async () => {
      const polygon = [
        { lat: 39, lon: -75 },
        { lat: 39, lon: -73 },
        { lat: 41, lon: -73 },
        { lat: 41, lon: -75 },
      ];
      mockFetch({
        '/stationinfo': [{ icaoId: 'KJFK', site: 'JFK', lat: 40, lon: -74, elev: 0 }],
        '/cwa': [
          {
            hazard: 'CONVECTIVE',
            validTimeFrom: EPOCH_NOW,
            validTimeTo: EPOCH_NOW + 3600,
            coords: polygon,
            cwaText: 'CWA — line of thunderstorms',
          },
        ],
      });
      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const cwas = result.data.cwas as { type: string; affectedStations: string[] }[];
      expect(cwas).toHaveLength(1);
      expect(cwas[0].type).toBe('CWA');
      expect(cwas[0].affectedStations).toContain('KJFK');
    });

    it('computes density altitude from METAR + station elevation', async () => {
      mockFetch({
        '/metar': [
          {
            icaoId: 'KJFK',
            rawOb: 'test',
            temp: 30,
            altim: 1013.25, // ~29.92 inHg
            fltCat: 'VFR',
          },
        ],
        '/stationinfo': [{ icaoId: 'KJFK', site: 'JFK', lat: 40, lon: -74, elev: 305 }], // ~1000 ft
      });

      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const da = result.data.densityAltitude as { fieldElevFt: number; densityAltFt: number }[];
      expect(da).toHaveLength(1);
      // 305 m → 1001 ft. Hot day → DA > field elevation.
      expect(da[0].fieldElevFt).toBe(1001);
      expect(da[0].densityAltFt).toBeGreaterThan(da[0].fieldElevFt);
    });

    it('trims a long AFD payload', async () => {
      const longAfd = 'A'.repeat(5000);
      mockFetch({ '/fcstdisc': longAfd });
      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      const afd = result.data.afd as string;
      expect(afd.length).toBeLessThanOrEqual(2600);
      expect(afd).toContain('[truncated]');
    });

    it('keeps a short AFD payload unchanged', async () => {
      mockFetch({ '/fcstdisc': 'Short AFD text.' });
      const conn = create({ enabled: true, stations: ['KJFK'] });
      const result = await conn.fetch();
      expect(result.data.afd).toBe('Short AFD text.');
    });
  });

  describe('validate', () => {
    it('passes with stations configured', () => {
      const checks = validate({ enabled: true, stations: ['KJFK', 'KLGA'] });
      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
      // Two INFO lines for the station listing.
      expect(checks.filter(([icon]) => icon === INFO).length).toBeGreaterThanOrEqual(2);
    });

    it('fails with no stations only when calendar derivation is off', () => {
      const checks = validate({ enabled: true, stations: [], derive_stations: false });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('accepts no stations when they will be read from the calendar', () => {
      const checks = validate({ enabled: true, stations: [] });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(false);
      expect(checks.some(([, label]) => label.includes('read from calendar events'))).toBe(true);
    });

    it('warns when a station looks like an IATA code', () => {
      const checks = validate({ enabled: true, stations: ['DEN'] });
      const warning = checks.find(([icon]) => icon === WARN);
      expect(warning?.[1]).toContain('IATA');
      expect(warning?.[2]).toContain('KDEN');
    });

    it('warns when a station is not a plausible identifier', () => {
      const checks = validate({ enabled: true, stations: ['NOT-AN-AIRPORT'] });
      expect(checks.some(([, label]) => label.includes('not a valid identifier shape'))).toBe(true);
    });

    it('warns when first station is non-ICAO and no wfo override', () => {
      const checks = validate({ enabled: true, stations: ['LFPG'] });
      expect(checks.some(([icon]) => icon === WARN)).toBe(true);
    });

    it('surfaces wfo override as INFO without warning', () => {
      const checks = validate({ enabled: true, stations: ['LFPG'], wfo: 'KLOT' });
      expect(checks.some(([icon]) => icon === WARN)).toBe(false);
      expect(
        checks.some(([icon, msg]) => icon === INFO && String(msg).includes('WFO override')),
      ).toBe(true);
    });

    it('surfaces pirep_radius_nm override as INFO', () => {
      const checks = validate({ enabled: true, stations: ['KJFK'], pirep_radius_nm: 200 });
      expect(
        checks.some(([icon, msg]) => icon === INFO && String(msg).includes('PIREP radius: 200nm')),
      ).toBe(true);
    });
  });
});
