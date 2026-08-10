import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections, keyed by user id.
 *
 * When a user has no userId (PLATFORM mode or legacy), the entry is stored
 * under key 0 and broadcasts go to all users with key 0.
 */
const clientsByUser = new Map<number, Set<RealtimeClientConnection>>();

function getOrCreateUserSet(userId: number): Set<RealtimeClientConnection> {
  let set = clientsByUser.get(userId);
  if (!set) {
    set = new Set();
    clientsByUser.set(userId, set);
  }
  return set;
}

/**
 * Legacy flat set — kept for backward compat with callers that iterate
 * `connectedClients` directly. Do NOT add new references to this; use
 * `addClient`, `removeClient`, and `broadcastToUser` instead.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

/**
 * Registers a client for the given user. If userId is not provided, the
 * client is also added to the legacy flat set for backward compat.
 */
export function addClient(userId: number | null | undefined, client: RealtimeClientConnection): void {
  const key = userId != null ? Number(userId) : 0;
  getOrCreateUserSet(key).add(client);
  connectedClients.add(client);
}

/**
 * Removes a client for the given user. If userId is not provided, removes
 * from key 0 and the legacy flat set.
 */
export function removeClient(userId: number | null | undefined, client: RealtimeClientConnection): void {
  const key = userId != null ? Number(userId) : 0;
  const set = clientsByUser.get(key);
  if (set) {
    set.delete(client);
    if (set.size === 0) {
      clientsByUser.delete(key);
    }
  }
  connectedClients.delete(client);
}

/**
 * Sends a JSON string payload to every connected client for the given user.
 */
export function broadcastToUser(userId: number | null | undefined, payload: string): void {
  const key = userId != null ? Number(userId) : 0;
  const set = clientsByUser.get(key);
  if (!set) {
    return;
  }
  for (const client of set) {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  }
}

/**
 * Sends a JSON string payload to every connected client (all users).
 * Use sparingly — only for truly global events.
 */
export function broadcastToAll(payload: string): void {
  for (const client of connectedClients) {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  }
}
