import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { google } from 'googleapis';
import type { ConnectorConfig, ConnectorAuth } from '../types.js';

export function loadOAuth2(credsDir: string, credsFile = 'credentials.json') {
  const credsPath = join(credsDir, credsFile);
  if (!existsSync(credsPath)) throw new Error(`${credsFile} not found at ${credsPath}`);

  const creds = JSON.parse(readFileSync(credsPath, 'utf-8'));
  const { client_id, client_secret, redirect_uris } = creds.installed ?? creds.web;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
}

export function getCredentials(credsDir: string, tokenFile: string, credsFile?: string) {
  const tokenPath = join(credsDir, tokenFile);
  const oauth2 = loadOAuth2(credsDir, credsFile);

  if (existsSync(tokenPath)) {
    oauth2.setCredentials(JSON.parse(readFileSync(tokenPath, 'utf-8')));
  } else {
    throw new Error(
      `No valid credentials at ${tokenPath}. Run: callsheet --auth <connector>:<account_name>`,
    );
  }

  return oauth2;
}

/** Build an OAuth URL without starting a server. Used by the web dashboard. */
export function buildAuthUrl(
  credsDir: string,
  scopes: string[],
  tokenFile: string,
  redirectUri = 'http://localhost:3000/oauth2callback',
  credsFile?: string,
): { authUrl: string; oauth2: ReturnType<typeof loadOAuth2>; tokenPath: string } {
  const tokenPath = join(credsDir, tokenFile);
  const oauth2 = loadOAuth2(credsDir, credsFile);

  (oauth2 as unknown as { redirectUri: string }).redirectUri = redirectUri;

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
  });

  return { authUrl, oauth2, tokenPath };
}

/** Exchange an OAuth code for tokens and save to disk. */
export async function exchangeCodeAndSave(
  oauth2: ReturnType<typeof loadOAuth2>,
  code: string,
  tokenPath: string,
): Promise<void> {
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  mkdirSync(join(tokenPath, '..'), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
}

/** CLI OAuth flow — starts a temporary local server, opens browser, waits for callback. */
export async function runOAuthFlow(
  credsDir: string,
  scopes: string[],
  tokenFile: string,
  label: string,
  accountName?: string,
  credsFile?: string,
): Promise<void> {
  const { authUrl, oauth2, tokenPath } = buildAuthUrl(
    credsDir,
    scopes,
    tokenFile,
    'http://localhost:3000/oauth2callback',
    credsFile,
  );

  console.log(
    accountName ? `Authorizing ${label} for "${accountName}"...` : `Authorizing ${label}...`,
  );
  console.log('Visit:', authUrl);

  const server = createServer();
  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Auth timeout (2 min)')), 120_000);
    server.on('request', (req, res) => {
      const url = new URL(req.url!, 'http://localhost:3000');
      const c = url.searchParams.get('code');
      if (c) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Auth complete! You can close this tab.</h1>');
        clearTimeout(timeout);
        resolve(c);
      } else {
        res.writeHead(400);
        res.end('No code found');
      }
    });
    server.listen(3000);
  });

  server.close(() => server.unref());

  await exchangeCodeAndSave(oauth2, code, tokenPath);
  console.log(`${label} auth complete. Token saved to ${tokenPath}`);
  process.exit(0);
}

export interface GoogleAccount {
  name: string;
  credentials_file?: string;
  token_file?: string;
}

export function resolveCredsFile(
  acct: GoogleAccount | undefined,
  config: ConnectorConfig,
): string | undefined {
  return acct?.credentials_file ?? (config.credentials_file as string | undefined);
}

export function makeAuthFromConfig(
  scopes: string[],
  label: string,
  tokenPrefix: string,
): ConnectorAuth {
  return async (credsDir, config, accountName) => {
    const accounts = (config.accounts as GoogleAccount[] | undefined) ?? [];
    const matchedAcct = accountName
      ? accounts.find((a) => a.name.toLowerCase() === accountName.toLowerCase())
      : undefined;
    const credsFile = resolveCredsFile(matchedAcct, config);
    const tokenFile = accountName
      ? `${tokenPrefix}_${accountName.toLowerCase()}.json`
      : `${tokenPrefix}.json`;
    await runOAuthFlow(credsDir, scopes, tokenFile, label, accountName, credsFile);
  };
}
