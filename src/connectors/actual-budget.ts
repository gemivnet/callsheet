import { mkdirSync } from 'node:fs';
import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, INFO } from '../test-icons.js';
import { retry } from '../retry.js';

const DATA_DIR = '/tmp/actual-budget-cache';

/** Retries for the (otherwise-flaky) sync step against a home-hosted server. */
const AB_RETRIES = 2;
const AB_BASE_DELAY_MS = 1000;

function abOnRetry(label: string): (attempt: number, err: unknown, delayMs: number) => void {
  return (attempt, err, delayMs) => {
    console.log(
      `  actual_budget: ${label} attempt ${attempt} failed (${formatError(err)}), retrying in ${delayMs}ms...`,
    );
  };
}

/**
 * Produce a readable string for errors that don't stringify sanely.
 * @actual-app/api throws bare objects like `{ reason: 'network-failure' }`
 * which turn into the infamous "[object Object]" when String()'d. This
 * helper flattens them into something diagnostic.
 */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      return '[unserialisable error object]';
    }
  }
  return String(err);
}

interface BudgetCategoryGroup {
  id: string;
  name: string;
  categories: {
    id: string;
    name: string;
    budgeted: number;
    spent: number;
    balance: number;
  }[];
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'actual_budget',
    description: 'Actual Budget — recent transactions, spending summary, and budget alerts',

    async fetch(): Promise<ConnectorResult> {
      // Dynamic import since @actual-app/api uses CJS
      const api = await import('@actual-app/api');

      const serverURL = config.server_url as string;
      const password = config.password_env
        ? (process.env[config.password_env as string] ?? '')
        : ((config.password as string) ?? '');
      const syncId = config.sync_id as string;
      const budgetPassword = config.budget_password_env
        ? process.env[config.budget_password_env as string]
        : undefined;
      const lookbackDays = (config.lookback_days as number) ?? 7;

      // Suppress all noisy console output from @actual-app/api
      const origLog = console.log;
      const origWarn = console.warn;
      const origInfo = console.info;
      const noop = () => {};
      console.log = noop;
      console.warn = noop;
      console.info = noop;

      // @actual-app/api scandir()s dataDir during init and ENOENTs if it's
      // missing. /tmp is volatile on the server (cleared on reboot or by
      // systemd-tmpfiles), so create it every run.
      mkdirSync(DATA_DIR, { recursive: true });

      await retry(
        () =>
          api.init({
            dataDir: DATA_DIR,
            serverURL,
            password,
          }),
        { retries: AB_RETRIES, baseDelayMs: AB_BASE_DELAY_MS, onRetry: abOnRetry('init') },
      );

      try {
        await retry(
          () =>
            api.downloadBudget(syncId, budgetPassword ? { password: budgetPassword } : undefined),
          {
            retries: AB_RETRIES,
            baseDelayMs: AB_BASE_DELAY_MS,
            onRetry: abOnRetry('downloadBudget'),
          },
        );

        const accounts = await api.getAccounts();
        const categories = await api.getCategories();
        const payees = await api.getPayees();

        // Build lookup maps
        const accountMap = new Map<string, string>(
          accounts.map((a: { id: string; name: string }) => [a.id, a.name]),
        );
        const categoryMap = new Map<string, string>(
          categories.map((c: { id: string; name: string }) => [c.id, c.name]),
        );
        const payeeMap = new Map<string, string>(
          payees.map((p: { id: string; name: string }) => [p.id, p.name]),
        );

        // Date range: fetch a 2x window so we can compute week-over-week trends.
        // `lookbackDays` controls what's exposed in `recentTransactions`; the
        // trend window is always lookbackDays * 2 (default 14d) and is used
        // only for computing weekOverWeekByCategory.
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - lookbackDays);
        const trendStartDate = new Date();
        trendStartDate.setDate(trendStartDate.getDate() - lookbackDays * 2);
        const previousWindowEnd = new Date(startDate);

        const fmt = (d: Date) => d.toISOString().slice(0, 10);

        // Fetch transactions across all accounts (full trend window)
        const allTransactions: Record<string, unknown>[] = [];
        const previousPeriodTransactions: Record<string, unknown>[] = [];
        for (const account of accounts) {
          const acct = account as { id: string; name: string; closed?: boolean };
          if (acct.closed) continue;

          const txns = await api.getTransactions(acct.id, fmt(trendStartDate), fmt(endDate));

          for (const t of txns as {
            id: string;
            date: string;
            amount: number;
            payee: string;
            category: string;
            notes: string;
            account: string;
          }[]) {
            const txn = {
              date: t.date,
              amount: api.utils.integerToAmount(t.amount),
              payee: payeeMap.get(t.payee) ?? t.payee ?? '',
              category: categoryMap.get(t.category) ?? t.category ?? 'Uncategorized',
              account: accountMap.get(t.account) ?? acct.name,
              notes: t.notes ?? '',
            };
            // Bucket into current vs previous period for trend computation
            if (t.date >= fmt(startDate)) {
              allTransactions.push(txn);
            } else if (t.date >= fmt(trendStartDate) && t.date < fmt(previousWindowEnd)) {
              previousPeriodTransactions.push(txn);
            }
          }
        }

        // Sort by date descending
        allTransactions.sort((a, b) => (b.date as string).localeCompare(a.date as string));

        // Compute spending summary by category (current period only)
        const categoryTotals = new Map<string, number>();
        for (const t of allTransactions) {
          const amt = t.amount as number;
          if (amt < 0) {
            const cat = t.category as string;
            categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + Math.abs(amt));
          }
        }

        // Compute previous-period spending by category for week-over-week trends
        const previousCategoryTotals = new Map<string, number>();
        for (const t of previousPeriodTransactions) {
          const amt = t.amount as number;
          if (amt < 0) {
            const cat = t.category as string;
            previousCategoryTotals.set(cat, (previousCategoryTotals.get(cat) ?? 0) + Math.abs(amt));
          }
        }

        // Build week-over-week comparison: union of categories from both periods,
        // sorted by absolute dollar change descending. Capped to top 8 movers.
        const allCategoryNames = new Set<string>([
          ...categoryTotals.keys(),
          ...previousCategoryTotals.keys(),
        ]);
        const round = (n: number) => Math.round(n * 100) / 100;
        const weekOverWeekByCategory = [...allCategoryNames]
          .map((category) => {
            const currentWeek = round(categoryTotals.get(category) ?? 0);
            const previousWeek = round(previousCategoryTotals.get(category) ?? 0);
            const change = round(currentWeek - previousWeek);
            // pctChange is null when there's no previous-week baseline to compare against
            const pctChange = previousWeek > 0 ? Math.round((change / previousWeek) * 100) : null;
            return { category, currentWeek, previousWeek, change, pctChange };
          })
          .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
          .slice(0, 8);

        const spendingByCategory = [...categoryTotals.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([category, total]) => ({
            category,
            total: Math.round(total * 100) / 100,
          }));

        const totalSpent = spendingByCategory.reduce((s, c) => s + c.total, 0);
        const totalIncome = allTransactions
          .filter((t) => (t.amount as number) > 0)
          .reduce((s, t) => s + (t.amount as number), 0);

        // Budget vs actual comparison for current month
        const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
        const budgetAlerts: Record<string, unknown>[] = [];
        try {
          const budgetMonth = (await api.getBudgetMonth(currentMonth)) as unknown as {
            totalBudgeted: number;
            totalSpent: number;
            totalBalance: number;
            categoryGroups: BudgetCategoryGroup[];
          };

          const dayOfMonth = new Date().getDate();
          const daysInMonth = new Date(
            new Date().getFullYear(),
            new Date().getMonth() + 1,
            0,
          ).getDate();
          const monthProgress = dayOfMonth / daysInMonth;

          for (const group of budgetMonth.categoryGroups ?? []) {
            for (const cat of group.categories ?? []) {
              const budgeted = api.utils.integerToAmount(cat.budgeted ?? 0);
              const spent = Math.abs(api.utils.integerToAmount(cat.spent ?? 0));

              if (budgeted <= 0) continue; // Skip unbudgeted categories

              const pctUsed = spent / budgeted;
              const paceRatio = pctUsed / monthProgress; // >1 means ahead of pace

              if (pctUsed >= 1.0) {
                budgetAlerts.push({
                  category: cat.name,
                  group: group.name,
                  budgeted,
                  spent,
                  remaining: Math.round((budgeted - spent) * 100) / 100,
                  status: 'over_budget',
                  pctUsed: Math.round(pctUsed * 100),
                });
              } else if (paceRatio > 1.3 && spent > 20) {
                // Spending faster than expected (30%+ ahead of pace) and non-trivial
                budgetAlerts.push({
                  category: cat.name,
                  group: group.name,
                  budgeted,
                  spent,
                  remaining: Math.round((budgeted - spent) * 100) / 100,
                  status: 'on_pace_to_exceed',
                  pctUsed: Math.round(pctUsed * 100),
                  projectedOverage: Math.round((spent / monthProgress - budgeted) * 100) / 100,
                });
              }
            }
          }
        } catch {
          // Budget data not available — skip alerts silently
        }

        return {
          source: 'actual_budget',
          description:
            `Actual Budget: ${allTransactions.length} transactions over the last ${lookbackDays} days. ` +
            `Total spending: $${Math.round(totalSpent * 100) / 100}, Total income: $${Math.round(totalIncome * 100) / 100}. ` +
            "**Focus on TRENDS, not absolute budget percentages** — many of this household's " +
            '"budget" categories are aspirational tracking buckets, not real spending caps, so ' +
            '"X% over budget" is usually noise. Use `weekOverWeekByCategory` to flag real anomalies: ' +
            'a category that jumped meaningfully week-over-week, an unusually large single transaction, ' +
            'or spending that connects to a calendar event/task. Mention `budgetAlerts` only when a ' +
            'category is BOTH over and unusually elevated relative to last week. ' +
            "Don't list every transaction.",
          data: {
            summary: {
              totalSpent: Math.round(totalSpent * 100) / 100,
              totalIncome: Math.round(totalIncome * 100) / 100,
              periodDays: lookbackDays,
              transactionCount: allTransactions.length,
            },
            spendingByCategory,
            weekOverWeekByCategory,
            budgetAlerts,
            recentTransactions: allTransactions.slice(0, 30),
          },
          priorityHint: 'normal',
        };
      } finally {
        // Give @actual-app/api background tasks (advanceSchedulesService) time
        // to finish before shutdown nullifies the DB handle. Without this,
        // deferred schedule queries crash with "Cannot read properties of null".
        await new Promise((r) => setTimeout(r, 500));
        try {
          await api.shutdown();
        } catch {
          // Shutdown may fail if background tasks already closed the DB
        }
        console.log = origLog;
        console.warn = origWarn;
        console.info = origInfo;
      }
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];

  const serverUrl = config.server_url as string | undefined;
  checks.push(
    serverUrl ? [PASS, `Server: ${serverUrl}`, ''] : [FAIL, 'server_url not configured', ''],
  );

  const syncId = config.sync_id as string | undefined;
  checks.push(syncId ? [PASS, `Sync ID: ${syncId}`, ''] : [FAIL, 'sync_id not configured', '']);

  const passwordEnv = config.password_env as string | undefined;
  if (passwordEnv) {
    const pw = process.env[passwordEnv] ?? '';
    checks.push(
      pw
        ? [PASS, `${passwordEnv} is set`, '']
        : [FAIL, `${passwordEnv} is NOT set`, 'Add it to .env'],
    );
  } else if (config.password) {
    checks.push([PASS, 'Password configured inline', '']);
  } else {
    checks.push([FAIL, 'No password configured', 'Set password or password_env']);
  }

  const days = (config.lookback_days as number) ?? 7;
  checks.push([INFO, `Lookback: ${days} days`, '']);

  return checks;
}
