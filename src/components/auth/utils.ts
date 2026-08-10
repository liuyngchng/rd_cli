import type { ApiErrorPayload } from './types';

export async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function extractErrorMessage(maybeError: unknown): string | null {
  if (typeof maybeError === 'string') {
    return maybeError;
  }
  if (typeof maybeError === 'object' && maybeError !== null) {
    const err = maybeError as Record<string, unknown>;
    if (typeof err.message === 'string') {
      return err.message;
    }
  }
  return null;
}

function extractErrorCode(maybeError: unknown): string | null {
  if (typeof maybeError === 'object' && maybeError !== null) {
    const err = maybeError as Record<string, unknown>;
    if (typeof err.code === 'string') {
      return err.code;
    }
  }
  return null;
}

export function resolveApiErrorMessage(payload: ApiErrorPayload | null, fallback: string): { message: string; code: string | null } {
  if (!payload) {
    return { message: fallback, code: null };
  }

  const message = extractErrorMessage(payload.error) ?? extractErrorMessage(payload.message) ?? fallback;
  const code = extractErrorCode(payload.error);
  return { message, code };
}
