import crossSpawn from 'cross-spawn';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';
import { resolvePiCliPath } from '@/shared/pi-cli-path.js';

const PI_MODELS_TIMEOUT_MS = 20_000;

export const PI_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'anthropic/claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      description: 'anthropic - anthropic/claude-sonnet-4-5',
    },
    {
      value: 'anthropic/claude-opus-4-1',
      label: 'Claude Opus 4.1',
      description: 'anthropic - anthropic/claude-opus-4-1',
    },
    {
      value: 'anthropic/claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      description: 'anthropic - anthropic/claude-haiku-4-5',
    },
    {
      value: 'openai/gpt-5.1',
      label: 'GPT-5.1',
      description: 'openai - openai/gpt-5.1',
    },
    {
      value: 'openai/gpt-5.1-codex',
      label: 'GPT-5.1 Codex',
      description: 'openai - openai/gpt-5.1-codex',
    },
  ],
  DEFAULT: 'anthropic/claude-sonnet-4-5',
};

const MODEL_ID_LINE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;

export const parsePiModelsStdout = (stdout: string): string[] => {
  const ids: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('{') || line.startsWith('[')) continue;
    if (MODEL_ID_LINE.test(line)) ids.push(line);
  }
  return [...new Set(ids)];
};

const runPiModelsCommand = (): Promise<string> => new Promise((resolve, reject) => {
  const piCommand = resolvePiCliPath();
  const piProcess = crossSpawn(piCommand, ['--list-models'], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    piProcess.kill('SIGTERM');
    if (!settled) {
      settled = true;
      reject(new Error('pi --list-models timed out'));
    }
  }, PI_MODELS_TIMEOUT_MS);

  const finish = (error: Error | null, output: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(output);
  };

  piProcess.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
  piProcess.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  piProcess.on('error', (error) => finish(
    error instanceof Error ? error : new Error(String(error)),
    '',
  ));
  piProcess.on('close', (code) => {
    if (code !== 0) {
      finish(new Error(stderr.trim() || `pi --list-models exited with code ${code}`), '');
      return;
    }
    finish(null, stdout);
  });
});

export class PiProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const stdout = await runPiModelsCommand();
      const ids = parsePiModelsStdout(stdout);
      if (ids.length === 0) return PI_FALLBACK_MODELS;

      const options = ids.map((value) => ({
        value,
        label: value.split('/').pop() || value,
        description: value,
      }));

      const defaultValue = options.find(
        (option) => option.value === PI_FALLBACK_MODELS.DEFAULT,
      )?.value ?? options[0]?.value ?? PI_FALLBACK_MODELS.DEFAULT;

      return { OPTIONS: options, DEFAULT: defaultValue };
    } catch {
      return PI_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}