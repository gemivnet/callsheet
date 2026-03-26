import { jest } from '@jest/globals';

const { validate } = await import('../../src/connectors/actual-budget.js');
const { PASS, FAIL } = await import('../../src/test-icons.js');

describe('actual-budget connector', () => {
  // Note: We only test validate() here since create().fetch() requires
  // @actual-app/api which connects to a real server. Integration tests
  // would cover the full flow.

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
});
