import crossSpawn from 'cross-spawn';
import path from 'node:path';

import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors,
} from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
} from '@/shared/utils.js';

const spawnFunction = crossSpawn;
const activePiProcesses = new Map();

/**
 * Resolve the Pi CLI command + entry to spawn.
 *
 * Priority:
 * 1. PI_CLI_PATH env var (explicit override, e.g. a system Pi install)
 * 2. PI_PACKAGE_DIR env var → <dir>/dist/cli.js (bundled Pi in the desktop app)
 * 3. bundled wrapper script on PATH (set by electron/localServer.js)
 * 4. bare 'pi' (development / system install)
 */
function resolvePiSpawnCommand() {
  if (process.env.PI_CLI_PATH) {
    return { command: process.execPath, argsPrefix: [process.env.PI_CLI_PATH] };
  }

  if (process.env.PI_PACKAGE_DIR) {
    const cliEntry = path.join(process.env.PI_PACKAGE_DIR, 'dist', 'cli.js');
    return { command: process.execPath, argsPrefix: [cliEntry] };
  }

  return { command: 'pi', argsPrefix: [] };
}

/**
 * Maps the UI permission mode onto Pi's non-interactive controls.
 * Pi has no built-in permission system, so we use flags to control behaviour:
 * - plan              → not supported by pi, treated as default
 * - bypassPermissions → pi --approve
 * - acceptEdits       → pi --approve
 * - default           → pi with no extra permissions flags
 */
function resolvePiPermissionOptions(permissionMode) {
  switch (permissionMode) {
    case 'bypassPermissions':
    case 'acceptEdits':
      return { args: ['--approve'], env: {} };
    default:
      return { args: [], env: {} };
  }
}

function readPiSessionId(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }
  return event.sessionId || event.id || null;
}

async function spawnPi(command, options = {}, ws, context) {
  return new Promise((resolve, reject) => {
    const {
      sessionId,
      projectPath,
      cwd,
      model,
      effort,
      sessionSummary,
      images,
      files,
      permissionMode,
    } = options;
    const workingDir = cwd || projectPath || process.cwd();
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = null;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let piProcess = null;
    let completeSent = false;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) return;
      terminalNotificationSent = true;
      const finalSessionId = sessionId || capturedSessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'pi',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'pi',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Pi CLI exited with code ${code}`,
      });
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) return;
      capturedSessionId = nextSessionId;
      if (!sessionId && processKey !== capturedSessionId && piProcess) {
        activePiProcesses.delete(processKey);
        activePiProcesses.set(capturedSessionId, piProcess);
      }
      if (piProcess) {
        piProcess.sessionId = capturedSessionId;
      }
      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }
      if (!sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'pi',
        }));
      }
    };

    const processPiOutputLine = (line) => {
      if (!line || !line.trim()) return;

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        ws.send(createNormalizedMessage({
          kind: 'stream_delta',
          content: line,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'pi',
        }));
        return;
      }

      try {
        // Pi JSON events have a `type` field at the top level
        registerSession(readPiSessionId(response));
        const normalized = context.normalizeMessage(response, capturedSessionId || sessionId || null);
        for (const msg of normalized) {
          ws.send(msg);
        }
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[Pi] Failed to process JSON output:', errorContent);
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'pi',
        }));
      }
    };

    void context.resolveResumeModel(sessionId, model).then(async (resolvedModel) => {
      const args = ['--mode', 'json', '-p'];
      const permissionOptions = resolvePiPermissionOptions(permissionMode);
      args.push(...permissionOptions.args);

      if (resolvedModel) {
        // Pi supports --model provider/modelId format
        args.push('--model', resolvedModel);
      }
      if (effort && effort !== 'default') {
        args.push('--thinking', effort);
      }

      const hasAttachments =
        normalizeAttachmentDescriptors(images).length > 0 ||
        normalizeAttachmentDescriptors(files).length > 0;

      const promptWithAttachments = appendFilesInputTag(
        appendImagesInputTag(command?.trim() || '', images),
        files,
      );
      args.push(flattenPromptForWindowsShell(promptWithAttachments));

      const { command, argsPrefix } = resolvePiSpawnCommand();
      piProcess = spawnFunction(command, [...argsPrefix, ...args], {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...permissionOptions.env },
      });

      activePiProcesses.set(processKey, piProcess);
      piProcess.sessionId = processKey;
      piProcess.stdin.end();

      piProcess.stdout.on('data', (data) => {
        stdoutLineBuffer += data.toString();
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';
        completeLines.forEach((line) => processPiOutputLine(line.trim()));
      });

      piProcess.stderr.on('data', (data) => {
        const stderrText = data.toString();
        if (!stderrText.trim()) return;
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: stderrText,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'pi',
        }));
      });

      piProcess.on('close', async (code) => {
        const finalSessionId = sessionId || capturedSessionId || processKey;
        activePiProcesses.delete(finalSessionId);
        activePiProcesses.delete(processKey);

        if (stdoutLineBuffer.trim()) {
          processPiOutputLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }

        if (!completeSent && !piProcess.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({
            provider: 'pi',
            sessionId: finalSessionId,
            exitCode: code,
          }));
        }

        if (code === 0) {
          notifyTerminalState({ code });
          resolve();
          return;
        }

        if (code === 127 || code === null) {
          const installed = await context.isProviderInstalled();
          if (!installed) {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: 'Pi CLI is not installed. Install it from https://pi.dev',
              sessionId: finalSessionId,
              provider: 'pi',
            }));
          }
        }

        notifyTerminalState({ code });
        reject(new Error(
          code === null ? 'Pi CLI process was terminated' : `Pi CLI exited with code ${code}`,
        ));
      });

      piProcess.on('error', async (error) => {
        const finalSessionId = sessionId || capturedSessionId || processKey;
        activePiProcesses.delete(finalSessionId);
        activePiProcesses.delete(processKey);

        const installed = await context.isProviderInstalled();
        const errorContent = !installed
          ? 'Pi CLI is not installed. Install it from https://pi.dev'
          : error.message;

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: finalSessionId,
          provider: 'pi',
        }));
        if (!completeSent && !piProcess.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({
            provider: 'pi',
            sessionId: finalSessionId,
            exitCode: 1,
          }));
        }
        notifyTerminalState({ error });
        reject(error);
      });
    }).catch(reject);
  });
}

function abortPiSession(sessionId) {
  const process = activePiProcesses.get(sessionId);
  if (!process) return false;

  process.aborted = true;
  process.kill('SIGTERM');
  activePiProcesses.delete(sessionId);
  return true;
}

export const piRuntime = {
  run: spawnPi,
  abort: abortPiSession,
};

export { spawnPi, abortPiSession };