#!/usr/bin/env node
/**
 * Docker entrypoint — dispatches based on MODE env var.
 *
 * - headless_local:  runs the CLI (passthrough to cli.ts)
 * - headless_docker: starts the cron scheduler, no UI
 * - headed_docker:   starts the cron scheduler + Next.js web server
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

      // Start Next.js server as a child process
      const { spawn } = await import('node:child_process');
      const { join } = await import('node:path');

      const nextBin = join(process.cwd(), 'web', 'node_modules', '.bin', 'next');
      const port = process.env.PORT ?? '3000';

      console.log(`[entrypoint] Starting web dashboard on port ${port}...`);
      const server = spawn(nextBin, ['start', '-p', port], {
        cwd: join(process.cwd(), 'web'),
        stdio: 'inherit',
        env: { ...process.env, PORT: port },
      });

      server.on('error', (e) => {
        console.error('[entrypoint] Failed to start web server:', e);
        process.exit(1);
      });

      server.on('exit', (code) => {
        console.error(`[entrypoint] Web server exited with code ${code}`);
        process.exit(code ?? 1);
      });
      break;
    }

    default:
      console.error(`[entrypoint] Unknown MODE: ${mode}`);
      console.error('Valid modes: headless_local, headless_docker, headed_docker');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('[entrypoint] Fatal error:', e);
  process.exit(1);
});
