import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL } from '../test-icons.js';
import { retry, HttpError } from '../retry.js';

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_SEARCH_NEWS = 'https://query1.finance.yahoo.com/v1/finance/search';

/** Yahoo rate-limits sporadically; retries catch the 429/5xx blips. */
const MARKET_RETRIES = 3;
const MARKET_BASE_DELAY_MS = 500;

/**
 * "Near 52-week high" threshold. Anything closing within this fraction of the
 * trailing 1-year peak counts as at/near the high. Keeps the flag from getting
 * noisy when price just momentarily pokes above.
 */
const NEAR_52W_THRESHOLD = 0.005; // within 0.5%

function marketOnRetry(label: string): (attempt: number, err: unknown, delayMs: number) => void {
  return (attempt, err, delayMs) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `  market: ${label} attempt ${attempt} failed (${msg}), retrying in ${delayMs}ms...`,
    );
  };
}

interface NewsItem {
  title: string;
  publisher: string;
  providerPublishTime: number;
}

async function fetchNews(symbol: string): Promise<Record<string, unknown>[]> {
  try {
    const json = await retry(
      async () => {
        const resp = await fetch(
          `${YAHOO_SEARCH_NEWS}?q=${encodeURIComponent(symbol)}&newsCount=5&quotesCount=0`,
          {
            headers: { 'User-Agent': 'callsheet-brief/1.0' },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!resp.ok) throw new HttpError(resp.status, `news ${symbol}: ${resp.status}`);
        return (await resp.json()) as { news?: NewsItem[] };
      },
      {
        retries: MARKET_RETRIES,
        baseDelayMs: MARKET_BASE_DELAY_MS,
        onRetry: marketOnRetry(`news ${symbol}`),
      },
    );
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

/**
 * Compute 52-week high/low and a "near high" flag from a 1-year daily close
 * series. Returns null fields when the series is too short (e.g. new listing).
 * Threshold is tight (0.5%) so the flag only fires when the model should
 * genuinely call out an ATH — not every modest up-day.
 */
export function compute52wRange(
  closes: number[],
  current: number | null,
): {
  high52w: number | null;
  low52w: number | null;
  pctFromHigh52w: number | null;
  atNear52wHigh: boolean;
  pctFromLow52w: number | null;
  atNear52wLow: boolean;
} {
  if (!closes.length || current == null) {
    return {
      high52w: null,
      low52w: null,
      pctFromHigh52w: null,
      atNear52wHigh: false,
      pctFromLow52w: null,
      atNear52wLow: false,
    };
  }
  const high = Math.max(...closes, current);
  const low = Math.min(...closes, current);
  const pctFromHigh = high === 0 ? null : (current - high) / high;
  const pctFromLow = low === 0 ? null : (current - low) / low;
  return {
    high52w: Math.round(high * 100) / 100,
    low52w: Math.round(low * 100) / 100,
    pctFromHigh52w: pctFromHigh === null ? null : Math.round(pctFromHigh * 10000) / 100,
    atNear52wHigh: pctFromHigh !== null && pctFromHigh >= -NEAR_52W_THRESHOLD,
    pctFromLow52w: pctFromLow === null ? null : Math.round(pctFromLow * 10000) / 100,
    atNear52wLow: pctFromLow !== null && pctFromLow <= NEAR_52W_THRESHOLD,
  };
}

function timeSince(unixSeconds: number): string {
  const hours = Math.floor((Date.now() / 1000 - unixSeconds) / 3600);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'market',
    description: 'Market — daily price snapshot and news for watched symbols',

    async fetch(): Promise<ConnectorResult> {
      const symbols = (config.symbols as string[]) ?? [];
      const results: Record<string, unknown>[] = [];

      for (const symbol of symbols) {
        try {
          // 1-year range gets us the full 52-week window for ATH/ATL flags
          // while still being cheap. Yahoo caps at ~252 trading days here.
          const json = await retry(
            async () => {
              const resp = await fetch(
                `${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=1y&interval=1d`,
                {
                  headers: { 'User-Agent': 'callsheet-brief/1.0' },
                  signal: AbortSignal.timeout(10_000),
                },
              );
              if (!resp.ok) throw new HttpError(resp.status, `chart ${symbol}: ${resp.status}`);
              return (await resp.json()) as {
                chart: {
                  result: {
                    meta: Record<string, unknown>;
                    indicators: {
                      quote: { close: (number | null)[] }[];
                    };
                  }[];
                };
              };
            },
            {
              retries: MARKET_RETRIES,
              baseDelayMs: MARKET_BASE_DELAY_MS,
              onRetry: marketOnRetry(`chart ${symbol}`),
            },
          );
          const data = json.chart.result[0];
          const { meta } = data;
          const closes = data.indicators.quote[0].close.filter((c): c is number => c != null);

          const current = (meta.regularMarketPrice as number) ?? closes.at(-1) ?? null;
          const prevClose =
            (meta.previousClose as number) ?? (closes.length >= 2 ? closes.at(-2) : null);

          const dayChange = current && prevClose ? ((current - prevClose) / prevClose) * 100 : null;
          // Weekly = last 5 trading days, not the whole 1y window we pull.
          const weekCloses = closes.slice(-5);
          const weekChange =
            weekCloses.length >= 2
              ? ((weekCloses.at(-1)! - weekCloses[0]) / weekCloses[0]) * 100
              : null;

          const range = compute52wRange(closes, current ?? null);

          // Fetch related news
          const news = await fetchNews(symbol);

          results.push({
            symbol,
            name: (meta.shortName as string) ?? (meta.longName as string) ?? symbol,
            price: current ? Math.round(current * 100) / 100 : null,
            dayChangePct: dayChange ? Math.round(dayChange * 100) / 100 : null,
            weekChangePct: weekChange ? Math.round(weekChange * 100) / 100 : null,
            currency: meta.currency ?? 'USD',
            marketState: meta.marketState ?? 'unknown',
            high52w: range.high52w,
            low52w: range.low52w,
            pctFromHigh52w: range.pctFromHigh52w,
            atNear52wHigh: range.atNear52wHigh,
            pctFromLow52w: range.pctFromLow52w,
            atNear52wLow: range.atNear52wLow,
            news,
          });
        } catch (e) {
          results.push({ symbol, error: String(e) });
        }
      }

      const anyAth = results.some((r) => r.atNear52wHigh === true);
      const anyAtl = results.some((r) => r.atNear52wLow === true);

      return {
        source: 'market',
        description:
          `Market data and news for ${results.length} symbol(s). ` +
          'Each symbol includes price, daily/weekly change, 52-week high/low, and recent news headlines. ' +
          '**If `atNear52wHigh: true` for any watched symbol, ALWAYS call it out in the Executive Brief as "at 52-week high" / "at ATH" — do not skip it even if the weekly change is small.** ' +
          'Same for `atNear52wLow: true` (52-week low). ' +
          "Surface news in the Executive Brief ONLY if it's genuinely significant — " +
          'major market moves (>2% weekly), earnings surprises, sector-shaking news, ' +
          "or anything that could affect the user's holdings. " +
          'Skip routine analyst upgrades, minor fluctuations, and clickbait headlines.',
        data: { symbols: results },
        priorityHint: anyAth || anyAtl ? 'normal' : 'low',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const symbols = (config.symbols as string[]) ?? [];

  checks.push(
    symbols.length
      ? [PASS, `Symbols: ${symbols.join(', ')}`, '']
      : [FAIL, 'No symbols configured', ''],
  );

  return checks;
}
