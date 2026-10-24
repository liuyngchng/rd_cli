import type { NormalizedMessage } from './useSessionStore';

const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;
const LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS = 30_000;

type UserTurnFingerprint = {
  text: string;
  imageCount: number;
  fileCount: number;
};

function userTurnFingerprint(message: NormalizedMessage): UserTurnFingerprint | null {
  if (message.kind !== 'text' || message.role !== 'user') return null;

  const text = (message.content || '').trim();
  const imageCount = Array.isArray(message.images) ? message.images.length : 0;
  const fileCount = Array.isArray(message.files) ? message.files.length : 0;
  if (!text && imageCount === 0 && fileCount === 0) return null;

  return { text, imageCount, fileCount };
}

function userTurnFingerprintsMatch(
  local: UserTurnFingerprint,
  server: UserTurnFingerprint,
): boolean {
  return (
    local.text === server.text
    && local.imageCount === server.imageCount
    && local.fileCount === server.fileCount
  );
}

function readMessageTime(message: NormalizedMessage): number | null {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : null;
}

function findServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  claimedServerIds: Set<string>,
): NormalizedMessage | null {
  const localFingerprint = userTurnFingerprint(localMessage);
  const localTime = readMessageTime(localMessage);
  if (!localFingerprint || localTime === null) {
    return null;
  }

  const dedupeWindow = localFingerprint.text
    ? LOCAL_USER_DEDUPE_WINDOW_MS
    : LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS;
  let closestMatch: NormalizedMessage | null = null;
  let closestTimeDifference = Number.POSITIVE_INFINITY;

  for (const serverMessage of serverMessages) {
    if (claimedServerIds.has(serverMessage.id)) {
      continue;
    }

    const serverFingerprint = userTurnFingerprint(serverMessage);
    if (!serverFingerprint || !userTurnFingerprintsMatch(localFingerprint, serverFingerprint)) {
      continue;
    }

    const serverTime = readMessageTime(serverMessage);
    if (
      serverTime === null
      || serverTime < localTime - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
      || serverTime - localTime > dedupeWindow
    ) {
      continue;
    }

    const timeDifference = Math.abs(serverTime - localTime);
    if (timeDifference < closestTimeDifference) {
      closestMatch = serverMessage;
      closestTimeDifference = timeDifference;
    }
  }

  return closestMatch;
}

/**
 * Removes local optimistic user rows once a corresponding persisted turn is
 * available. Matches are one-to-one so repeated sends cannot claim one row.
 */
export function removeOptimisticUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const claimedServerIds = new Set<string>();

  return realtimeMessages.filter((message) => {
    // Deduplicate all user-text realtime rows — whether they are frontend
    // optimistic echoes (local_*) or provider-runtime echoes of the user
    // turn (streaming-input turns receive a copy without the JSONL UUID).
    // Without this, attachment turns produce a duplicate user bubble:
    // one from the runtime echo (random UUID) and one from the persisted
    // server copy (CLI-assigned UUID).
    if (message.kind !== 'text' || message.role !== 'user') {
      return true;
    }

    const serverEcho = findServerEchoForLocalUser(message, serverMessages, claimedServerIds);
    if (!serverEcho) {
      return true;
    }

    claimedServerIds.add(serverEcho.id);
    return false;
  });
}

/**
 * Removes SDK-streamed user echoes when a local optimistic user message
 * with matching content already exists in the realtime buffer.
 *
 * During a new session's first live stream the `realtimeMessages` buffer
 * carries both the frontend's optimistic insert (id `local_*`) and the
 * provider runtime's echo of the user turn.  Before the server transcript
 * is populated, `removeOptimisticUserEchoes` has nothing to match against,
 * so a self-dedup pass is needed to keep only one user bubble.
 */
export function dedupeRealtimeUserEchoes(
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const LOCAL_ID = /^local_/;

  // Collect fingerprints of local optimistic user messages so we know
  // which SDK-echoed rows to drop as duplicates.
  const localFingerprints: Array<UserTurnFingerprint & { id: string }> = [];
  for (const message of realtimeMessages) {
    if (message.kind !== 'text' || message.role !== 'user') continue;
    if (!LOCAL_ID.test(message.id)) continue;
    const fp = userTurnFingerprint(message);
    if (fp) {
      localFingerprints.push({ ...fp, id: message.id });
    }
  }

  if (localFingerprints.length === 0) return realtimeMessages;

  const claimedLocalIds = new Set<string>();

  return realtimeMessages.filter((message) => {
    if (message.kind !== 'text' || message.role !== 'user') return true;

    // Always keep the local optimistic row itself.
    if (LOCAL_ID.test(message.id)) return true;

    const messageFp = userTurnFingerprint(message);
    if (!messageFp) return true;

    for (const localFp of localFingerprints) {
      if (claimedLocalIds.has(localFp.id)) continue;
      if (!userTurnFingerprintsMatch(messageFp, localFp)) continue;

      claimedLocalIds.add(localFp.id);
      return false;
    }

    return true;
  });
}
