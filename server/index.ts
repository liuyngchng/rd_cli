#!/usr/bin/env node
// Load environment variables before other imports execute.
import './load-env.js';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { AppError, findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';
import { strictAuthLimiter, generalApiLimiter } from '@/modules/security/rate-limiter.js';
import {
    closeSessionsWatcher,
    initializeSessionsWatcher,
    providerRuntimeService,
    startSessionCleanupScheduler,
    stopSessionCleanupScheduler,
} from '@/modules/providers/index.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { createGitModule } from './modules/git/index.js';
import {
    authenticateToken,
    authenticateWebSocket,
    authRoutes,
    validateApiKey,
} from './modules/auth/index.js';
import { taskmasterRoutes } from './modules/taskmaster/index.js';
import { commandsRoutes } from './modules/commands/index.js';
import { settingsRoutes } from './modules/settings/index.js';
import { createSystemModule } from './modules/system/index.js';
import { createAgentModule } from './modules/agent/index.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import { userRoutes, userWorkspaceService } from './modules/user/index.js';
import {
    getPluginPort,
    pluginsRoutes,
    startEnabledPluginServers,
    stopAllPlugins,
} from './modules/plugins/index.js';
import providerRoutes from './modules/providers/provider.routes.js';
import { voiceRoutes } from './modules/voice/index.js';
import { createProofreadModule } from './modules/proofread/index.js';
import browserUseRoutes from './modules/browser-use/browser-use.routes.js';
import { assetsRoutes } from './modules/assets/index.js';
import { fileTreeRoutes } from './modules/file-tree/index.js';
import { worktreesRoutes } from './modules/worktrees/index.js';
import browserUseMcpRoutes from './modules/browser-use/browser-use-mcp.routes.js';
import { browserUseService } from './modules/browser-use/browser-use.service.js';
import { closeConnection, initializeDatabase, proofreadTasksDb, sessionsDb } from './modules/database/index.js';
import { configureWebPush } from './modules/notifications/index.js';
import { IS_PLATFORM } from './constants/config.js';
import { debug } from '@/shared/debug.js';
import logger from '@/shared/logger.js';
const log = logger.child({ module: 'server' });

const __dirname = getModuleDirectory(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findApplicationRoot(__dirname);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
const systemRoutes = createSystemModule({
    appRoot: APP_ROOT,
    installMode,
    isPlatform: IS_PLATFORM,
});
log.info('SERVER_PORT from env:', process.env.SERVER_PORT);

const app = express();

// HTTPS: use self-signed certs when available (RDCLI_HTTPS_CERT / RDCLI_HTTPS_KEY).
// The Dockerfile wires these env vars; outside Docker set them manually.
const httpsCertPath = process.env.RDCLI_HTTPS_CERT || '';
const httpsKeyPath  = process.env.RDCLI_HTTPS_KEY  || '';
let httpsOptions: { cert: Buffer; key: Buffer } | null = null;
if (httpsCertPath && httpsKeyPath && fs.existsSync(httpsCertPath) && fs.existsSync(httpsKeyPath)) {
    try {
        httpsOptions = {
            cert: fs.readFileSync(httpsCertPath),
            key:  fs.readFileSync(httpsKeyPath),
        };
        log.info('HTTPS 已启用（自签证书）');
    } catch (e) {
        log.error('HTTPS 证书读取失败，回退至 HTTP: %s', (e as Error).message);
    }
}

const server = httpsOptions
    ? https.createServer(httpsOptions, app)
    : http.createServer(app);
const queryClaude = providerRuntimeService.getRunner('claude');
const gitRoutes = createGitModule({
    queryClaude,
});
const agentRoutes = createAgentModule({
    queryClaude,
});

// Single WebSocket server that handles chat, shell, and plugin proxy paths.
const wss = createWebSocketServer(server, {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        authenticateWebSocket,
    },
    chat: {
        runtime: providerRuntimeService,
    },
    shell: {
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            if (dbSession) {
                return dbSession.provider_session_id ?? null;
            }

            return null;
        },
        resolveUserWorkspaceRoot: (userId) => userWorkspaceService.ensureUserWorkspace(userId),
        validateUserWorkspacePath: (userId, candidatePath) =>
            userWorkspaceService.validatePathWithinUserRoot(userId, candidatePath),
    },
    getPluginPort,
});

// Make WebSocket server available to routes
app.locals.wss = wss;

// ── Security Headers ─────────────────────────────────────────────────
// Helmet sets Content-Security-Policy, X-Frame-Options, HSTS, X-Content-Type-Options,
// Referrer-Policy, and other standard security headers.
// CSP is relaxed enough to allow the app's inline styles/scripts for dev + production.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'self'"],
      },
      useDefaults: false,
    },
    crossOriginEmbedderPolicy: false, // Allow loading external resources
  })
);

// CORS: restrict origins when configured, otherwise allow local dev origins.
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3001', 'http://127.0.0.1:3001'];

app.use(cors({
  origin: corsOrigins,
  exposedHeaders: ['X-Refreshed-Token', 'X-Auth-Error'],
  credentials: true,
}));

app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ── Rate Limiting ────────────────────────────────────────────────────
// General API rate limiter protects all /api routes from DoS.
app.use('/api', generalApiLimiter);

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode,
        version: RUNNING_VERSION
    });
});

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public) with strict rate limiting for brute-force protection
app.use('/api/auth', strictAuthLimiter, authRoutes);

// File Tree API Routes (protected)
app.use('/api/file-tree', authenticateToken, fileTreeRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Chat attachment upload/serving (user workspace ~/.rdcli/users/<userId>, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// Git worktree management (protected)
app.use('/api/worktrees', authenticateToken, worktreesRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

app.use('/api/system', authenticateToken, systemRoutes);

app.use('/api/notifications', authenticateToken, notificationRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Plugins API Routes (protected)
app.use('/api/plugins', authenticateToken, pluginsRoutes);

// Browser MCP bridge API (local token protected)
app.use('/api/browser-use-mcp', browserUseMcpRoutes);

// Browser API Routes (protected)
app.use('/api/browser-use', authenticateToken, browserUseRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

// Proofread API (uses API key authentication, creates pre-filled sessions)
app.use('/api/proofread', createProofreadModule(
  queryClaude,
  proofreadTasksDb,
  sessionsDb,
  (sessionId: string) => providerRuntimeService.abort('claude', sessionId),
));

app.use('/api/voice', authenticateToken, voiceRoutes);

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// Chat uploads live under /api/assets (server/modules/assets), which stores
// images and general files in the user workspace ~/.rdcli/users/<userId>.

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  log.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

const SERVER_PORT = Number.parseInt(process.env.SERVER_PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SERVER_PROTOCOL = httpsOptions ? 'https' : 'http';
const VITE_PORT = process.env.VITE_PORT || 5173;

// Container-aware display host / port.
// Docker deploy.sh sets PUBLIC_HOST (host machine's LAN IP), PUBLIC_PORT (the
// host-mapped port), and CONTAINER_NAME (the DNS name on llm_net).  When all
// three are present the server knows it runs inside Docker and produces URLs
// that external callers and peer containers can actually use.
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
const PUBLIC_PORT = Number.parseInt(process.env.PUBLIC_PORT || '0', 10);
const CONTAINER_NAME = process.env.CONTAINER_NAME || '';
const IS_CONTAINER = Boolean(PUBLIC_HOST && PUBLIC_PORT && CONTAINER_NAME);
// The host that browsers should use: public IP when in Docker, otherwise the
// result of getConnectableHost() so loopback / wildcard resolves to localhost.
const DISPLAY_HOST = PUBLIC_HOST || getConnectableHost(HOST);
// External URL uses the mapped port on the host; inside a container the
// internal PORT differs from the port the outside world reaches.
const DISPLAY_PORT = PUBLIC_PORT || SERVER_PORT;

const LOCAL_SERVER_MARKER_PATH = path.join(os.homedir(), '.rdcli', 'local-server.json');

function getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return undefined;
    }
    return String(error.code);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function writeLocalServerMarker() {
    const marker = {
        pid: process.pid,
        host: HOST,
        port: SERVER_PORT,
        url: `${SERVER_PROTOCOL}://${DISPLAY_HOST}:${DISPLAY_PORT}`,
        installMode,
        appRoot: APP_ROOT,
        updatedAt: new Date().toISOString(),
    };

    await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true });
    await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function removeLocalServerMarker() {
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const marker = JSON.parse(raw);
        if (marker.pid && marker.pid !== process.pid) return;
    } catch (error) {
        if (getErrorCode(error) === 'ENOENT') return;
    }

    try {
        await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
    } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') {
            log.warn('Could not remove local server marker: %s', getErrorMessage(error));
        }
    }
}

// Initialize database and start server
async function startServer() {
    try {
        debug('startServer: entering try block, all modules imported');
        debug('startServer: calling initializeDatabase()');
        // Initialize authentication database
        await initializeDatabase();

        debug('startServer: calling configureWebPush()');
        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        log.info('Using Claude Agents SDK for Claude integration');

        if (isProduction) {
            log.info('To run in production mode, go to %s://%s:%s', SERVER_PROTOCOL, DISPLAY_HOST, DISPLAY_PORT);
        }

        log.info('To run in development mode with hot-module replacement, go to http://%s:%s', DISPLAY_HOST, VITE_PORT);
   
        server.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                log.error('端口 %s 已被占用（旧进程可能尚未完全退出），请稍后重试或释放端口。', SERVER_PORT);
            }
            log.error(error, 'Server failed to start');
            process.exit(1);
        });

        server.listen(SERVER_PORT, HOST, async () => {
            const log = logger.child({ module: 'server' });
            const appInstallPath = APP_ROOT;
            await writeLocalServerMarker().catch((error) => {
                log.warn('Could not write local server marker: %s', error.message);
            });

            log.info('═'.repeat(63));
            log.info('  rdCLI Server - Ready');
            log.info('═'.repeat(63));
            log.info('Server URL:  %s://%s:%s', SERVER_PROTOCOL, DISPLAY_HOST, DISPLAY_PORT);
            if (IS_CONTAINER) {
                log.info('llm_net URL: %s://%s:%s', SERVER_PROTOCOL, CONTAINER_NAME, SERVER_PORT);
            }
            log.info('Installed at: %s', appInstallPath);
            log.info('Run "rdcli status" for full configuration details');

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();

            // Start periodic session-expiry cleanup (30-day retention default)
            startSessionCleanupScheduler();

            // Start server-side plugin processes for enabled plugins
            startEnabledPluginServers().catch(err => {
                const pluginLog = logger.child({ module: 'plugins' });
                pluginLog.error('Error during startup: %s', err.message);
            });
        });

        // Clean up all long-lived resources on shutdown: browser sessions, plugin
        // subprocesses, file watchers, the SQLite connection, and the server marker.
        const shutdownRuntimeServices = async () => {
            const pluginLog = logger.child({ module: 'plugins' });
            const browserLog = logger.child({ module: 'browser' });
            const sessionLog = logger.child({ module: 'sessions' });
            const dbLog = logger.child({ module: 'database' });
            const log = logger.child({ module: 'server' });
            try {
                await browserUseService.stopAllSessions();
            } catch (err) {
                browserLog.error('Error stopping sessions during shutdown: %s', getErrorMessage(err));
            }
            try {
                await stopAllPlugins();
            } catch (err) {
                pluginLog.error('Error stopping plugins during shutdown: %s', getErrorMessage(err));
            }
            try {
                await closeSessionsWatcher();
            } catch (err) {
                sessionLog.error('Error closing session watchers during shutdown: %s', getErrorMessage(err));
            }
            try {
                stopSessionCleanupScheduler();
            } catch (err) {
                sessionLog.error('Error stopping session cleanup scheduler during shutdown: %s', getErrorMessage(err));
            }
            try {
                closeConnection();
            } catch (err) {
                dbLog.error('Error closing database connection during shutdown: %s', getErrorMessage(err));
            }
            try {
                await removeLocalServerMarker();
            } catch (err) {
                log.error('Error removing server marker during shutdown: %s', getErrorMessage(err));
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        log.error(error, 'Failed to start server');
        process.exit(1);
    }
}

startServer();
debug('server/index.ts: module evaluation complete, startServer() called');
