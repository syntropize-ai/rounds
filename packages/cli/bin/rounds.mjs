#!/usr/bin/env node
// `rounds` — single-command launcher published to npm as @syntropize/rounds.
//
// Users who `npm install -g @syntropize/rounds` or `npx @syntropize/rounds`
// get this binary on their PATH as `rounds`. The CLI is intentionally thin:
// it sets a sensible DATA_DIR default, then delegates to the bundled server.
// The server's bootstrap-secrets step (see
// packages/api-gateway/src/auth/bootstrap-secrets.ts) auto-generates and
// persists JWT_SECRET + SECRET_KEY on first run, so no environment
// configuration is required from the user.

import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// -- argv handling (--help / --version) --------------------------------

const args = process.argv.slice(2);

// -- `rounds demo` subcommand -----------------------------------------
// Zero-credential preview mode. Sets OPENOBS_DEMO=1 and uses an isolated
// DATA_DIR so the demo never collides with a real install. The flag is
// read by the api-gateway's createApp(); without it no demo routes are
// mounted.
//
// TODO(rebrand): rename env var to ROUNDS_DEMO once api-gateway/server.ts is
// updated in the env-var sweep wave. Doing both at once to avoid a window
// where the launcher and the server disagree on the flag name.
if (args[0] === 'demo') {
  process.env.OPENOBS_DEMO = '1';
  if (!process.env.DATA_DIR) {
    process.env.DATA_DIR = join(homedir(), '.rounds-demo');
  }
  process.stdout.write(
    '[rounds] starting in DEMO mode — fixture data only, no credentials required.\n' +
    `[rounds] DATA_DIR = ${process.env.DATA_DIR}\n`,
  );
  // fall through to the normal launcher
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`rounds — AI does rounds on your production.

Usage:
  rounds                  Start the server (opens browser on first start).
  rounds demo             Start in zero-credential demo mode (fixture data).
  rounds --port=3000      Run on a specific port (default 3000).
  rounds --no-open        Do not open a browser.
  rounds --help           This help.

Environment:
  PORT                    HTTP port (default 3000)
  DATA_DIR                Persistent state directory (default ~/.rounds)
  NODE_ENV                production | development (default: unset = local)

Data location: ${join(homedir(), '.rounds')} by default.
On first run, Rounds auto-generates persistent crypto secrets there.
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

// Persistent state lives in ~/.rounds unless overridden.
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = join(homedir(), '.rounds');
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
    `[rounds] server bundle missing at ${serverBundle}\n` +
    `[rounds] did you install a published @syntropize/rounds package? If you're running from a local checkout, run\n` +
    `[rounds]   npm run dist\n` +
    `[rounds] from the repo root to build the CLI bundle.\n`,
  );
  process.exit(1);
}

// Windows: dynamic import of an absolute path needs a file:// URL. macOS /
// Linux accept the plain path too, but pathToFileURL is safe on every OS.
await import(pathToFileURL(serverBundle).href);
