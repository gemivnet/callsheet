import { jest } from '@jest/globals';

// --- Mock setup for @actual-app/api (must be before any import that triggers it) ---
const mockInit = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockDownloadBudget = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockGetAccounts = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const mockGetCategories = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const mockGetPayees = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const mockGetTransactions = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const mockGetBudgetMonth = jest.fn<() => Promise<unknown>>().mockResolvedValue({ categoryGroups: [] });
const mockShutdown = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockIntegerToAmount = jest.fn<(n: number) => number>().mockImplementation((n: number) => n / 100);

jest.unstable_mockModule('@actual-app/api', () => ({
  default: {
    init: mockInit,
    downloadBudget: mockDownloadBudget,
    getAccounts: mockGetAccounts,
    getCategories: mockGetCategories,
    getPayees: mockGetPayees,
    getTransactions: mockGetTransactions,
    getBudgetMonth: mockGetBudgetMonth,
    shutdown: mockShutdown,
    utils: { integerToAmount: mockIntegerToAmount },
  },
  init: mockInit,
  downloadBudget: mockDownloadBudget,
  getAccounts: mockGetAccounts,
  getCategories: mockGetCategories,
  getPayees: mockGetPayees,
  getTransactions: mockGetTransactions,
  getBudgetMonth: mockGetBudgetMonth,
  shutdown: mockShutdown,
  utils: { integerToAmount: mockIntegerToAmount },
}));

const { create, validate } = await import('../../src/connectors/actual-budget.js');
const { PASS, FAIL } = await import('../../src/test-icons.js');

// --- Helpers ---
const baseConfig = {
  enabled: true,
  server_url: 'https://actual.example.com',
  sync_id: 'budget-123',
  password: 'secret',
};

function resetMocks() {
  jest.clearAllMocks();
  mockGetAccounts.mockResolvedValue([
    { id: 'acct1', name: 'Checking' },
  ]);
  mockGetCategories.mockResolvedValue([
    { id: 'cat1', name: 'Groceries' },
    { id: 'cat2', name: 'Dining' },
  ]);
  mockGetPayees.mockResolvedValue([
    { id: 'pay1', name: 'Whole Foods' },
    { id: 'pay2', name: 'Employer Inc' },
  ]);
  mockGetTransactions.mockResolvedValue([
    { id: 'tx1', date: '2026-03-27', amount: -5000, payee: 'pay1', category: 'cat1', account: 'acct1', notes: 'weekly shop' },
    { id: 'tx2', date: '2026-03-28', amount: -2500, payee: 'pay1', category: 'cat2', account: 'acct1', notes: '' },
    { id: 'tx3', date: '2026-03-26', amount: 100000, payee: 'pay2', category: '', account: 'acct1', notes: 'paycheck' },
  ]);
  mockGetBudgetMonth.mockResolvedValue({
    categoryGroups: [
      {
        name: 'Food',
        categories: [
          { name: 'Groceries', budgeted: 30000, spent: -5000, balance: 25000 },
          { name: 'Dining', budgeted: 10000, spent: -2500, balance: 7500 },
        ],
      },
    ],
  });
  mockIntegerToAmount.mockImplementation((n: number) => n / 100);
}

describe('actual-budget connector', () => {
  // ============================
  // validate() tests (existing)
  // ============================
  describe('validate', () => {
    it('should pass with server_url and sync_id configured', () => {
      process.env.ACTUAL_PASSWORD = 'secret';
      const checks = validate({
        enabled: true,
        server_url: 'https://actual.example.com',
        sync_id: 'abc-123',
        password_env: 'ACTUAL_PASSWORD',
      });
      expect(checks.filter(([icon]) => icon === PASS).length).toBeGreaterThanOrEqual(3);
      delete process.env.ACTUAL_PASSWORD;
    });

    it('should fail when server_url missing', () => {
      const checks = validate({
        enabled: true,
        sync_id: 'abc-123',
        password: 'test',
      });
      expect(checks.some(([icon, msg]) => icon === FAIL && msg.includes('server_url'))).toBe(true);
    });

    it('should fail when sync_id missing', () => {
      const checks = validate({
        enabled: true,
        server_url: 'https://actual.example.com',
        password: 'test',
      });
      expect(checks.some(([icon, msg]) => icon === FAIL && msg.includes('sync_id'))).toBe(true);
    });

    it('should pass with inline password', () => {
      const checks = validate({
        enabled: true,
        server_url: 'https://actual.example.com',
        sync_id: 'abc-123',
        password: 'mypassword',
      });
      expect(checks.some(([icon, msg]) => icon === PASS && msg.includes('Password'))).toBe(true);
    });

    it('should fail when password_env is set but env var missing', () => {
      delete process.env.ACTUAL_PASSWORD;
      const checks = validate({
        enabled: true,
        server_url: 'https://actual.example.com',
        sync_id: 'abc-123',
        password_env: 'ACTUAL_PASSWORD',
      });
      expect(checks.some(([icon, msg]) => icon === FAIL && msg.includes('NOT set'))).toBe(true);
    });

    it('should fail when no password configured at all', () => {
      const checks = validate({
        enabled: true,
        server_url: 'https://actual.example.com',
        sync_id: 'abc-123',
      });
      expect(checks.some(([icon, msg]) => icon === FAIL && msg.includes('password'))).toBe(true);
    });
  });

  // ============================
  // create().fetch() tests
  // ============================
  describe('create().fetch()', () => {
    beforeEach(() => {
      resetMocks();
    });

    it('should return correct structure with transactions and spending summary', async () => {
      const connector = create(baseConfig);
      const result = await connector.fetch();

      expect(result.source).toBe('actual_budget');
      expect(result.priorityHint).toBe('normal');
      expect(result.data).toBeDefined();

      const data = result.data as Record<string, unknown>;
      const summary = data.summary as Record<string, unknown>;
      expect(summary.transactionCount).toBe(3);
      expect(summary.totalSpent).toBe(75); // 50 + 25
      expect(summary.totalIncome).toBe(1000);
      expect(summary.periodDays).toBe(7);

      const spending = data.spendingByCategory as { category: string; total: number }[];
      expect(spending.length).toBe(2);
      // Groceries $50 > Dining $25
      expect(spending[0].category).toBe('Groceries');
      expect(spending[0].total).toBe(50);
      expect(spending[1].category).toBe('Dining');
      expect(spending[1].total).toBe(25);
    });

    it('should sort transactions by date descending', async () => {
      const connector = create(baseConfig);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const txns = data.recentTransactions as { date: string }[];
      expect(txns[0].date).toBe('2026-03-28');
      expect(txns[1].date).toBe('2026-03-27');
      expect(txns[2].date).toBe('2026-03-26');
    });

    it('should generate over_budget alert when pctUsed >= 1.0', async () => {
      mockGetBudgetMonth.mockResolvedValue({
        categoryGroups: [
          {
            name: 'Food',
            categories: [
              { name: 'Groceries', budgeted: 5000, spent: -6000, balance: -1000 },
            ],
          },
        ],
      });

      const connector = create(baseConfig);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const alerts = data.budgetAlerts as Record<string, unknown>[];
      expect(alerts.length).toBe(1);
      expect(alerts[0].status).toBe('over_budget');
      expect(alerts[0].category).toBe('Groceries');
      expect(alerts[0].group).toBe('Food');
      expect(alerts[0].budgeted).toBe(50);
      expect(alerts[0].spent).toBe(60);
    });

    it('should generate on_pace_to_exceed alert when paceRatio > 1.3 and spent > 20', async () => {
      // We need monthProgress to be low so paceRatio is high.
      // Today is 2026-03-28, so dayOfMonth=28, daysInMonth=31, monthProgress=28/31 ≈ 0.903
      // For paceRatio > 1.3: pctUsed / monthProgress > 1.3
      // With monthProgress ≈ 0.903, we need pctUsed > 1.3 * 0.903 ≈ 1.174
      // But pctUsed >= 1.0 triggers over_budget first.
      // We need: pctUsed < 1.0 AND pctUsed/monthProgress > 1.3
      // So pctUsed > 1.3 * 0.903 ≈ 1.174 — but that's >= 1.0 so it triggers over_budget.
      // Actually at day 28/31, any pctUsed >= 1.0 is over_budget and < 1.0 with pace > 1.3
      // needs pctUsed > 1.3 * 0.903 which is > 1.0 — so it always hits over_budget first at end of month.
      // We need to test this with a month where we're early. Since we can't control Date, let's
      // make the math work: budgeted high, spent moderate but enough.
      // Actually, pctUsed = spent/budgeted. If budgeted=200 (20000 cents), spent=190 (19000 cents):
      // pctUsed = 190/200 = 0.95, paceRatio = 0.95/0.903 = 1.052 — not enough.
      // Need pctUsed/0.903 > 1.3, so pctUsed > 1.174 — that's over_budget.
      // At day 28 of 31, on_pace_to_exceed is impossible because monthProgress is too high.
      // Let's mock Date to be early in the month.
      const realDate = globalThis.Date;
      const mockDate = new Date('2026-03-05T12:00:00Z');
      // dayOfMonth=5, daysInMonth=31, monthProgress=5/31≈0.161
      // pctUsed > 1.3 * 0.161 ≈ 0.21 and pctUsed < 1.0 and spent > 20
      // budgeted=200 (20000), spent=50 (5000): pctUsed=0.25, paceRatio=0.25/0.161=1.55 ✓
      const MockDateClass = class extends realDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(mockDate.getTime());
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            super(...(args as [any]));
          }
        }
      } as unknown as DateConstructor;
      globalThis.Date = MockDateClass;

      mockGetBudgetMonth.mockResolvedValue({
        categoryGroups: [
          {
            name: 'Food',
            categories: [
              { name: 'Groceries', budgeted: 20000, spent: -5000, balance: 15000 },
            ],
          },
        ],
      });

      try {
        const connector = create(baseConfig);
        const result = await connector.fetch();

        const data = result.data as Record<string, unknown>;
        const alerts = data.budgetAlerts as Record<string, unknown>[];
        expect(alerts.length).toBe(1);
        expect(alerts[0].status).toBe('on_pace_to_exceed');
        expect(alerts[0].category).toBe('Groceries');
        expect(alerts[0].group).toBe('Food');
        expect(alerts[0].projectedOverage).toBeDefined();
      } finally {
        globalThis.Date = realDate;
      }
    });

    it('should skip closed accounts', async () => {
      mockGetAccounts.mockResolvedValue([
        { id: 'acct1', name: 'Checking', closed: false },
        { id: 'acct2', name: 'Old Savings', closed: true },
      ]);
      mockGetTransactions.mockResolvedValue([]);

      const connector = create(baseConfig);
      await connector.fetch();

      // getTransactions should only be called for the open account
      expect(mockGetTransactions).toHaveBeenCalledTimes(1);
      expect(mockGetTransactions.mock.calls[0][0]).toBe('acct1');
    });

    it('should pass budget password when configured via budget_password_env', async () => {
      process.env.TEST_BUDGET_PW = 'budgetpass';
      const config = { ...baseConfig, budget_password_env: 'TEST_BUDGET_PW' };

      const connector = create(config);
      await connector.fetch();

      expect(mockDownloadBudget).toHaveBeenCalledWith('budget-123', { password: 'budgetpass' });
      delete process.env.TEST_BUDGET_PW;
    });

    it('should not pass budget password when not configured', async () => {
      const connector = create(baseConfig);
      await connector.fetch();

      expect(mockDownloadBudget).toHaveBeenCalledWith('budget-123', undefined);
    });

    it('should default lookback_days to 7', async () => {
      const connector = create(baseConfig);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const summary = data.summary as Record<string, unknown>;
      expect(summary.periodDays).toBe(7);
    });

    it('should use custom lookback_days', async () => {
      const config = { ...baseConfig, lookback_days: 14 };
      const connector = create(config);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const summary = data.summary as Record<string, unknown>;
      expect(summary.periodDays).toBe(14);
    });

    it('should suppress console.log/warn/info during fetch and restore after', async () => {
      const origLog = console.log;
      const origWarn = console.warn;
      const origInfo = console.info;

      // Track whether console was suppressed during API calls
      let logDuringFetch: typeof console.log | undefined;
      mockGetAccounts.mockImplementation(async () => {
        logDuringFetch = console.log;
        // Call the suppressed console methods to exercise the noop function
        console.log('should be suppressed');
        console.warn('should be suppressed');
        console.info('should be suppressed');
        return [{ id: 'acct1', name: 'Checking' }];
      });

      const connector = create(baseConfig);
      await connector.fetch();

      // During fetch, console.log should have been a noop (not the original)
      expect(logDuringFetch).not.toBe(origLog);

      // After fetch, console should be restored
      expect(console.log).toBe(origLog);
      expect(console.warn).toBe(origWarn);
      expect(console.info).toBe(origInfo);
    });

    it('should call shutdown even when an error occurs', async () => {
      mockGetAccounts.mockRejectedValue(new Error('API failure'));

      const connector = create(baseConfig);
      await expect(connector.fetch()).rejects.toThrow('API failure');

      expect(mockShutdown).toHaveBeenCalledTimes(1);
    });

    it('should restore console even when an error occurs', async () => {
      const origLog = console.log;
      const origWarn = console.warn;
      const origInfo = console.info;

      mockGetAccounts.mockRejectedValue(new Error('API failure'));

      const connector = create(baseConfig);
      await expect(connector.fetch()).rejects.toThrow('API failure');

      expect(console.log).toBe(origLog);
      expect(console.warn).toBe(origWarn);
      expect(console.info).toBe(origInfo);
    });

    it('should silently catch getBudgetMonth failures', async () => {
      mockGetBudgetMonth.mockRejectedValue(new Error('Budget not available'));

      const connector = create(baseConfig);
      const result = await connector.fetch();

      // Should succeed with empty budget alerts
      const data = result.data as Record<string, unknown>;
      const alerts = data.budgetAlerts as Record<string, unknown>[];
      expect(alerts.length).toBe(0);
      expect(result.source).toBe('actual_budget');
    });

    it('should resolve payee and category names via lookup maps', async () => {
      const connector = create(baseConfig);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const txns = data.recentTransactions as Record<string, unknown>[];
      const groceryTxn = txns.find((t) => t.notes === 'weekly shop');
      expect(groceryTxn!.payee).toBe('Whole Foods');
      expect(groceryTxn!.category).toBe('Groceries');
      expect(groceryTxn!.account).toBe('Checking');
    });

    it('should fall back to raw IDs when lookup maps have no match', async () => {
      mockGetTransactions.mockResolvedValue([
        { id: 'tx1', date: '2026-03-27', amount: -5000, payee: 'unknown-payee', category: 'unknown-cat', account: 'acct1', notes: '' },
      ]);

      const connector = create(baseConfig);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const txns = data.recentTransactions as Record<string, unknown>[];
      expect(txns[0].payee).toBe('unknown-payee');
      expect(txns[0].category).toBe('unknown-cat');
    });

    it('should cap recentTransactions at 30', async () => {
      const manyTxns = Array.from({ length: 50 }, (_, i) => ({
        id: `tx${i}`,
        date: '2026-03-27',
        amount: -100,
        payee: 'pay1',
        category: 'cat1',
        account: 'acct1',
        notes: '',
      }));
      mockGetTransactions.mockResolvedValue(manyTxns);

      const connector = create(baseConfig);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const txns = data.recentTransactions as unknown[];
      expect(txns.length).toBe(30);
    });

    it('should skip unbudgeted categories (budgeted <= 0) in budget alerts', async () => {
      mockGetBudgetMonth.mockResolvedValue({
        categoryGroups: [
          {
            name: 'Income',
            categories: [
              { name: 'Salary', budgeted: 0, spent: -1000, balance: -1000 },
            ],
          },
        ],
      });

      const connector = create(baseConfig);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const alerts = data.budgetAlerts as Record<string, unknown>[];
      expect(alerts.length).toBe(0);
    });

    it('should include budget alert count in description when alerts exist', async () => {
      mockGetBudgetMonth.mockResolvedValue({
        categoryGroups: [
          {
            name: 'Food',
            categories: [
              { name: 'Groceries', budgeted: 5000, spent: -6000, balance: -1000 },
            ],
          },
        ],
      });

      const connector = create(baseConfig);
      const result = await connector.fetch();

      expect(result.description).toContain('1 budget alert(s)');
    });

    it('should fall back to empty string when password_env references unset var', async () => {
      delete process.env.NONEXISTENT_PW;
      const config = {
        enabled: true,
        server_url: 'https://actual.example.com',
        sync_id: 'budget-123',
        password_env: 'NONEXISTENT_PW',
      };

      const connector = create(config);
      await connector.fetch();

      expect(mockInit).toHaveBeenCalledWith({
        dataDir: '/tmp/actual-budget-cache',
        serverURL: 'https://actual.example.com',
        password: '',
      });
    });

    it('should fall back to empty string when no password or password_env', async () => {
      const config = {
        enabled: true,
        server_url: 'https://actual.example.com',
        sync_id: 'budget-123',
      };

      const connector = create(config);
      await connector.fetch();

      expect(mockInit).toHaveBeenCalledWith({
        dataDir: '/tmp/actual-budget-cache',
        serverURL: 'https://actual.example.com',
        password: '',
      });
    });

    it('should handle null/undefined payee, category, and notes in transactions', async () => {
      mockGetTransactions.mockResolvedValue([
        { id: 'tx1', date: '2026-03-27', amount: -1000, payee: null, category: null, account: 'acct1', notes: null },
      ]);

      const connector = create(baseConfig);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const txns = data.recentTransactions as Record<string, unknown>[];
      expect(txns[0].payee).toBe('');
      expect(txns[0].category).toBe('Uncategorized');
      expect(txns[0].notes).toBe('');
    });

    it('should handle missing categoryGroups in budget month', async () => {
      mockGetBudgetMonth.mockResolvedValue({});

      const connector = create(baseConfig);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const alerts = data.budgetAlerts as Record<string, unknown>[];
      expect(alerts.length).toBe(0);
    });

    it('should handle missing categories array in a category group', async () => {
      mockGetBudgetMonth.mockResolvedValue({
        categoryGroups: [
          { name: 'Empty Group' },
        ],
      });

      const connector = create(baseConfig);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const alerts = data.budgetAlerts as Record<string, unknown>[];
      expect(alerts.length).toBe(0);
    });

    it('should handle null budgeted/spent values in budget categories', async () => {
      mockGetBudgetMonth.mockResolvedValue({
        categoryGroups: [
          {
            name: 'Food',
            categories: [
              { name: 'Unknown', budgeted: null, spent: null, balance: 0 },
            ],
          },
        ],
      });

      const connector = create(baseConfig);
      const result = await connector.fetch();

      // budgeted defaults to 0 via ?? 0, so budgeted <= 0 skips it
      const data = result.data as Record<string, unknown>;
      const alerts = data.budgetAlerts as Record<string, unknown>[];
      expect(alerts.length).toBe(0);
    });

    it('should fall back to acct.name when account ID not in accountMap', async () => {
      // Transaction references an account ID that doesn't match any account's id
      mockGetAccounts.mockResolvedValue([
        { id: 'acct1', name: 'Checking' },
      ]);
      mockGetTransactions.mockResolvedValue([
        { id: 'tx1', date: '2026-03-27', amount: -1000, payee: 'pay1', category: 'cat1', account: 'unknown-acct', notes: '' },
      ]);

      const connector = create(baseConfig);
      const result = await connector.fetch();

      const data = result.data as Record<string, unknown>;
      const txns = data.recentTransactions as Record<string, unknown>[];
      // Falls back to acct.name (the account being iterated), which is 'Checking'
      expect(txns[0].account).toBe('Checking');
    });

    it('should handle budget_password_env pointing to unset env var', async () => {
      delete process.env.NONEXISTENT_BUDGET_PW;
      const config = { ...baseConfig, budget_password_env: 'NONEXISTENT_BUDGET_PW' };

      const connector = create(config);
      await connector.fetch();

      // undefined budget password means no password option passed
      expect(mockDownloadBudget).toHaveBeenCalledWith('budget-123', undefined);
    });

    it('should use password_env to get password from environment', async () => {
      process.env.TEST_ACTUAL_PW = 'envpassword';
      const config = {
        enabled: true,
        server_url: 'https://actual.example.com',
        sync_id: 'budget-123',
        password_env: 'TEST_ACTUAL_PW',
      };

      const connector = create(config);
      await connector.fetch();

      expect(mockInit).toHaveBeenCalledWith({
        dataDir: '/tmp/actual-budget-cache',
        serverURL: 'https://actual.example.com',
        password: 'envpassword',
      });
      delete process.env.TEST_ACTUAL_PW;
    });
  });
});
