#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const stageDir = path.join(rootDir, '.desktop-build', 'desktop-app');
const PI_REPO_DIR = process.env.PI_REPO_DIR
  || path.resolve(rootDir, '..', 'pi');
const PI_PACKAGES_DIR = path.join(PI_REPO_DIR, 'packages');
const PI_STAGE_DIR = path.join(stageDir, 'node_modules', '@earendil-works');

const packageJson = JSON.parse(
  await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'),
);

function getElectronVersion() {
  try {
    return JSON.parse(
      readFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8'),
    ).version;
  } catch {
    try {
      return JSON.parse(
        readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'),
      ).packages['node_modules/electron'].version;
    } catch {
      throw new Error('Could not resolve an exact Electron version for desktop packaging.');
    }
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyRequired(relativePath) {
  const from = path.join(rootDir, relativePath);
  const to = path.join(stageDir, relativePath);
  if (!(await pathExists(from))) {
    throw new Error(`Required desktop build input is missing: ${relativePath}`);
  }
  await fs.cp(from, to, { recursive: true });
}

async function copyIfExists(relativePath) {
  const from = path.join(rootDir, relativePath);
  if (!(await pathExists(from))) return false;
  await fs.cp(from, path.join(stageDir, relativePath), { recursive: true });
  return true;
}

async function copyNodeModule(packageName) {
  return copyModuleFromRoot(path.join('node_modules', ...packageName.split('/')));
}

/**
 * Copy a module from Pi's node_modules into the stage dir.
 * Pi's external deps (e.g. chalk, typebox) live in Pi's own node_modules
 * and are not necessarily installed in rd_cli's node_modules.
 */
async function copyPiNodeModule(packageName) {
  const piRelPath = path.join('node_modules', ...packageName.split('/'));
  const from = path.join(PI_REPO_DIR, piRelPath);
  if (!(await pathExists(from))) return false;
  // Use the same path inside the stage so Node resolution works identically.
  const to = path.join(stageDir, piRelPath);
  if (copiedModulePaths.has(piRelPath)) return true;
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true });
  copiedModulePaths.add(piRelPath);
  return true;
}

function buildDesktopPackageJson(copiedOptionalDependencies) {
  return {
    name: `${packageJson.name}-desktop`,
    version: packageJson.version,
    productName: packageJson.productName,
    description: `${packageJson.productName} desktop shell`,
    author: packageJson.author,
    homepage: packageJson.homepage,
    license: packageJson.license,
    type: 'module',
    main: 'electron/main.js',
    // The bundled dist-server runs under Electron's Node runtime, so the
    // desktop app ships every runtime dependency of the main package.
    dependencies: {
      ...packageJson.dependencies,
    },
    optionalDependencies: copiedOptionalDependencies,
    build: {
      appId: packageJson.build.appId,
      productName: packageJson.build.productName,
      asar: packageJson.build.asar,
      artifactName: packageJson.build.artifactName,
      electronVersion: getElectronVersion(),
      directories: {
        output: '../../release/desktop',
      },
      extraMetadata: {
        main: 'electron/main.js',
      },
      files: [
        'electron/**',
        'public/**',
        'dist/**',
        'dist-server/**',
        'node_modules/**',
        'package.json',
      ],
      protocols: packageJson.build.protocols,
      linux: packageJson.build.linux,
      mac: packageJson.build.mac,
      win: packageJson.build.win,
      nsis: packageJson.build.nsis,
    },
  };
}

await fs.rm(stageDir, { recursive: true, force: true });
await fs.mkdir(stageDir, { recursive: true });

await copyRequired('electron');
await copyRequired('dist');
await copyRequired('dist-server');
await copyRequired('public');

// Copy every runtime dependency and its full transitive closure. The build
// machine's node_modules already holds the correct platform binaries and
// resolved versions for each module; the staged tree mirrors the root layout,
// so Node's runtime module resolution finds hoisted and nested transitive
// dependencies exactly as it does in dev.
const copiedModulePaths = new Set();

/**
 * Copy a module from the root node_modules to the same root-relative path in
 * the stage dir (e.g. 'node_modules/@scope/pkg'), so nested/hoisted layouts
 * resolve identically in the packaged app.
 *
 * @async
 * @function copyModuleFromRoot
 * @param {string} rootRelPath Root-relative path starting at 'node_modules'.
 * @returns {Promise<boolean>} true if the module exists and was copied (or had
 *   already been copied), false if it is not installed in root node_modules.
 */
async function copyModuleFromRoot(rootRelPath) {
  if (copiedModulePaths.has(rootRelPath)) return true;
  const from = path.join(rootDir, rootRelPath);
  if (!(await pathExists(from))) return false;
  const to = path.join(stageDir, rootRelPath);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true });
  copiedModulePaths.add(rootRelPath);
  return true;
}

const copiedRuntimeDependencies = [];
for (const name of Object.keys(packageJson.dependencies || {})) {
  if (await copyModuleFromRoot(path.join('node_modules', ...name.split('/')))) {
    copiedRuntimeDependencies.push(name);
  } else {
    console.warn(`Warning: ${name} not found in node_modules — will not be bundled.`);
  }
}

/**
 * Remove Spectre mitigation from the staged node-pty binding.gyp.
 *
 * node-pty sets SpectreMitigation in its binding.gyp on Windows, so the
 * electron-builder native rebuild (node-gyp -> MSBuild) fails with MSB8040
 * unless the "Spectre-mitigated libraries" VS component is installed.
 * Strip it so packaging works with a plain VS Build Tools install; the
 * locally built binaries simply ship without /Qspectre hardening.
 *
 * @see https://github.com/microsoft/node-pty/issues/645
 * @async
 * @function stripNodePtySpectreMitigation
 * @returns {Promise<void>} Resolves after patching, or when node-pty is absent.
 */
async function stripNodePtySpectreMitigation() {
  const gypPath = path.join(stageDir, 'node_modules', 'node-pty', 'binding.gyp');
  if (!(await pathExists(gypPath))) return;

  const gyp = await fs.readFile(gypPath, 'utf8');
  const patched = gyp.replace(/^[ \t]*'SpectreMitigation':[ \t]*'Spectre',?\r?\n/m, '');
  if (patched === gyp) {
    console.warn('Warning: SpectreMitigation not found in node-pty binding.gyp — MSB8040 may occur.');
    return;
  }

  await fs.writeFile(gypPath, patched, 'utf8');
  console.log('[stage] Removed SpectreMitigation from node-pty binding.gyp');
}

await stripNodePtySpectreMitigation();

// ── Pi agent bundling ──────────────────────────────────────────────────────
// Pi is a Node.js CLI (bin: { pi: dist/cli.js }) from the @earendil-works
// monorepo. We build Pi from source, copy the compiled dist/ of each workspace
// package into the stage, and copy its external dependencies into node_modules
// so the bundled app can spawn `node <bundled-pi>/dist/cli.js` without a
// system-level Pi installation.

/**
 * Pi workspace packages whose compiled dist/ output is copied into the stage.
 * Order matters for internal dependency resolution (leaf-first).
 */
const PI_WORKSPACE_PACKAGES = [
  { name: 'telemetry', pkgName: '@earendil-works/pi-telemetry' },
  { name: 'tui', pkgName: '@earendil-works/pi-tui' },
  { name: 'protocol', pkgName: '@earendil-works/pi-protocol' },
  { name: 'ai', pkgName: '@earendil-works/pi-ai' },
  { name: 'agent', pkgName: '@earendil-works/pi-agent-core' },
  { name: 'client', pkgName: '@earendil-works/pi-client' },
  { name: 'coding-agent', pkgName: '@earendil-works/pi-coding-agent' },
];

/**
 * External npm dependencies that Pi's compiled code needs at runtime.
 * These are the bare-specifier imports from Pi's dist/ that are not
 * node: builtins and not @earendil-works workspace packages.
 */
const PI_EXTERNAL_DEPENDENCIES = [
  '@anthropic-ai/sdk',
  '@aws-sdk/client-bedrock-runtime',
  '@google/genai',
  '@mariozechner/clipboard',
  '@opentelemetry/api',
  '@silvia-odwyer/photon-node',
  '@smithy/node-http-handler',
  'chalk',
  'cross-spawn',
  'diff',
  'get-east-asian-width',
  'glob',
  'grok-mermaid',
  'highlight.js',
  'hosted-git-info',
  'http-proxy-agent',
  'https-proxy-agent',
  'ignore',
  'jiti',
  'marked',
  'minimatch',
  'openai',
  'partial-json',
  'proper-lockfile',
  'semver',
  'typebox',
  'undici',
  'yaml',
];

/**
 * Build Pi from source (if not already built).
 */
async function buildPi() {
  const cliEntry = path.join(PI_PACKAGES_DIR, 'coding-agent', 'dist', 'cli.js');
  if (await pathExists(cliEntry)) {
    console.log('[stage] Pi already built, skipping build.');
    return;
  }

  console.log('[stage] Building Pi from source...');
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build:offline'], {
      cwd: PI_REPO_DIR,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env },
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Pi build failed with code ${code}`));
    });
  });
  console.log('[stage] Pi build complete.');
}

/**
 * Copy a Pi workspace package's dist/ and package.json into the stage.
 */
async function copyPiWorkspacePackage(pkgName, pkgDirName) {
  const srcDir = path.join(PI_PACKAGES_DIR, pkgDirName);
  const destDir = path.join(PI_STAGE_DIR, pkgName.replace('@earendil-works/', ''));
  const srcDist = path.join(srcDir, 'dist');
  const srcPkgJson = path.join(srcDir, 'package.json');

  if (!(await pathExists(srcDist))) {
    throw new Error(`Pi workspace package ${pkgName} has no dist/ directory. Run 'npm run build' in pi repo first.`);
  }

  await fs.mkdir(destDir, { recursive: true });
  await fs.cp(srcDist, path.join(destDir, 'dist'), { recursive: true });
  await fs.cp(srcPkgJson, path.join(destDir, 'package.json'));
  console.log(`[stage] Copied Pi package: ${pkgName}`);
}

async function ensurePiBundled() {
  await buildPi();
  await fs.mkdir(PI_STAGE_DIR, { recursive: true });

  for (const { name, pkgName } of PI_WORKSPACE_PACKAGES) {
    await copyPiWorkspacePackage(pkgName, name);
  }

  // Copy external dependencies of Pi into the stage node_modules.
  // These come from Pi's own node_modules, not rd_cli's.
  for (const dep of PI_EXTERNAL_DEPENDENCIES) {
    await copyPiNodeModule(dep);
  }

  // Create a 'pi' wrapper script alongside the bundled node_modules/.bin
  // so the runtime can spawn 'pi' and find the bundled CLI.
  const binDir = path.join(stageDir, 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });

  const piCliRelPath = path.join(
    '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js',
  );
  const piCliAbsPath = path.join(stageDir, 'node_modules', piCliRelPath);

  if (process.platform === 'win32') {
    const batContent = `@echo off\r\nnode "${piCliAbsPath}" %*`;
    await fs.writeFile(path.join(binDir, 'pi.cmd'), batContent, 'utf8');
  } else {
    const shContent = `#!/bin/sh\nexec node "${piCliAbsPath}" "$@"\n`;
    const shPath = path.join(binDir, 'pi');
    await fs.writeFile(shPath, shContent, { mode: 0o755, encoding: 'utf8' });
  }
  console.log('[stage] Created Pi CLI wrapper script.');
}

await ensurePiBundled();

const copiedOptionalDependencies = {};
for (const [name, version] of Object.entries(packageJson.optionalDependencies || {})) {
  if (await copyNodeModule(name)) {
    copiedOptionalDependencies[name] = version;
  }
}

const extraRuntimeModules = [
  '@nut-tree-fork/default-clipboard-provider',
  '@nut-tree-fork/libnut',
  '@nut-tree-fork/provider-interfaces',
  '@nut-tree-fork/shared',
  'jimp',
  'node-abort-controller',
  'temp',
];
for (const name of extraRuntimeModules) {
  await copyNodeModule(name);
}

/**
 * Copy the transitive dependency closure of the given root modules into the
 * stage dir, mirroring Node's resolution order: each dependency is looked up
 * along its parent's ancestor chain inside node_modules (deepest first), then
 * at the hoisted top level. Missing optional / platform-specific packages are
 * skipped silently.
 *
 * @async
 * @function copyDependencyClosure
 * @param {string[]} seedNames Top-level module names to start from.
 * @returns {Promise<void>} Resolves when the whole reachable closure is copied.
 */
async function copyDependencyClosure(seedNames) {
  const queue = seedNames.map((name) => ({ name, parent: null }));
  while (queue.length > 0) {
    const { name, parent } = queue.shift();

    const ancestors = parent ? parent.split(path.sep) : [];
    let source = null;
    for (let i = ancestors.length; i >= 0; i--) {
      if (i === 1) continue; // bare 'node_modules' is not a module directory
      const candidate = path.join(
        ...ancestors.slice(0, i), 'node_modules', ...name.split('/'),
      );
      if (await pathExists(path.join(rootDir, candidate))) {
        source = candidate;
        break;
      }
    }
    if (!source || !(await copyModuleFromRoot(source))) continue;

    let manifest;
    try {
      manifest = JSON.parse(
        await fs.readFile(path.join(rootDir, source, 'package.json'), 'utf8'),
      );
    } catch {
      continue; // no readable manifest — treat as a leaf
    }
    const transitive = [
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {}),
      ...Object.keys(manifest.peerDependencies || {}),
    ];
    for (const dep of transitive) {
      queue.push({ name: dep, parent: source });
    }
  }
}

await copyDependencyClosure([
  ...copiedRuntimeDependencies,
  ...Object.keys(copiedOptionalDependencies),
  ...PI_EXTERNAL_DEPENDENCIES,
  ...extraRuntimeModules,
]);

await fs.writeFile(
  path.join(stageDir, 'package.json'),
  `${JSON.stringify(buildDesktopPackageJson(copiedOptionalDependencies), null, 2)}\n`,
  'utf8',
);

console.log(`Prepared thin desktop app at ${path.relative(rootDir, stageDir)}`);
console.log(`Runtime dependencies: ${copiedRuntimeDependencies.join(', ')}`);
if (Object.keys(copiedOptionalDependencies).length) {
  console.log(`Optional dependencies: ${Object.keys(copiedOptionalDependencies).join(', ')}`);
}
