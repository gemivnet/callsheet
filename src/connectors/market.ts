import type { Connector, ConnectorConfig, ConnectorResult, Check } from "../types.js";
import { PASS, FAIL } from "../test-icons.js";

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_SEARCH_NEWS = "https://query1.finance.yahoo.com/v1/finance/search";

interface NewsItem {
  title: string;
  publisher: string;
  providerPublishTime: number;
}

async function fetchNews(symbol: string): Promise<Record<string, unknown>[]> {
  try {
    const resp = await fetch(
      `${YAHOO_SEARCH_NEWS}?q=${encodeURIComponent(symbol)}&newsCount=5&quotesCount=0`,
      {
        headers: { "User-Agent": "callsheet-brief/1.0" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!resp.ok) return [];

    const json = (await resp.json()) as { news?: NewsItem[] };
    const news = json.news ?? [];

    return news.map((n) => ({
      title: n.title,
      publisher: n.publisher,
      age: timeSince(n.providerPublishTime),
    }));
  } catch {
    return [];
  }
}

function timeSince(unixSeconds: number): string {
  const hours = Math.floor((Date.now() / 1000 - unixSeconds) / 3600);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: "market",
    description: "Market — daily price snapshot and news for watched symbols",

    async fetch(): Promise<ConnectorResult> {
      const symbols = (config.symbols as string[]) ?? [];
      const results: Record<string, unknown>[] = [];

      for (const symbol of symbols) {
        try {
          const resp = await fetch(
            `${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=5d&interval=1d`,
            {
              headers: { "User-Agent": "callsheet-brief/1.0" },
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          const json = (await resp.json()) as {
            chart: {
              result: Array<{
                meta: Record<string, unknown>;
                indicators: {
                  quote: Array<{ close: (number | null)[] }>;
                };
              }>;
            };
          };
          const data = json.chart.result[0];
          const meta = data.meta;
          const closes = data.indicators.quote[0].close.filter(
            (c): c is number => c != null,
          );

          const current =
            (meta.regularMarketPrice as number) ?? closes.at(-1);
          const prevClose =
            (meta.previousClose as number) ??
            (closes.length >= 2 ? closes.at(-2) : null);

          const dayChange =
            current && prevClose
              ? ((current - prevClose) / prevClose) * 100
              : null;
          const weekChange =
            closes.length >= 2
              ? ((closes.at(-1)! - closes[0]) / closes[0]) * 100
              : null;

          // Fetch related news
          const news = await fetchNews(symbol);

          results.push({
            symbol,
            name: (meta.shortName as string) ?? (meta.longName as string) ?? symbol,
            price: current ? Math.round(current * 100) / 100 : null,
            dayChangePct: dayChange
              ? Math.round(dayChange * 100) / 100
              : null,
            weekChangePct: weekChange
              ? Math.round(weekChange * 100) / 100
              : null,
            currency: meta.currency ?? "USD",
            marketState: meta.marketState ?? "unknown",
            news,
          });
        } catch (e) {
          results.push({ symbol, error: String(e) });
        }
      }

      return {
        source: "market",
        description:
          `Market data and news for ${results.length} symbol(s). ` +
          "Each symbol includes price, daily/weekly change, and recent news headlines. " +
          "Surface news in the Executive Brief ONLY if it's genuinely significant — " +
          "major market moves (>2% weekly), earnings surprises, sector-shaking news, " +
          "or anything that could affect the user's holdings. " +
          "Skip routine analyst upgrades, minor fluctuations, and clickbait headlines.",
        data: { symbols: results },
        priorityHint: "low",
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const symbols = (config.symbols as string[]) ?? [];

  checks.push(
    symbols.length
      ? [PASS, `Symbols: ${symbols.join(", ")}`, ""]
      : [FAIL, "No symbols configured", ""],
  );

  return checks;
}
