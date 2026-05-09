#!/usr/bin/env node
// `openobs` — single-command launcher published to npm.
//
// Users who `npm install -g openobs` or `npx openobs` land here. The CLI
// is intentionally thin: it sets a sensible DATA_DIR default, then
// delegates to the bundled server. The server's bootstrap-secrets step
// (see packages/api-gateway/src/auth/bootstrap-secrets.ts) auto-generates
// and persists JWT_SECRET + SECRET_KEY on first run, so no environment
// configuration is required from the user.

import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// -- argv handling (--help / --version) --------------------------------

const args = process.argv.slice(2);

// -- `openobs demo` subcommand ----------------------------------------
// Zero-credential preview mode. Sets OPENOBS_DEMO=1 and uses an isolated
// DATA_DIR so the demo never collides with a real install. The flag is
// read by the api-gateway's createApp(); without it no demo routes are
// mounted.
if (args[0] === 'demo') {
  process.env.OPENOBS_DEMO = '1';
  if (!process.env.DATA_DIR) {
    process.env.DATA_DIR = join(homedir(), '.openobs-demo');
  }
  process.stdout.write(
    '[openobs] starting in DEMO mode — fixture data only, no credentials required.\n' +
    `[openobs] DATA_DIR = ${process.env.DATA_DIR}\n`,
  );
  // fall through to the normal launcher
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`openobs — AI-native observability platform

Usage:
  openobs                 Start the server (opens browser on first start).
  openobs demo            Start in zero-credential demo mode (fixture data).
  openobs --port=3000     Run on a specific port (default 3000).
  openobs --no-open       Do not open a browser.
  openobs --help          This help.

Environment:
  PORT                    HTTP port (default 3000)
  DATA_DIR                Persistent state directory (default ~/.openobs)
  NODE_ENV                production | development (default: unset = local)

Data location: ${join(homedir(), '.openobs')} by default.
On first run, OpenObs auto-generates persistent crypto secrets there.
`);
  process.exit(0);
}

let openBrowser = !args.includes('--no-open');
let portOverride = null;
for (const a of args) {
  const m = a.match(/^--port=(\d+)$/);
  if (m) portOverride = m[1];
}

// -- env defaults ------------------------------------------------------

// Persistent state lives in ~/.openobs unless overridden.
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = join(homedir(), '.openobs');
}
// Cookie security: on loopback we don't require HTTPS.
if (!process.env.SESSION_COOKIE_SECURE) {
  process.env.SESSION_COOKIE_SECURE = 'false';
}
if (portOverride) process.env.PORT = portOverride;

// -- browser open (best-effort, non-blocking) --------------------------

function openUrlInBrowser(url) {
  try {
    if (platform() === 'win32') {
      execSync(`start "" "${url}"`, { stdio: 'ignore', shell: 'cmd.exe' });
    } else if (platform() === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
  } catch { /* user can click the printed URL */ }
}

// Schedule browser open a moment after server starts. We don't probe for
// readiness — the brief delay is usually enough, and worst case the user
// refreshes.
const port = Number(process.env.PORT ?? 3000);
if (openBrowser) {
  setTimeout(() => openUrlInBrowser(`http://localhost:${port}`), 2000);
}

// -- start the bundled server -----------------------------------------

const serverBundle = join(__dirname, '..', 'dist', 'server.mjs');
if (!existsSync(serverBundle)) {
  process.stderr.write(
    `[openobs] server bundle missing at ${serverBundle}\n` +
    `[openobs] did you install a published openobs package? If you're running from a local checkout, run\n` +
    `[openobs]   npm run dist\n` +
    `[openobs] from the repo root to build the CLI bundle.\n`,
  );
  process.exit(1);
}

// Windows: dynamic import of an absolute path needs a file:// URL. macOS /
// Linux accept the plain path too, but pathToFileURL is safe on every OS.
await import(pathToFileURL(serverBundle).href);
