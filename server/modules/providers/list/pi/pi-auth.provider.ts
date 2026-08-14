import spawn from 'cross-spawn';
import path from 'path';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

/**
 * Pi auth provider.
 * Checks Pi CLI installation and credential status via `pi auth check`.
 */
export class PiProviderAuth implements IProviderAuth {
  private resolvePiCommand(): string {
    if (process.env.PI_CLI_PATH) {
      // Resolve relative paths against cwd so spawn can find the binary.
      if (!path.isAbsolute(process.env.PI_CLI_PATH)) {
        return path.resolve(process.cwd(), process.env.PI_CLI_PATH);
      }
      return process.env.PI_CLI_PATH;
    }
    return 'pi';
  }

  private checkInstalled(): boolean {
    try {
      const result = spawn.sync(this.resolvePiCommand(), ['--version'], {
        stdio: 'ignore',
        timeout: 5000,
      });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Returns Pi CLI installation and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed: false,
        provider: 'pi',
        authenticated: false,
        email: null,
        method: null,
        error: 'Pi CLI is not installed',
      };
    }

    try {
      const result = spawn.sync(this.resolvePiCommand(), ['auth', 'check', '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      });

      if (result.status === 0) {
        try {
          const parsed = JSON.parse(result.stdout.toString().trim());
          const status = parsed?.status;
          return {
            installed: true,
            provider: 'pi',
            authenticated: status === 'ready',
            email: parsed?.provider || null,
            method: status === 'ready' ? 'cli' : null,
            error: status !== 'ready' ? (parsed?.reason || 'Not authenticated') : undefined,
          };
        } catch {
          return {
            installed: true,
            provider: 'pi',
            authenticated: false,
            email: null,
            method: null,
            error: 'Unable to parse Pi auth status',
          };
        }
      }

      return {
        installed: true,
        provider: 'pi',
        authenticated: false,
        email: null,
        method: null,
        error: 'Not authenticated. Run `pi auth check` to verify.',
      };
    } catch {
      return {
        installed: true,
        provider: 'pi',
        authenticated: false,
        email: null,
        method: null,
        error: 'Pi CLI is installed but auth check failed',
      };
    }
  }
}