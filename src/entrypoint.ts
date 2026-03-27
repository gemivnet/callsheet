#!/usr/bin/env node
/**
 * Docker entrypoint — dispatches based on MODE env var.
 *
 * - headless_local:  runs the CLI (passthrough to cli.ts)
 * - headless_docker: starts the cron scheduler, no UI
 * - headed_docker:   starts the cron scheduler + Express web server
 */
import 'dotenv/config';
import { startScheduler } from './scheduler.js';

const mode = (process.env.MODE ?? 'headless_local').toLowerCase();
const configPath = process.env.CONFIG_PATH ?? 'config.yaml';
const cronSchedule = process.env.CRON_SCHEDULE ?? '30 6 * * *';

async function main(): Promise<void> {
  console.log(`[entrypoint] Mode: ${mode}`);

  switch (mode) {
    case 'headless_local':
      // Passthrough to the CLI — import it and let commander handle args
      await import('./cli.js');
      break;

    case 'headless_docker':
      console.log('[entrypoint] Starting headless Docker mode...');
      startScheduler(cronSchedule, configPath);
      // Keep process alive
      console.log('[entrypoint] Scheduler running. Waiting for cron triggers...');
      break;

    case 'headed_docker': {
      console.log('[entrypoint] Starting headed Docker mode...');
      startScheduler(cronSchedule, configPath);

      const { startServer } = await import('./server.js');
      startServer();
      break;
    }

    default:
      console.error(`[entrypoint] Unknown MODE: ${mode}`);
      console.error('Valid modes: headless_local, headless_docker, headed_docker');
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error('[entrypoint] Fatal error:', e);
  process.exit(1);
});
