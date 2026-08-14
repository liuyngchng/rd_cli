import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

/**
 * Pi auth provider.
 * Checks Pi CLI installation and credential status via `pi auth check`.
 */
export class PiProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('pi', ['--version'], {
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
      const result = spawn.sync('pi', ['auth', 'check', '--json'], {
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