import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolvePiCliPath } from '@/shared/pi-cli-path.js';

test('resolvePiCliPath returns "pi" when PI_CLI_PATH is not set', () => {
  delete process.env.PI_CLI_PATH;
  assert.equal(resolvePiCliPath(), 'pi');
});

test('resolvePiCliPath returns absolute PI_CLI_PATH unchanged', () => {
  process.env.PI_CLI_PATH = '/usr/local/bin/pi';
  assert.equal(resolvePiCliPath(), '/usr/local/bin/pi');
  delete process.env.PI_CLI_PATH;
});

test('resolvePiCliPath resolves relative PI_CLI_PATH against cwd', () => {
  process.env.PI_CLI_PATH = 'electron/pi/pi';
  const expected = path.resolve(process.cwd(), 'electron/pi/pi');
  assert.equal(resolvePiCliPath(), expected);
  delete process.env.PI_CLI_PATH;
});