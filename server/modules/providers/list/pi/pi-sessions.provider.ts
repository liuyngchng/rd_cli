import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  normalizeProviderTimestamp,
  readObjectRecord,
  readOptionalString,
  readJsonRecord,
  sliceTailPage,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

const PROVIDER = 'pi';

/**
 * Pi sessions provider.
 * Normalizes live JSON events from `pi --mode json` and reads session history
 * from JSONL files in ~/.pi/agent/sessions/.
 */
export class PiSessionsProvider implements IProviderSessions {
  /**
   * Normalizes live `pi --mode json` events into frontend messages.
   * Pi's JSON event format: each line is a JSON object with a `type` field.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) return [];

    const type = readOptionalString(raw.type);
    const timestamp = normalizeProviderTimestamp(raw.timestamp);
    const baseId = readOptionalString(raw.id) ?? generateMessageId('pi');

    // agent_start / agent_end -- lifecycle
    if (type === 'agent_start') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_delta',
        content: '',
      })];
    }

    if (type === 'agent_end') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_end',
      })];
    }

    // message_update events contain assistantMessageEvent with streaming deltas
    if (type === 'message_update') {
      const assistantEvent = readObjectRecord(raw.assistantMessageEvent);
      if (!assistantEvent) return [];

      const aeType = readOptionalString(assistantEvent.type);
      const message = readObjectRecord(raw.message);

      // text_start/delta/end
      if (aeType === 'text_delta') {
        const delta = readOptionalString(assistantEvent.delta) ?? '';
        if (!delta.trim()) return [];
        return [createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'stream_delta',
          content: delta,
        })];
      }

      if (aeType === 'thinking_delta') {
        const delta = readOptionalString(assistantEvent.delta) ?? '';
        if (!delta.trim()) return [];
        return [createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'thinking',
          content: delta,
        })];
      }

      // toolcall events
      if (aeType === 'toolcall_start') {
        const toolCall = readObjectRecord(assistantEvent.toolCall) ?? assistantEvent;
        return [createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: readOptionalString(toolCall.name) ?? readOptionalString(toolCall.function?.name) ?? 'Tool',
          toolInput: toolCall.arguments ?? toolCall.function?.arguments ?? {},
          toolId: readOptionalString(toolCall.id) ?? baseId,
        })];
      }

      if (aeType === 'toolcall_delta') {
        // Delta for tool call arguments -- stream as tool_use delta
        const delta = readOptionalString(assistantEvent.delta) ?? '';
        if (!delta.trim()) return [];
        return [createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: 'Tool',
          toolInput: { delta },
          toolId: baseId,
        })];
      }

      if (aeType === 'toolcall_end') {
        const toolCall = readObjectRecord(assistantEvent.toolCall) ?? assistantEvent;
        return [createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: readOptionalString(toolCall.name) ?? readOptionalString(toolCall.function?.name) ?? 'Tool',
          toolInput: toolCall.arguments ?? toolCall.function?.arguments ?? {},
          toolId: readOptionalString(toolCall.id) ?? baseId,
        })];
      }

      // done/error events
      if (aeType === 'done') {
        return [createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'stream_end',
        })];
      }

      if (aeType === 'error') {
        return [createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'error',
          content: readOptionalString(assistantEvent.error?.errorMessage) ?? 'Pi error',
        })];
      }

      return [];
    }

    // message_start / message_end
    if (type === 'message_start' || type === 'message_end') {
      return [];
    }

    // tool_execution_start / tool_execution_end
    if (type === 'tool_execution_start') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: readOptionalString(raw.toolName) ?? 'Tool',
        toolInput: raw.args ?? {},
        toolId: readOptionalString(raw.toolCallId) ?? baseId,
      })];
    }

    if (type === 'tool_execution_end') {
      const result = raw.result;
      const isError = raw.isError === true;
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: readOptionalString(raw.toolName) ?? 'Tool',
        toolInput: raw.args ?? {},
        toolResult: {
          content: typeof result === 'string' ? result : JSON.stringify(result ?? ''),
          isError,
        },
        toolId: readOptionalString(raw.toolCallId) ?? baseId,
      })];
    }

    if (type === 'error') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'error',
        content: readOptionalString(raw.error) ?? readOptionalString(raw.message) ?? 'Pi error',
      })];
    }

    return [];
  }

  /**
   * Loads Pi session history from JSONL files in ~/.pi/agent/sessions/.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;
    const sessionPath = this.findSessionPath(providerSessionId);

    if (!sessionPath) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const entries = await this.readSessionJsonl(sessionPath);
      const normalized = this.normalizeHistoryEntries(entries, sessionId);

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[PiProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  }

  private findSessionPath(sessionId: string): string | null {
    const sessionsDir = path.join(os.homedir(), '.pi', 'agent', 'sessions');
    if (!fsSync.existsSync(sessionsDir)) return null;

    try {
      const entries = fsSync.readdirSync(sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionFile = path.join(sessionsDir, entry.name, 'session.jsonl');
        if (fsSync.existsSync(sessionFile)) {
          // Check the header line for the session ID
          const firstLine = this.readFirstLineSync(sessionFile);
          if (firstLine) {
            try {
              const header = JSON.parse(firstLine);
              if (header.id === sessionId) return sessionFile;
            } catch {
              // skip
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  private readFirstLineSync(filePath: string): string | null {
    try {
      const fd = fsSync.openSync(filePath, 'r');
      const buffer = Buffer.alloc(4096);
      const bytesRead = fsSync.readSync(fd, buffer, 0, buffer.length, 0);
      fsSync.closeSync(fd);
      const content = buffer.toString('utf8', 0, bytesRead);
      const newlineIdx = content.indexOf('\n');
      return newlineIdx >= 0 ? content.slice(0, newlineIdx) : content;
    } catch {
      return null;
    }
  }

  private async readSessionJsonl(filePath: string): Promise<AnyRecord[]> {
    const entries: AnyRecord[] = [];
    const fileStream = createReadStream(filePath, 'utf8');
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        entries.push(parsed);
      } catch {
        // skip malformed lines
      }
    }

    return entries;
  }

  private normalizeHistoryEntries(entries: AnyRecord[], sessionId: string): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];

    for (const entry of entries) {
      const type = readOptionalString(entry.type);
      if (!type) continue;

      if (type === 'session') {
        // Header line, skip
        continue;
      }

      const timestamp = normalizeProviderTimestamp(entry.timestamp);
      const baseId = readOptionalString(entry.id) ?? generateMessageId('pi');

      if (type === 'message') {
        const message = readObjectRecord(entry.message);
        if (!message) continue;

        const role = readOptionalString(message.role);
        const content = message.content;

        if (role === 'user') {
          const userText = this.extractTextContent(content);
          if (userText) {
            normalized.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: userText,
            }));
          }
          continue;
        }

        if (role === 'assistant') {
          for (const item of Array.isArray(content) ? content : []) {
            const itemType = readOptionalString(item.type);
            if (itemType === 'text') {
              const text = readOptionalString(item.text);
              if (text) {
                normalized.push(createNormalizedMessage({
                  id: `${baseId}_text`,
                  sessionId,
                  timestamp,
                  provider: PROVIDER,
                  kind: 'text',
                  role: 'assistant',
                  content: text,
                }));
              }
            } else if (itemType === 'thinking') {
              const thinking = readOptionalString(item.thinking);
              if (thinking) {
                normalized.push(createNormalizedMessage({
                  id: `${baseId}_thinking`,
                  sessionId,
                  timestamp,
                  provider: PROVIDER,
                  kind: 'thinking',
                  content: thinking,
                }));
              }
            } else if (itemType === 'tool_use') {
              normalized.push(createNormalizedMessage({
                id: `${baseId}_tool`,
                sessionId,
                timestamp,
                provider: PROVIDER,
                kind: 'tool_use',
                toolName: readOptionalString(item.name) ?? 'Tool',
                toolInput: item.input ?? {},
                toolId: readOptionalString(item.id) ?? `${baseId}_tool`,
              }));
            }
          }
          continue;
        }

        if (role === 'tool') {
          const toolResult = message.content;
          const toolCallId = readOptionalString(message.tool_call_id);
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'Tool',
            toolInput: {},
            toolResult: {
              content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult ?? ''),
              isError: false,
            },
            toolId: toolCallId ?? baseId,
          }));
          continue;
        }
      }
    }

    return normalized;
  }

  private extractTextContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((item) => readOptionalString(item?.type) === 'text')
        .map((item) => readOptionalString(item?.text) ?? '')
        .join('\n');
    }
    return '';
  }
}