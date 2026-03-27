import cron from 'node-cron';
import { loadConfig, runPipeline } from './core.js';

let running = false;

/**
 * Run a single brief generation cycle.
 * Includes a mutex to prevent concurrent runs (e.g. scheduler + API trigger).
 */
export async function runGeneration(configPath: string): Promise<void> {
  if (running) {
    console.log('[scheduler] Generation already in progress, skipping.');
    return;
  }

  running = true;
  const startTime = Date.now();
  console.log(`[scheduler] Starting generation at ${new Date().toISOString()}`);

  try {
    const config = loadConfig(configPath);
    await runPipeline(config, { preview: true });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[scheduler] Generation complete in ${elapsed}s`);
  } catch (e) {
    console.error(`[scheduler] Generation failed:`, e);
  } finally {
    running = false;
  }
}

/**
 * Start the cron scheduler for Docker modes.
 * Runs brief generation on the given cron schedule.
 */
export function startScheduler(schedule: string, configPath: string): cron.ScheduledTask {
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron expression: ${schedule}`);
  }

  console.log(`[scheduler] Scheduled brief generation: ${schedule}`);
  console.log(`[scheduler] Config: ${configPath}`);
  console.log(`[scheduler] Timezone: ${process.env.TZ ?? 'system default'}`);

  const task = cron.schedule(schedule, () => {
    runGeneration(configPath).catch((e) => {
      console.error('[scheduler] Unhandled error in generation:', e);
    });
  });

  return task;
}

/** Check if a generation is currently running. */
export function isGenerating(): boolean {
  return running;
}
