#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const stageDir = path.join(rootDir, '.desktop-build', 'desktop-app');

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

// ── Pi agent binary bundling ───────────────────────────────────────────────
// Pi is compiled to a standalone binary (via `bun build --compile`) and
// shipped alongside its assets (theme, wasm, etc.) in electron/pi/.
// The binary is self-contained (includes Bun runtime), so no node_modules
// or Node.js is needed — just copy the binary + assets into the stage.

const PI_BUNDLE_DIR = path.join(rootDir, 'electron', 'pi');
const piBinaryName = process.platform === 'win32' ? 'pi.exe' : 'pi';
const piBinarySrc = path.join(PI_BUNDLE_DIR, piBinaryName);

if (await pathExists(piBinarySrc)) {
  // Copy binary + assets into the stage.
  await fs.cp(PI_BUNDLE_DIR, path.join(stageDir, 'electron', 'pi'), { recursive: true });
  console.log(`[stage] Bundled Pi binary (${piBinaryName}) + assets.`);
} else {
  console.warn(`Warning: ${piBinarySrc} not found — Pi CLI will not be bundled. Build it with 'bun build --compile' in the pi repo.`);
}

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
