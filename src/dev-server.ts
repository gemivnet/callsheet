#!/usr/bin/env node
/**
 * Local development server — runs the Express dashboard without Docker.
 * Usage: yarn dashboard (builds frontend + starts this)
 *        yarn dev:web    (starts without building, assumes web/dist exists)
 */
import 'dotenv/config';
import { startServer } from './server.js';

const port = parseInt(process.env.PORT ?? '3000', 10);
console.log('[dev] Starting local dashboard server...');
startServer(port);
