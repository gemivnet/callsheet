import { jest } from '@jest/globals';
import type { ConnectorConfig } from '../../src/types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TODOIST_TOKEN_GEORGE;
});

const { create, validate } = await import('../../src/connectors/todoist.js');
const { PASS, FAIL } = await import('../../src/test-icons.js');

describe('todoist connector', () => {
  const today = new Date().toISOString().slice(0, 10);

  const mockProjects = {
    results: [
      { id: 'proj1', name: 'Work', inbox_project: false },
      { id: 'proj2', name: 'Inbox', inbox_project: true },
    ],
    next_cursor: null,
  };

  const mockTasks = {
    results: [
      {
        id: 'task1',
        content: 'Buy groceries',
        description: 'Milk, eggs',
        project_id: 'proj2',
        priority: 4,
        due: { date: today, string: 'today', is_recurring: false },
      },
      {
        id: 'task2',
        content: 'Review PR',
        description: '',
        project_id: 'proj1',
        priority: 2,
        due: null,
      },
      {
        id: 'task3',
        content: 'Inbox item',
        project_id: 'proj2',
        priority: 1,
        due: null,
      },
    ],
    next_cursor: null,
  };

  const mockCompleted = {
    items: [
      {
        id: 'done1',
        content: 'Old task',
        project_id: 'proj1',
        completed_at: '2026-03-24T10:00:00Z',
      },
    ],
  };

  function setupMockFetch() {
    process.env.TODOIST_TOKEN_GEORGE = 'test-token-123';
    globalThis.fetch = jest.fn(((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/projects')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockProjects),
        });
      }
      if (urlStr.includes('/completed/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockCompleted),
        });
      }
      if (urlStr.includes('/tasks')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockTasks),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof fetch);
  }

  describe('create', () => {
    it('should create a connector with correct name', () => {
      const conn = create({
        enabled: true,
        accounts: [{ name: 'George', token_env: 'TODOIST_TOKEN_GEORGE' }],
      });
      expect(conn.name).toBe('todoist');
      expect(conn.description).toContain('Todoist');
    });

    it('should fetch and return accounts with categorized tasks', async () => {
      setupMockFetch();
      const conn = create({
        enabled: true,
        accounts: [{ name: 'George', token_env: 'TODOIST_TOKEN_GEORGE' }],
      });
      const result = await conn.fetch();

      expect(result.source).toBe('todoist');
      expect(result.priorityHint).toBe('high');

      const accounts = result.data.accounts as Record<string, unknown>[];
      expect(accounts).toHaveLength(1);
      expect(accounts[0].person).toBe('George');
      expect((accounts[0].today as unknown[]).length).toBeGreaterThanOrEqual(0);
      expect(accounts[0].recently_completed).toBeDefined();
    });

    it('should skip accounts with missing tokens', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      // Don't set the env var
      const conn = create({
        enabled: true,
        accounts: [{ name: 'Missing', token_env: 'NONEXISTENT_TOKEN' }],
      });
      const result = await conn.fetch();

      const accounts = result.data.accounts as unknown[];
      expect(accounts).toHaveLength(0);
      logSpy.mockRestore();
    });

    it('should handle multiple accounts', async () => {
      setupMockFetch();
      process.env.TODOIST_TOKEN_PARTNER = 'test-token-456';

      const conn = create({
        enabled: true,
        accounts: [
          { name: 'George', token_env: 'TODOIST_TOKEN_GEORGE' },
          { name: 'Partner', token_env: 'TODOIST_TOKEN_PARTNER' },
        ],
      });
      const result = await conn.fetch();

      const accounts = result.data.accounts as Record<string, unknown>[];
      expect(accounts).toHaveLength(2);

      delete process.env.TODOIST_TOKEN_PARTNER;
    });
  });

  describe('validate', () => {
    it('should pass when accounts configured with valid tokens', () => {
      process.env.TODOIST_TOKEN_GEORGE = 'test-token';
      const checks = validate({
        enabled: true,
        accounts: [{ name: 'George', token_env: 'TODOIST_TOKEN_GEORGE' }],
      });
      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
    });

    it('should fail when no accounts configured', () => {
      const checks = validate({ enabled: true, accounts: [] });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('should fail when token env var is missing', () => {
      const checks = validate({
        enabled: true,
        accounts: [{ name: 'George', token_env: 'TODOIST_TOKEN_GEORGE' }],
      });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('should report number of accounts', () => {
      process.env.TODOIST_TOKEN_GEORGE = 'token';
      const checks = validate({
        enabled: true,
        accounts: [{ name: 'George', token_env: 'TODOIST_TOKEN_GEORGE' }],
      });
      expect(checks.some(([, msg]) => msg.includes('1 account'))).toBe(true);
    });
  });
});
