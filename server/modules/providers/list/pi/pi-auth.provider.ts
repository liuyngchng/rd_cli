import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { resolvePiCliPath } from '@/shared/pi-cli-path.js';

/**
 * Pi auth provider.
 * Checks Pi CLI installation and credential status via `pi auth check`.
 */
export class PiProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync(resolvePiCliPath(), ['--version'], {
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
   *
   * Pi 0.84+ requires `--provider <provider>` or `--model <model>` for
   * `pi auth check`. Older versions work with just `--json`. We try bare
   * `--json` first, then fall back to provider/model inference.
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

    const piCommand = resolvePiCliPath();

    const parseAuthOutput = (parsed: any): ProviderAuthStatus => {
      const status = parsed?.status;
      return {
        installed: true,
        provider: 'pi',
        authenticated: status === 'ready',
        email: parsed?.provider || null,
        method: status === 'ready' ? 'cli' : null,
        error: status !== 'ready' ? (parsed?.reason || 'Not authenticated') : undefined,
      };
    };

    const runAuthCheck = (args: string[]): ProviderAuthStatus | null => {
      try {
        const result = spawn.sync(piCommand, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10000,
        });

        if (result.status === 0) {
          try {
            const parsed = JSON.parse(result.stdout.toString().trim());
            return parseAuthOutput(parsed);
          } catch {
            return null; // unparseable, try next strategy
          }
        }

        return null; // non-zero exit, try next strategy
      } catch {
        return null;
      }
    };

    // Strategy 1: bare --json (old Pi versions)
    const bareResult = runAuthCheck(['auth', 'check', '--json']);
    if (bareResult) return bareResult;

    // Strategy 2: --provider from env var
    const defaultProvider = process.env.PI_DEFAULT_PROVIDER;
    if (defaultProvider) {
      const providerResult = runAuthCheck(['auth', 'check', '--provider', defaultProvider, '--json']);
      if (providerResult) return providerResult;
    }

    // Strategy 3: infer a model from --list-models
    try {
      const modelsResult = spawn.sync(piCommand, ['--list-models'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      });
      if (modelsResult.status === 0) {
        const stdout = modelsResult.stdout.toString().trim();
        const lines = stdout.split(/\r?\n/);
        // Skip header line, grab the first real model line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('provider') || trimmed.startsWith('{')) continue;
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 2) {
            const modelId = `${parts[0]}/${parts[1]}`;
            const modelResult = runAuthCheck(['auth', 'check', '--model', modelId, '--json']);
            if (modelResult) return modelResult;
            break; // only try the first model
          }
        }
      }
    } catch {
      // fall through
    }

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