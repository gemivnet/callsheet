import { jest } from '@jest/globals';

// Mock all connector modules to avoid importing googleapis, @actual-app/api, etc.
jest.unstable_mockModule('../../src/connectors/weather.js', () => ({
  create: jest.fn().mockReturnValue({ name: 'weather', description: 'test', fetch: jest.fn() }),
  validate: jest.fn().mockReturnValue([]),
}));
jest.unstable_mockModule('../../src/connectors/todoist.js', () => ({
  create: jest.fn().mockReturnValue({ name: 'todoist', description: 'test', fetch: jest.fn() }),
  validate: jest.fn().mockReturnValue([]),
}));
jest.unstable_mockModule('../../src/connectors/google-calendar.js', () => ({
  create: jest
    .fn()
    .mockReturnValue({ name: 'google_calendar', description: 'test', fetch: jest.fn() }),
  validate: jest.fn().mockReturnValue([]),
  authFromConfig: jest.fn(),
}));
jest.unstable_mockModule('../../src/connectors/gmail.js', () => ({
  create: jest.fn().mockReturnValue({ name: 'gmail', description: 'test', fetch: jest.fn() }),
  validate: jest.fn().mockReturnValue([]),
  authFromConfig: jest.fn(),
}));
jest.unstable_mockModule('../../src/connectors/aviation-weather.js', () => ({
  create: jest
    .fn()
    .mockReturnValue({ name: 'aviation_weather', description: 'test', fetch: jest.fn() }),
  validate: jest.fn().mockReturnValue([]),
}));
jest.unstable_mockModule('../../src/connectors/market.js', () => ({
  create: jest.fn().mockReturnValue({ name: 'market', description: 'test', fetch: jest.fn() }),
  validate: jest.fn().mockReturnValue([]),
}));
jest.unstable_mockModule('../../src/connectors/home-assistant.js', () => ({
  create: jest
    .fn()
    .mockReturnValue({ name: 'home_assistant', description: 'test', fetch: jest.fn() }),
  validate: jest.fn().mockReturnValue([]),
}));
jest.unstable_mockModule('../../src/connectors/actual-budget.js', () => ({
  create: jest
    .fn()
    .mockReturnValue({ name: 'actual_budget', description: 'test', fetch: jest.fn() }),
  validate: jest.fn().mockReturnValue([]),
}));

const { getRegistry, loadConnectors } = await import('../../src/connectors/index.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getRegistry', () => {
  it('should return a Map of all 8 registered connectors', () => {
    const registry = getRegistry();
    expect(registry).toBeInstanceOf(Map);
    expect(registry.size).toBe(8);
  });

  it('should contain all expected connector names', () => {
    const registry = getRegistry();
    const expected = [
      'weather',
      'todoist',
      'google_calendar',
      'gmail',
      'aviation_weather',
      'market',
      'home_assistant',
      'actual_budget',
    ];
    for (const name of expected) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('should return a copy, not the original', () => {
    const r1 = getRegistry();
    const r2 = getRegistry();
    expect(r1).not.toBe(r2);
    // Mutating the copy shouldn't affect subsequent calls
    r1.delete('weather');
    expect(getRegistry().has('weather')).toBe(true);
  });

  it('each entry should have a factory function', () => {
    const registry = getRegistry();
    for (const [, entry] of registry) {
      expect(typeof entry.factory).toBe('function');
    }
  });

  it('google connectors should have auth handlers', () => {
    const registry = getRegistry();
    expect(registry.get('gmail')?.auth).toBeDefined();
    expect(registry.get('google_calendar')?.auth).toBeDefined();
  });

  it('non-google connectors should not have auth handlers', () => {
    const registry = getRegistry();
    expect(registry.get('weather')?.auth).toBeUndefined();
    expect(registry.get('todoist')?.auth).toBeUndefined();
    expect(registry.get('market')?.auth).toBeUndefined();
  });
});

describe('loadConnectors', () => {
  it('should return empty array when no connectors configured', () => {
    const result = loadConnectors({ connectors: {} });
    expect(result).toEqual([]);
  });

  it('should load enabled connectors', () => {
    const result = loadConnectors({
      connectors: {
        weather: { enabled: true, lat: 40, lon: -74 },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('weather');
  });

  it('should skip disabled connectors', () => {
    const result = loadConnectors({
      connectors: {
        weather: { enabled: false },
        market: { enabled: true, symbols: ['AAPL'] },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('market');
  });

  it('should skip unknown connectors with a warning', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = loadConnectors({
      connectors: {
        nonexistent_connector: { enabled: true },
      },
    });
    expect(result).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("No connector registered for 'nonexistent_connector'"),
    );
    logSpy.mockRestore();
  });

  it('should handle missing connectors key gracefully', () => {
    const result = loadConnectors({});
    expect(result).toEqual([]);
  });

  it('should load multiple connectors', () => {
    const result = loadConnectors({
      connectors: {
        weather: { enabled: true },
        market: { enabled: true },
        todoist: { enabled: true },
      },
    });
    expect(result).toHaveLength(3);
  });
});
