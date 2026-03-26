import { C, PASS, FAIL, WARN, INFO, SKIP } from '../src/test-icons.js';

describe('test-icons', () => {
  it('should export ANSI color codes', () => {
    expect(C.BOLD).toBe('\x1b[1m');
    expect(C.DIM).toBe('\x1b[2m');
    expect(C.GREEN).toBe('\x1b[32m');
    expect(C.RED).toBe('\x1b[31m');
    expect(C.YELLOW).toBe('\x1b[33m');
    expect(C.CYAN).toBe('\x1b[36m');
    expect(C.RESET).toBe('\x1b[0m');
  });

  it('should export colored icon strings', () => {
    expect(PASS).toContain('✓');
    expect(FAIL).toContain('✗');
    expect(WARN).toContain('⚠');
    expect(INFO).toContain('ℹ');
    expect(SKIP).toContain('–');
  });

  it('icons should include RESET code to prevent color bleed', () => {
    expect(PASS).toContain(C.RESET);
    expect(FAIL).toContain(C.RESET);
    expect(WARN).toContain(C.RESET);
    expect(INFO).toContain(C.RESET);
    expect(SKIP).toContain(C.RESET);
  });
});
