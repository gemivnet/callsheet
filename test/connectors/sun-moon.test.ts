const { create, validate, computeSunMoon, moonPhaseName } = await import(
  '../../src/connectors/sun-moon.js'
);
const { PASS, FAIL, INFO } = await import('../../src/test-icons.js');

describe('moonPhaseName', () => {
  it('maps the eight standard phases', () => {
    expect(moonPhaseName(0)).toBe('New Moon');
    expect(moonPhaseName(0.1)).toBe('Waxing Crescent');
    expect(moonPhaseName(0.25)).toBe('First Quarter');
    expect(moonPhaseName(0.35)).toBe('Waxing Gibbous');
    expect(moonPhaseName(0.5)).toBe('Full Moon');
    expect(moonPhaseName(0.6)).toBe('Waning Gibbous');
    expect(moonPhaseName(0.75)).toBe('Last Quarter');
    expect(moonPhaseName(0.9)).toBe('Waning Crescent');
  });

  it('treats the extreme ends of the cycle as New Moon', () => {
    expect(moonPhaseName(0.99)).toBe('New Moon');
    expect(moonPhaseName(0.001)).toBe('New Moon');
  });
});

describe('computeSunMoon', () => {
  it('returns sunrise, sunset and daylight hours for a mid-latitude location', () => {
    // Chicago in June — long daylight day.
    const summer = new Date(Date.UTC(2026, 5, 21, 12, 0, 0));
    const report = computeSunMoon(summer, 41.88, -87.63);
    expect(report.date).toBe('2026-06-21');
    expect(report.sunrise).toBeDefined();
    expect(report.sunset).toBeDefined();
    expect(report.solarNoon).toBeDefined();
    expect(report.civilDawn).toBeDefined();
    expect(report.civilDusk).toBeDefined();
    expect(report.daylightHours).toBeGreaterThan(14); // summer solstice ≈ 15 h
    expect(report.daylightHours).toBeLessThan(16);
  });

  it('returns shorter daylight in winter than summer', () => {
    const winter = computeSunMoon(new Date(Date.UTC(2026, 11, 21, 12, 0, 0)), 41.88, -87.63);
    const summer = computeSunMoon(new Date(Date.UTC(2026, 5, 21, 12, 0, 0)), 41.88, -87.63);
    expect(winter.daylightHours).toBeLessThan(summer.daylightHours!);
  });

  it('returns a moon phase name in the standard set', () => {
    const report = computeSunMoon(new Date(Date.UTC(2026, 3, 11, 12, 0, 0)), 41.88, -87.63);
    expect([
      'New Moon',
      'Waxing Crescent',
      'First Quarter',
      'Waxing Gibbous',
      'Full Moon',
      'Waning Gibbous',
      'Last Quarter',
      'Waning Crescent',
    ]).toContain(report.moonPhaseName);
    expect(report.moonIllumination).toBeGreaterThanOrEqual(0);
    expect(report.moonIllumination).toBeLessThanOrEqual(1);
  });
});

describe('sun-moon connector', () => {
  describe('create', () => {
    it('has the correct name', () => {
      const conn = create({ enabled: true, lat: 41.88, lon: -87.63 });
      expect(conn.name).toBe('sun_moon');
    });

    it('returns empty data when lat/lon are not configured', async () => {
      const conn = create({ enabled: true });
      const result = await conn.fetch();
      expect(result.source).toBe('sun_moon');
      expect(result.data).toEqual({});
      expect(result.priorityHint).toBe('low');
    });

    it('produces today and tomorrow reports plus a brightMoon flag', async () => {
      const conn = create({ enabled: true, lat: 41.88, lon: -87.63 });
      const result = await conn.fetch();

      expect(result.source).toBe('sun_moon');
      expect(result.priorityHint).toBe('low');

      const today = result.data.today as { date: string; sunrise?: string; moonPhaseName?: string };
      const tomorrow = result.data.tomorrow as { date: string };
      expect(today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(tomorrow.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(today.date).not.toBe(tomorrow.date);
      expect(typeof result.data.brightMoon).toBe('boolean');
    });

    it('description includes the moon phase name', async () => {
      const conn = create({ enabled: true, lat: 41.88, lon: -87.63 });
      const result = await conn.fetch();
      expect(result.description).toMatch(
        /New Moon|Crescent|Quarter|Gibbous|Full Moon/,
      );
    });
  });

  describe('validate', () => {
    it('fails when lat/lon are missing', () => {
      const checks = validate({ enabled: true });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('fails when lat is out of range', () => {
      const checks = validate({ enabled: true, lat: 95, lon: 0 });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('fails when lon is out of range', () => {
      const checks = validate({ enabled: true, lat: 0, lon: 181 });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('passes with valid coordinates and reports a sunrise time', () => {
      const checks = validate({ enabled: true, lat: 41.88, lon: -87.63 });
      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
      expect(checks.some(([icon, msg]) => icon === INFO && String(msg).includes('sunrise'))).toBe(
        true,
      );
    });
  });
});
