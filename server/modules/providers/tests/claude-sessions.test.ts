import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const SESSION_ID = 'session-1';

const SKILL_BODY = [
  'Base directory for this skill: /tmp/claude/bundled-skills/2.1.220/abc123/claude-api',
  '',
  '# Building LLM-Powered Applications with Claude',
  '',
  'This skill helps you build LLM-powered applications with Claude.',
].join('\n');

test('claude: injected skill bodies are hidden even without the isMeta flag', () => {
  const provider = new ClaudeSessionsProvider();

  // The live SDK stream omits `isMeta`, so the payload has to be recognised by
  // its content or it renders as a giant user bubble mid-run.
  const live = provider.normalizeMessage(
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-07-28T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    },
    SESSION_ID,
  );
  assert.deepEqual(live, []);

  const persisted = provider.normalizeMessage(
    {
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-07-28T10:00:00.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    },
    SESSION_ID,
  );
  assert.deepEqual(persisted, []);
});

test('claude: api-request-blob diagnostics never render as user turns', () => {
  const provider = new ClaudeSessionsProvider();

  // The CLI persists the raw API request payload as an `api-request-blob`
  // diagnostic row whose `message.role` is `user`. Without a row-type check
  // the prompt text inside the payload is normalized as a second copy of the
  // user's turn — with a random id and the fetch time as timestamp — which
  // flashes a duplicate user bubble on every history refresh.
  const messages = provider.normalizeMessage(
    {
      type: 'api-request-blob',
      timestamp: '2026-07-28T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nCodebase and user instructions are shown below.' },
          { type: 'text', text: '<system-reminder>\nAttribution for git commits and pull requests.' },
          { type: 'text', text: '你好' },
        ],
      },
    },
    SESSION_ID,
  );

  assert.deepEqual(messages, []);
});

test('claude: the Skill tool result itself still reaches the UI', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    {
      type: 'user',
      uuid: 'u3',
      timestamp: '2026-07-28T10:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill: claude-api' }],
      },
    },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'tool_result');
  assert.equal(messages[0].toolId, 'toolu_1');
});
