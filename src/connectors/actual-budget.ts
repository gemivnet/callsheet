import type { Connector, ConnectorConfig, ConnectorResult, Check } from "../types.js";
import { PASS, FAIL, INFO } from "../test-icons.js";

interface BudgetCategoryGroup {
  id: string;
  name: string;
  categories: Array<{
    id: string;
    name: string;
    budgeted: number;
    spent: number;
    balance: number;
  }>;
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: "actual_budget",
    description: "Actual Budget — recent transactions, spending summary, and budget alerts",

    async fetch(): Promise<ConnectorResult> {
      // Dynamic import since @actual-app/api uses CJS
      const api = await import("@actual-app/api");

      const serverURL = config.server_url as string;
      const password = config.password_env
        ? process.env[config.password_env as string] ?? ""
        : (config.password as string) ?? "";
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

      await api.init({
        dataDir: "/tmp/actual-budget-cache",
        serverURL,
        password,
      });

      try {
        await api.downloadBudget(syncId, budgetPassword ? { password: budgetPassword } : undefined);

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

        // Date range: last N days
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - lookbackDays);

        const fmt = (d: Date) => d.toISOString().slice(0, 10);

        // Fetch transactions across all accounts
        const allTransactions: Record<string, unknown>[] = [];
        for (const account of accounts) {
          const acct = account as { id: string; name: string; closed?: boolean };
          if (acct.closed) continue;

          const txns = await api.getTransactions(
            acct.id,
            fmt(startDate),
            fmt(endDate),
          );

          for (const t of txns as Array<{
            id: string;
            date: string;
            amount: number;
            payee: string;
            category: string;
            notes: string;
            account: string;
          }>) {
            allTransactions.push({
              date: t.date,
              amount: api.utils.integerToAmount(t.amount),
              payee: payeeMap.get(t.payee) ?? t.payee ?? "",
              category: categoryMap.get(t.category) ?? t.category ?? "Uncategorized",
              account: accountMap.get(t.account) ?? acct.name,
              notes: t.notes ?? "",
            });
          }
        }

        // Sort by date descending
        allTransactions.sort((a, b) =>
          (b.date as string).localeCompare(a.date as string),
        );

        // Compute spending summary by category
        const categoryTotals = new Map<string, number>();
        for (const t of allTransactions) {
          const amt = t.amount as number;
          if (amt < 0) {
            const cat = t.category as string;
            categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + Math.abs(amt));
          }
        }

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
          const budgetMonth = await api.getBudgetMonth(currentMonth) as unknown as {
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
                  status: "over_budget",
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
                  status: "on_pace_to_exceed",
                  pctUsed: Math.round(pctUsed * 100),
                  projectedOverage: Math.round((spent / monthProgress - budgeted) * 100) / 100,
                });
              }
            }
          }
        } catch (e) {
          // Budget data not available — skip alerts silently
        }

        return {
          source: "actual_budget",
          description:
            `Actual Budget: ${allTransactions.length} transactions over the last ${lookbackDays} days. ` +
            `Total spending: $${Math.round(totalSpent * 100) / 100}, Total income: $${Math.round(totalIncome * 100) / 100}. ` +
            (budgetAlerts.length
              ? `${budgetAlerts.length} budget alert(s) — categories over or on pace to exceed their monthly budget. `
              : "") +
            "Use this data to flag notable spending patterns, large purchases, upcoming bills, " +
            "or anything that connects to calendar events or tasks. " +
            "Budget alerts with status 'over_budget' are URGENT — surface them prominently. " +
            "Alerts with 'on_pace_to_exceed' are warnings — mention if relevant. " +
            "Mention spending insights only if they're genuinely useful — don't list every transaction.",
          data: {
            summary: {
              totalSpent: Math.round(totalSpent * 100) / 100,
              totalIncome: Math.round(totalIncome * 100) / 100,
              periodDays: lookbackDays,
              transactionCount: allTransactions.length,
            },
            spendingByCategory,
            budgetAlerts,
            recentTransactions: allTransactions.slice(0, 30),
          },
          priorityHint: "normal",
        };
      } finally {
        await api.shutdown();
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
    serverUrl
      ? [PASS, `Server: ${serverUrl}`, ""]
      : [FAIL, "server_url not configured", ""],
  );

  const syncId = config.sync_id as string | undefined;
  checks.push(
    syncId
      ? [PASS, `Sync ID: ${syncId}`, ""]
      : [FAIL, "sync_id not configured", ""],
  );

  const passwordEnv = config.password_env as string | undefined;
  if (passwordEnv) {
    const pw = process.env[passwordEnv] ?? "";
    checks.push(
      pw
        ? [PASS, `${passwordEnv} is set`, ""]
        : [FAIL, `${passwordEnv} is NOT set`, "Add it to .env"],
    );
  } else if (config.password) {
    checks.push([PASS, "Password configured inline", ""]);
  } else {
    checks.push([FAIL, "No password configured", "Set password or password_env"]);
  }

  const days = (config.lookback_days as number) ?? 7;
  checks.push([INFO, `Lookback: ${days} days`, ""]);

  return checks;
}
