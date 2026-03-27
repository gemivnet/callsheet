import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import yaml from 'js-yaml';
import { loadConfig, runPipeline } from './core.js';
import { getRegistry } from './connectors/index.js';
import { getMonthlyUsageData, getUsageSummary } from './usage.js';
import { isGenerating } from './scheduler.js';
import type { CallsheetConfig } from './types.js';

const startedAt = new Date().toISOString();

function getOutputDir(config?: CallsheetConfig): string {
  return config?.output_dir ?? process.env.OUTPUT_DIR ?? 'output';
}

function getConfigPath(): string {
  return process.env.CONFIG_PATH ?? 'config.yaml';
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  // Serve static frontend
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const staticDir = join(__dirname, '..', 'web', 'dist');
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
  }

  // ─── Health ────────────────────────────────────────────────────────────────

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      mode: process.env.MODE ?? 'headed_docker',
      started_at: startedAt,
      uptime_seconds: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
      generating: isGenerating(),
    });
  });

  // ─── Briefs ────────────────────────────────────────────────────────────────

  app.get('/api/briefs', (_req, res) => {
    const outputDir = getOutputDir();
    try {
      const files = readdirSync(outputDir)
        .filter((f) => f.startsWith('callsheet_') && f.endsWith('.json'))
        .sort()
        .reverse();

      const briefs = files.map((f) => {
        const date = f.replace('callsheet_', '').replace('.json', '');
        try {
          const data = JSON.parse(readFileSync(join(outputDir, f), 'utf-8')) as {
            title?: string;
            subtitle?: string;
            sections?: unknown[];
          };
          return {
            date,
            title: data.title ?? 'Untitled',
            subtitle: data.subtitle ?? null,
            sections: data.sections?.length ?? 0,
          };
        } catch {
          return { date, title: 'Untitled', subtitle: null, sections: 0 };
        }
      });

      res.json({ briefs });
    } catch {
      res.json({ briefs: [] });
    }
  });

  app.get('/api/briefs/:date', (req, res) => {
    const outputDir = getOutputDir();
    const briefPath = join(outputDir, `callsheet_${req.params.date}.json`);

    if (!existsSync(briefPath)) {
      res.status(404).json({ error: `No brief found for ${req.params.date}` });
      return;
    }

    try {
      const data: unknown = JSON.parse(readFileSync(briefPath, 'utf-8'));
      res.json(data);
    } catch {
      res.status(500).json({ error: 'Failed to read brief' });
    }
  });

  app.get('/api/briefs/:date/pdf', (req, res) => {
    const outputDir = getOutputDir();
    const pdfPath = join(outputDir, `callsheet_${req.params.date}.pdf`);

    if (!existsSync(pdfPath)) {
      res.status(404).json({ error: `No PDF found for ${req.params.date}` });
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="callsheet_${req.params.date}.pdf"`);
    res.send(readFileSync(pdfPath));
  });

  app.post('/api/briefs/generate', async (_req, res) => {
    if (isGenerating()) {
      res.status(409).json({ error: 'Generation already in progress' });
      return;
    }

    try {
      const config = loadConfig(getConfigPath());
      const result = await runPipeline(config, { preview: true });

      res.json({
        success: true,
        date: new Date().toISOString().slice(0, 10),
        title: result.brief.title,
        pdfPath: result.pdfPath,
        jsonPath: result.jsonPath,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ success: false, error: message });
    }
  });

  // ─── Connectors ────────────────────────────────────────────────────────────

  app.get('/api/connectors', (_req, res) => {
    try {
      const config = loadConfig(getConfigPath());
      const registry = getRegistry();
      const connectorConfigs = config.connectors ?? {};

      const connectors = [...registry].map(([name, entry]) => {
        const connConfig = connectorConfigs[name];
        return {
          name,
          enabled: connConfig?.enabled !== false && connConfig !== undefined,
          has_auth: !!entry.auth,
          has_validate: !!entry.validate,
        };
      });

      res.json({ connectors });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/connectors/:name/test', (req, res) => {
    try {
      const config = loadConfig(getConfigPath());
      const registry = getRegistry();
      const entry = registry.get(req.params.name);

      if (!entry) {
        res.status(404).json({ error: `Unknown connector: ${req.params.name}` });
        return;
      }

      const connConfig = config.connectors?.[req.params.name] ?? {};
      const checks = entry.validate ? entry.validate(connConfig) : [];

      res.json({
        connector: req.params.name,
        checks: checks.map(([icon, msg, detail]) => ({ icon, message: msg, detail })),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  });

  // ─── Config ────────────────────────────────────────────────────────────────

  app.get('/api/config', (_req, res) => {
    try {
      const raw = readFileSync(getConfigPath(), 'utf-8');
      const config = yaml.load(raw);
      res.json(config);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  });

  app.put('/api/config', (req, res) => {
    try {
      const yamlStr = yaml.dump(req.body, { lineWidth: 120, noRefs: true });
      writeFileSync(getConfigPath(), yamlStr);
      res.json({ success: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  });

  // ─── Memory ────────────────────────────────────────────────────────────────

  app.get('/api/memory', (_req, res) => {
    const memDir = join(getOutputDir(), 'memory');

    if (!existsSync(memDir)) {
      res.json({ memories: [] });
      return;
    }

    try {
      const files = readdirSync(memDir)
        .filter((f) => f.startsWith('memory_') && f.endsWith('.json'))
        .sort()
        .reverse();

      const memories = files.map((f) => {
        try {
          return JSON.parse(readFileSync(join(memDir, f), 'utf-8')) as {
            date: string;
            insights: string[];
          };
        } catch {
          return { date: f.replace('memory_', '').replace('.json', ''), insights: [] };
        }
      });

      res.json({ memories });
    } catch {
      res.json({ memories: [] });
    }
  });

  app.delete('/api/memory/:date', (req, res) => {
    const memPath = join(getOutputDir(), 'memory', `memory_${req.params.date}.json`);

    if (!existsSync(memPath)) {
      res.status(404).json({ error: `No memory found for ${req.params.date}` });
      return;
    }

    try {
      unlinkSync(memPath);
      res.json({ success: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  });

  // ─── Schedule ──────────────────────────────────────────────────────────────

  app.get('/api/schedule', (_req, res) => {
    res.json({
      cron: process.env.CRON_SCHEDULE ?? '30 6 * * *',
      timezone: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  // ─── Usage ─────────────────────────────────────────────────────────────────

  app.get('/api/usage', (req, res) => {
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;
    const outputDir = getOutputDir();

    try {
      const summary = getUsageSummary(outputDir, month);
      res.json(summary);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/usage/history', (req, res) => {
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;
    const outputDir = getOutputDir();

    try {
      const data = getMonthlyUsageData(outputDir, month);
      res.json(data);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  });

  // ─── Logs ──────────────────────────────────────────────────────────────────

  app.get('/api/logs', (req, res) => {
    const outputDir = getOutputDir();
    const logPath = join(outputDir, 'cron.log');
    const lines = typeof req.query.lines === 'string' ? parseInt(req.query.lines, 10) : 100;

    if (!existsSync(logPath)) {
      res.json({ lines: [], total: 0 });
      return;
    }

    try {
      const content = readFileSync(logPath, 'utf-8');
      const allLines = content.split('\n').filter(Boolean);
      res.json({
        lines: allLines.slice(-lines),
        total: allLines.length,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  });

  // ─── SPA fallback ──────────────────────────────────────────────────────────

  app.get('/{*path}', (_req, res) => {
    const indexPath = join(staticDir, 'index.html');
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(200).send('Callsheet API is running. Frontend not built yet.');
    }
  });

  return app;
}

export function startServer(port: number = parseInt(process.env.PORT ?? '3000', 10)): void {
  const app = createApp();
  app.listen(port, () => {
    console.log(`[server] Dashboard running at http://localhost:${port}`);
  });
}
