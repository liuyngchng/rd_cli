// @ts-nocheck -- web-push does not provide declarations in this project.
import webPush from 'web-push';

import { getConnection } from '../database/index.js';
import { debug } from '@/shared/debug.js';

let cachedKeys = null;
let db: ReturnType<typeof getConnection> | null = null;
function getDb() {
  if (!db) {
    debug('vapid-keys.service: lazy-initializing database connection');
    db = getConnection();
  }
  return db;
}

function ensureVapidKeys() {
  if (cachedKeys) return cachedKeys;

  const db = getDb();
  const row = db.prepare('SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1').get();
  if (row) {
    cachedKeys = { publicKey: row.public_key, privateKey: row.private_key };
    return cachedKeys;
  }

  const keys = webPush.generateVAPIDKeys();
  db.prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)').run(keys.publicKey, keys.privateKey);
  cachedKeys = keys;
  return cachedKeys;
}

function getPublicKey() {
  return ensureVapidKeys().publicKey;
}

function configureWebPush() {
  const keys = ensureVapidKeys();
  webPush.setVapidDetails(
    'mailto:noreply@rdcli.local',
    keys.publicKey,
    keys.privateKey
  );
  console.log('Web Push notifications configured');
}

export { ensureVapidKeys, getPublicKey, configureWebPush };
