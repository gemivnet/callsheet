/** Shared ANSI icons for connector diagnostics. */

const C = {
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
  RESET: '\x1b[0m',
} as const;

export const PASS = `${C.GREEN}\u2713${C.RESET}`;
export const FAIL = `${C.RED}\u2717${C.RESET}`;
export const WARN = `${C.YELLOW}\u26a0${C.RESET}`;
export const INFO = `${C.CYAN}\u2139${C.RESET}`;
export const SKIP = `${C.DIM}\u2013${C.RESET}`;
export { C };
