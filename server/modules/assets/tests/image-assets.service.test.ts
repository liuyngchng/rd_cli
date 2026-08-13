import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildStoredAttachmentRecords,
  buildStoredImageRecords,
  isAllowedImageMimeType,
  resolveAttachmentAssetFile,
  resolveImageAssetFile,
} from '@/modules/assets/services/image-assets.service.js';

const ASSETS_DIR = path.join(os.homedir(), '.rdcli', 'assets');
const USER_ID = 7;
const USER_ASSETS_DIR = path.join(ASSETS_DIR, String(USER_ID));

test('isAllowedImageMimeType accepts image formats and rejects the rest', () => {
  assert.equal(isAllowedImageMimeType('image/png'), true);
  assert.equal(isAllowedImageMimeType('image/svg+xml'), true);
  assert.equal(isAllowedImageMimeType('application/pdf'), false);
  assert.equal(isAllowedImageMimeType('text/html'), false);
});

test('buildStoredImageRecords returns absolute posix paths in the user assets dir', () => {
  const records = buildStoredImageRecords([
    { originalname: 'shot.png', filename: '123-456-shot.png', size: 42, mimetype: 'image/png' },
  ], USER_ID);

  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'shot.png');
  assert.equal(records[0].size, 42);
  assert.equal(records[0].mimeType, 'image/png');
  assert.equal(records[0].path, `${USER_ASSETS_DIR.replace(/\\/g, '/')}/123-456-shot.png`);
});

test('buildStoredAttachmentRecords preserves metadata for non-image files', () => {
  const records = buildStoredAttachmentRecords([
    {
      originalname: 'requirements.pdf',
      filename: '123-456-requirements.pdf',
      size: 2048,
      mimetype: 'application/pdf',
    },
  ], USER_ID);

  assert.deepEqual(records[0], {
    name: 'requirements.pdf',
    path: `${USER_ASSETS_DIR.replace(/\\/g, '/')}/123-456-requirements.pdf`,
    size: 2048,
    mimeType: 'application/pdf',
  });
});

test('resolveImageAssetFile resolves plain filenames inside the user assets dir', () => {
  const resolved = resolveImageAssetFile('123-shot.png', USER_ID);
  assert.equal(resolved, path.join(path.resolve(USER_ASSETS_DIR), '123-shot.png'));
});

test('resolveImageAssetFile rejects traversal and separator attempts', () => {
  assert.equal(resolveImageAssetFile('', USER_ID), null);
  assert.equal(resolveImageAssetFile('   ', USER_ID), null);
  assert.equal(resolveImageAssetFile('../auth.db', USER_ID), null);
  assert.equal(resolveImageAssetFile('..', USER_ID), null);
  assert.equal(resolveImageAssetFile('sub/dir.png', USER_ID), null);
  assert.equal(resolveImageAssetFile('sub\\dir.png', USER_ID), null);
  assert.equal(resolveImageAssetFile('a..b/../c.png', USER_ID), null);
});

test('resolveAttachmentAssetFile uses the same direct-child boundary', () => {
  assert.equal(
    resolveAttachmentAssetFile('123-notes.txt', USER_ID),
    path.join(path.resolve(USER_ASSETS_DIR), '123-notes.txt'),
  );
  assert.equal(resolveAttachmentAssetFile('../notes.txt', USER_ID), null);
});
