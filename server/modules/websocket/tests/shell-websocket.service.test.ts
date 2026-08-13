import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: string[];
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

function createFakeRequest(userId?: number): AuthenticatedWebSocketRequest {
  return { user: { id: userId ?? 1 } } as AuthenticatedWebSocketRequest;
}

function createFakePty() {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  return {
    killed: false,
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    emitData(data: string) {
      dataListener?.(data);
    },
    emitExit() {
      exitListener?.({ exitCode: 0 });
    },
    write() {},
    resize() {},
    kill() {
      this.killed = true;
    },
  };
}

test('a stale socket close cannot detach the socket that replaced it', async () => {
  const pty = createFakePty();
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveUserWorkspaceRoot: async () => process.cwd(),
    validateUserWorkspacePath: async (_userId: number, candidatePath: string) => ({ valid: true, resolvedPath: candidatePath }),
    spawnPty: () => pty as never,
  };
  const initMessage = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `stale-close-${Date.now()}`,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'test-command',
  });

  const flushAsyncInit = () => new Promise((resolve) => setImmediate(resolve));

  const fakeRequest = createFakeRequest();
  const firstSocket = createFakeSocket();
  handleShellConnection(firstSocket as never, fakeRequest, dependencies);
  firstSocket.emit('message', initMessage);
  await flushAsyncInit();

  const replacementSocket = createFakeSocket();
  handleShellConnection(replacementSocket as never, fakeRequest, dependencies);
  replacementSocket.emit('message', initMessage);
  await flushAsyncInit();
  replacementSocket.frames.length = 0;

  // This ordering reproduces a delayed close from a backgrounded mobile tab.
  firstSocket.emit('close');
  pty.emitData('output-after-stale-close');

  assert.equal(pty.killed, false);
  assert.equal(replacementSocket.frames.length, 1);
  assert.match(replacementSocket.frames[0], /output-after-stale-close/);

  pty.emitExit();
});

test('shell output detects and normalizes a wrapped authentication URL', async () => {
  const pty = createFakePty();
  const socket = createFakeSocket();
  const fakeRequest = createFakeRequest();
  const dependencies = {
    resolveProviderSessionId: () => null,
    resolveUserWorkspaceRoot: async () => process.cwd(),
    validateUserWorkspacePath: async (_userId: number, candidatePath: string) => ({ valid: true, resolvedPath: candidatePath }),
    spawnPty: () => pty as never,
  };

  handleShellConnection(socket as never, fakeRequest, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `wrapped-url-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
      initialCommand: 'test-command',
    })
  );
  await new Promise((resolve) => setImmediate(resolve));
  socket.frames.length = 0;

  pty.emitData("Continue in your browser: https://example.com/authorize?\ncode=abc\x1b[0m");

  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const authenticationFrame = frames.find((frame) => frame.type === 'auth_url');
  assert.deepEqual(authenticationFrame, {
    type: 'auth_url',
    url: 'https://example.com/authorize?code=abc',
    autoOpen: false,
  });

  pty.emitExit();
});
