import path from 'node:path';

/**
 * Resolve the Pi CLI executable path.
 *
 * Resolution order:
 * 1. `PI_CLI_PATH` env var – explicit override (relative paths resolved against cwd)
 * 2. `'pi'` – look up on PATH (npx global install, or bundled binary prepended
 *    to PATH by the Electron desktop launcher)
 */
export function resolvePiCliPath(): string {
  if (process.env.PI_CLI_PATH) {
    if (!path.isAbsolute(process.env.PI_CLI_PATH)) {
      return path.resolve(process.cwd(), process.env.PI_CLI_PATH);
    }
    return process.env.PI_CLI_PATH;
  }
  return 'pi';
}