#!/usr/bin/env node
/**
 * Prepares Cloudflare Build Output Specification v1 (`.cloudflare/output/v1/`)
 * combining the `notes-site-base` Worker runtime, optional consumer worker entrypoint,
 * `cloudflare.config.ts`, and built static assets (`dist/`) so `cf deploy --prebuilt`
 * deploys the full Worker + D1 + Static Assets stack cleanly without Wrangler.
 */

import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_RUNTIME_MODULES = ['index.mjs', 'merge.mjs', 'sanitizer.mjs'];

const BASE_SPECIFIER_TARGETS = new Map([
  ['notes-site-base/worker', '_notes_base/index.mjs'],
  ['notes-site-base/worker/merge', '_notes_base/merge.mjs'],
  ['notes-site-base/worker/sanitizer', '_notes_base/sanitizer.mjs'],
]);

const DEFAULT_SYNC_HASH_PREFIX = 'notes-sync-v1:';

// Matches static import/export specifiers (`from "..."`, `import "..."`)
const MODULE_SPECIFIER_RE =
  /(\b(?:from|import)\s*['"])([^'"]+)(['"])/g;

function toPosixRelative(fromBundleRel, toBundleRel) {
  let rel = path.posix.relative(path.posix.dirname(fromBundleRel), toBundleRel);
  if (!rel.startsWith('.')) {
    rel = `./${rel}`;
  }
  return rel;
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function resolveCloudflareConfigPath(rootDir, explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(rootDir, explicitPath);
    await fs.access(resolved);
    return resolved;
  }
  for (const candidate of ['cloudflare.config.ts', 'cloudflare.config.mjs', 'cloudflare.config.js']) {
    const full = path.join(rootDir, candidate);
    try {
      await fs.access(full);
      return full;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Cloudflare config not found in ${rootDir} (expected cloudflare.config.ts/.mjs/.js).`
  );
}

/**
 * Recursively copy and rewrite a consumer ESM entrypoint and its local relative imports
 * into `bundleDir`, rewriting `notes-site-base/worker*` bare specifiers to `_notes_base/*`.
 */
async function bundleConsumerEntrypoint({ rootDir, entryAbs, bundleDir, modulesManifest }) {
  const realRoot = await fs.realpath(rootDir);
  const realEntry = await fs.realpath(entryAbs);
  const visited = new Map(); // realAbsPath -> bundleRelPosix

  async function processFile(absFile, forcedBundleRel = null) {
    const realFile = await fs.realpath(absFile);
    if (visited.has(realFile)) {
      return visited.get(realFile);
    }

    const relFromRoot = path.relative(realRoot, realFile);
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      throw new Error(`Worker module "${absFile}" escapes project root "${rootDir}".`);
    }

    const bundleRel =
      forcedBundleRel ||
      path.posix.join('_user', relFromRoot.split(path.sep).join('/'));
    visited.set(realFile, bundleRel);

    const ext = path.extname(realFile).toLowerCase();
    const outPath = path.join(bundleDir, ...bundleRel.split('/'));
    await fs.mkdir(path.dirname(outPath), { recursive: true });

    if (ext === '.json') {
      const content = await fs.readFile(realFile, 'utf8');
      await fs.writeFile(outPath, content, 'utf8');
      modulesManifest[bundleRel] = { type: 'json' };
      return bundleRel;
    }

    if (ext !== '.mjs' && ext !== '.js') {
      throw new Error(
        `Unsupported Worker module extension "${ext}" for "${relFromRoot}". Use ESM (.mjs/.js) or .json.`
      );
    }

    const source = await fs.readFile(realFile, 'utf8');
    const replacements = [];

    for (const match of source.matchAll(MODULE_SPECIFIER_RE)) {
      const [fullMatch, prefix, spec, suffix] = match;
      const start = match.index;
      const end = start + fullMatch.length;

      if (BASE_SPECIFIER_TARGETS.has(spec)) {
        const targetRel = toPosixRelative(bundleRel, BASE_SPECIFIER_TARGETS.get(spec));
        replacements.push({ start, end, text: `${prefix}${targetRel}${suffix}` });
      } else if (spec.startsWith('./') || spec.startsWith('../')) {
        const depAbs = path.resolve(path.dirname(realFile), spec);
        const depBundleRel = await processFile(depAbs);
        const targetRel = toPosixRelative(bundleRel, depBundleRel);
        replacements.push({ start, end, text: `${prefix}${targetRel}${suffix}` });
      }
    }

    let rewritten = source;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const r = replacements[i];
      rewritten = rewritten.slice(0, r.start) + r.text + rewritten.slice(r.end);
    }

    await fs.writeFile(outPath, rewritten, 'utf8');
    modulesManifest[bundleRel] = { type: 'esm' };
    return bundleRel;
  }

  await processFile(realEntry, 'index.mjs');
}

/**
 * Load `cloudflare.config.{ts,mjs,js}` across both Node >= 22.18 (native TS import)
 * and Node 20.x / Node < 22.18 (where importing `.ts` throws ERR_UNKNOWN_FILE_EXTENSION).
 */
export async function loadCloudflareConfig(cfConfigPath, { forceFallback = false } = {}) {
  const isTs = path.extname(cfConfigPath).toLowerCase() === '.ts';
  if (!forceFallback) {
    try {
      const loaded = await import(`${pathToFileURL(cfConfigPath).href}?t=${Date.now()}`);
      return loaded.default;
    } catch (err) {
      if (!isTs || err?.code !== 'ERR_UNKNOWN_FILE_EXTENSION') {
        throw err;
      }
    }
  }

  let code = await fs.readFile(cfConfigPath, 'utf8');
  if (typeof nodeModule.stripTypeScriptTypes === 'function') {
    try {
      code = nodeModule.stripTypeScriptTypes(code);
    } catch {
      // Fallback to raw plain-ESM source when stripTypeScriptTypes is unavailable or disabled.
    }
  }

  const dataUrl = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;
  const loaded = await import(dataUrl);
  return loaded.default;
}

/**
 * Prepare `.cloudflare/output/v1/` Build Output for `cf deploy --prebuilt`.
 *
 * @param {{ rootDir?: string, distDir?: string, configPath?: string, quiet?: boolean }} [options]
 */
export async function prepareDeploy(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const siteConfig = await readJsonIfExists(path.join(rootDir, 'site.config.json'));
  const configuredOutDir = siteConfig?.paths?.outDir || 'dist';
  const distDir = path.resolve(rootDir, options.distDir || configuredOutDir);

  const distStat = await fs.stat(distDir).catch(() => null);
  if (!distStat || !distStat.isDirectory()) {
    throw new Error(
      `Static assets directory not found: ${distDir}. Run the site build before prepare-deploy.`
    );
  }

  const cfConfigPath = await resolveCloudflareConfigPath(rootDir, options.configPath);
  const cfg = await loadCloudflareConfig(cfConfigPath);
  if (!cfg || !cfg.worker) {
    throw new Error(
      `${path.basename(cfConfigPath)} must default-export an object with a \`worker\` config.`
    );
  }

  const { entrypoint, ...workerConfigWithoutEntrypoint } = cfg.worker;
  const outputRoot = path.join(rootDir, '.cloudflare', 'output');
  const v1Dir = path.join(outputRoot, 'v1');
  const workerDir = path.join(v1Dir, 'workers', 'default');
  const bundleDir = path.join(workerDir, 'bundle');
  const baseBundleDir = path.join(bundleDir, '_notes_base');
  const assetsDir = path.join(workerDir, 'assets');

  // Clean and recreate `.cloudflare/output/v1/`
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(baseBundleDir, { recursive: true });
  await fs.mkdir(assetsDir, { recursive: true });

  // 1. Copy base runtime ESM modules into `bundle/_notes_base/`
  const modulesManifest = {};
  for (const modName of BASE_RUNTIME_MODULES) {
    const srcPath = path.join(__dirname, modName);
    const dstPath = path.join(baseBundleDir, modName);
    await fs.copyFile(srcPath, dstPath);
    modulesManifest[`_notes_base/${modName}`] = { type: 'esm' };
  }

  // 2. Emit `bundle/index.mjs` (from consumer entrypoint or auto-generated from site.config.json)
  if (!entrypoint || entrypoint === 'notes-site-base/worker') {
    const syncHashPrefix =
      typeof siteConfig?.storage?.syncHashPrefix === 'string' &&
      siteConfig.storage.syncHashPrefix.trim()
        ? siteConfig.storage.syncHashPrefix
        : DEFAULT_SYNC_HASH_PREFIX;

    const generatedEntry = [
      "import { createWorker } from './_notes_base/index.mjs';",
      `export default createWorker({ syncHashPrefix: ${JSON.stringify(syncHashPrefix)} });`,
      '',
    ].join('\n');

    await fs.writeFile(path.join(bundleDir, 'index.mjs'), generatedEntry, 'utf8');
    modulesManifest['index.mjs'] = { type: 'esm' };
  } else {
    const entryAbs = path.resolve(rootDir, entrypoint);
    const entryStat = await fs.stat(entryAbs).catch(() => null);
    if (!entryStat || !entryStat.isFile()) {
      throw new Error(`Configured worker entrypoint not found: ${entryAbs}`);
    }
    await bundleConsumerEntrypoint({
      rootDir,
      entryAbs,
      bundleDir,
      modulesManifest,
    });
  }

  // 3. Copy static assets from distDir (dereferencing symlinks for portability)
  await fs.cp(distDir, assetsDir, { recursive: true, dereference: true });

  // 4. Write Build Output Spec v1 root config.json & worker.config.json
  const basePkg = await readJsonIfExists(path.resolve(__dirname, '../../package.json'));
  const rootConfig = {
    producer: {
      name: 'notes-site-base',
      version: basePkg?.version || '1.0.0',
    },
    buildContext: {
      isPreview: false,
    },
  };
  await fs.writeFile(
    path.join(v1Dir, 'config.json'),
    `${JSON.stringify(rootConfig, null, 2)}\n`,
    'utf8'
  );

  const outputWorkerConfig = {
    ...workerConfigWithoutEntrypoint,
    manifest: {
      type: 'complete',
      mainModule: 'index.mjs',
      modules: modulesManifest,
    },
  };
  await fs.writeFile(
    path.join(workerDir, 'worker.config.json'),
    `${JSON.stringify(outputWorkerConfig, null, 2)}\n`,
    'utf8'
  );

  const moduleCount = Object.keys(modulesManifest).length;
  if (!options.quiet) {
    console.log(
      `Prepared Build Output v1 at ${path.relative(rootDir, v1Dir) || '.cloudflare/output/v1'} ` +
        `(${moduleCount} Worker modules + static assets from ${path.relative(rootDir, distDir) || 'dist'}).`
    );
  }

  return {
    outputDir: v1Dir,
    bundleDir,
    assetsDir,
    workerConfig: outputWorkerConfig,
    moduleCount,
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) {
      opts.rootDir = argv[++i];
    } else if (arg.startsWith('--root=')) {
      opts.rootDir = arg.slice('--root='.length);
    } else if (arg === '--dist' && argv[i + 1]) {
      opts.distDir = argv[++i];
    } else if (arg.startsWith('--dist=')) {
      opts.distDir = arg.slice('--dist='.length);
    } else if (arg === '--config' && argv[i + 1]) {
      opts.configPath = argv[++i];
    } else if (arg.startsWith('--config=')) {
      opts.configPath = arg.slice('--config='.length);
    } else if (arg === '--quiet' || arg === '-q') {
      opts.quiet = true;
    }
  }
  return opts;
}

function isDirectCliInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectCliInvocation()) {
  prepareDeploy(parseCliArgs(process.argv.slice(2))).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
