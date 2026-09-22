import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  filterAttachmentsToUploadStore,
  filterImagesToUploadStore,
} from '@/modules/websocket/services/chat-websocket.service.js';

const STORE = path.join(os.tmpdir(), 'rdcli-assets-store');

test('images inside the upload store pass through', () => {
  const inside = path.join(STORE, 'shot.png');
  const result = filterImagesToUploadStore(
    [{ path: inside, name: 'shot.png', mimeType: 'image/png' }],
    STORE,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, inside);
});

test('bare filenames are anchored inside the store', () => {
  const result = filterImagesToUploadStore(['shot.png'], STORE);
  assert.equal(result.length, 1);
});

test('paths outside the store and traversal are dropped', () => {
  const result = filterImagesToUploadStore(
    [
      { path: 'C:/Users/victim/.ssh/id_rsa' },
      { path: '/etc/passwd' },
      { path: '../outside.png' },
      { path: path.join(STORE, '..', 'escaped.png') },
      { path: STORE }, // the store folder itself is not a file
    ],
    STORE,
  );
  assert.deepEqual(result, []);
});

test('per-user subdirectories inside the upload store pass through', () => {
  const inside = path.join(STORE, '1', 'OA______.pdf');
  const result = filterAttachmentsToUploadStore(
    [{ path: inside, name: 'OA______.pdf', mimeType: 'application/pdf' }],
    STORE,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, inside);
});

test('malformed payloads yield no attachments', () => {
  assert.deepEqual(filterImagesToUploadStore(undefined, STORE), []);
  assert.deepEqual(filterImagesToUploadStore('nope', STORE), []);
  assert.deepEqual(filterImagesToUploadStore([{ name: 'no-path' }, 42], STORE), []);
});

test('general files inside the upload store preserve their metadata', () => {
  const inside = path.join(STORE, 'brief.pdf');
  const result = filterAttachmentsToUploadStore(
    [{ path: inside, name: 'brief.pdf', mimeType: 'application/pdf', size: 2048 }],
    STORE,
  );

  assert.deepEqual(result, [
    { path: inside, name: 'brief.pdf', mimeType: 'application/pdf', size: 2048 },
  ]);
});

test('files inside the project directory pass through when project path is supplied', () => {
  const projectRoot = path.join(os.tmpdir(), 'rdcli-project');
  const inside = path.join(projectRoot, '报告.md');
  const result = filterAttachmentsToUploadStore(
    [{ path: inside, name: '报告.md', mimeType: 'text/markdown' }],
    STORE,
    projectRoot,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, inside);
});

test('files outside the project directory are still dropped', () => {
  const projectRoot = path.join(os.tmpdir(), 'rdcli-project');
  const result = filterAttachmentsToUploadStore(
    [{ path: '/etc/passwd' }, { path: path.join(projectRoot, '..', 'secret.txt') }],
    STORE,
    projectRoot,
  );
  assert.deepEqual(result, []);
});
