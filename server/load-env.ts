// Load environment variables from .env before other imports execute.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// This bootstrap cannot import shared/utils.ts: that module reads environment
// defaults during evaluation, before this file has loaded `.env`.
function getBootstrapApplicationRoot(importMetaUrl: string) {
  const moduleDirectory = path.dirname(fileURLToPath(importMetaUrl));
  let serverRoot = moduleDirectory;
  while (path.basename(serverRoot) !== 'server') {
    const parent = path.dirname(serverRoot);
    if (parent === serverRoot) throw new Error('Could not resolve server root');
    serverRoot = parent;
  }
  const parent = path.dirname(serverRoot);
  return path.basename(parent) === 'dist-server' ? path.dirname(parent) : parent;
}

// Resolve the repo/app root via the nearest /server folder so this file keeps finding the
// same top-level .env file from both /server/load-env.ts and /dist-server/server/load-env.js.
const APP_ROOT = getBootstrapApplicationRoot(import.meta.url);

try {
  const envPath = path.join(APP_ROOT, '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0 && !process.env[key]) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  });
} catch (e: any) {
  // .env is optional; a missing file (ENOENT) is the normal case and stays silent.
  if (e?.code !== 'ENOENT') {
    console.error('Failed to read .env:', e.message);
  }
}

// Keep the default database in a stable user-level location so rebuilding dist-server
// never changes where the backend stores auth.db when DATABASE_PATH is not set explicitly.
const DEFAULT_DATABASE_PATH = path.join(os.homedir(), '.rdcli', 'auth.db');

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = DEFAULT_DATABASE_PATH;
}

if (process.env.RDCLI_LOG_LEVEL === 'debug') {
  // load-env runs before the debug() helper is importable, so write the log
  // line inline. The line is best-effort — failures are silently ignored.
  try {
    const logDir = path.join(process.cwd(), 'logs');
    const now = new Date();
    const yyyy = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const logFile = path.join(logDir, `rc_cli_desktop_${yyyy}_${MM}_${dd}.log`);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logFile, `[DEBUG] ${now.toISOString()} load-env: DATABASE_PATH = ${process.env.DATABASE_PATH}\n`, 'utf8');
  } catch { /* best-effort */ }
}
