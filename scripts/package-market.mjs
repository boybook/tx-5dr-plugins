#!/usr/bin/env node

// Builds one deterministic archive per plugin plus `candidates.json`. It never
// publishes; `publish-market.mjs` decides which candidates are new versions.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  artifactsRoot,
  assertStrictSemver,
  getPluginDirs,
  git,
  isObject,
  pathExists,
  readJson,
  rootDir,
  writeJson,
} from './lib/market.mjs';

const artifactsDir = path.join(artifactsRoot, 'artifacts');
const stagingRoot = path.join(rootDir, '.artifacts', 'staging');
const README_MAX_BYTES = 100 * 1024;
const RUNTIME_ENTRY_CANDIDATES = ['plugin.js', 'index.js', 'index.mjs'];
const ARTIFACT_MANIFEST_FILE = 'tx5dr-plugin.json';
// 1980-01-01 is the earliest ZIP timestamp; fixed times keep archives reproducible.
const FIXED_MTIME = new Date('1980-01-01T00:00:00Z');

async function readPluginReadme(pluginDir) {
  const readmePath = path.join(pluginDir, 'README.md');
  if (!await pathExists(readmePath)) {
    return undefined;
  }

  const stat = await fs.stat(readmePath);
  if (stat.size > README_MAX_BYTES) {
    throw new Error(`README.md is too large for marketplace catalog: ${pluginDir}`);
  }

  return fs.readFile(readmePath, 'utf8');
}

function buildReadmeSourceUrl(repository, pluginDir) {
  if (typeof repository !== 'string' || repository.trim() === '') {
    return undefined;
  }

  try {
    const url = new URL(repository);
    if (url.hostname !== 'github.com') {
      return undefined;
    }

    const [owner, repoNameWithSuffix] = url.pathname
      .split('/')
      .filter(Boolean);
    if (!owner || !repoNameWithSuffix) {
      return undefined;
    }

    const repoName = repoNameWithSuffix.replace(/\.git$/i, '');
    const pluginDirName = path.basename(pluginDir);
    return `https://github.com/${owner}/${repoName}/blob/main/${pluginDirName}/README.md`;
  } catch {
    return undefined;
  }
}

async function readLocales(localesDir) {
  const locales = {};

  if (!await pathExists(localesDir)) {
    return locales;
  }

  const entries = await fs.readdir(localesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const language = entry.name.slice(0, -'.json'.length);
    locales[language] = await readJson(path.join(localesDir, entry.name));
  }

  return locales;
}

async function copyRecursive(source, target) {
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await copyRecursive(path.join(source, entry.name), path.join(target, entry.name));
    }
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function listFiles(directory, prefix = '') {
  const files = [];
  const entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(directory, relative));
    else files.push(relative);
  }
  return files;
}

/** Sorted entries, fixed timestamps and no extra attributes give stable bytes. */
async function writeDeterministicZip(stageDir, zipPath) {
  const files = (await listFiles(stageDir)).sort();
  for (const file of files) await fs.utimes(path.join(stageDir, file), FIXED_MTIME, FIXED_MTIME);
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.rm(zipPath, { force: true });
  const result = spawnSync('zip', ['-q', '-X', '-D', zipPath, '-@'], {
    cwd: stageDir,
    input: `${files.join('\n')}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, TZ: 'UTC' },
  });
  if (result.status !== 0) {
    throw new Error(`zip command failed for ${zipPath}`);
  }
}

async function buildCandidate(pluginDir) {
  const pkg = await readJson(path.join(pluginDir, 'package.json'));
  const meta = pkg.tx5drPlugin;

  if (!isObject(meta)) {
    throw new Error(`Missing tx5drPlugin metadata for plugin ${pluginDir}`);
  }
  assertStrictSemver(pkg.version, `Plugin ${meta.pluginName ?? pluginDir} package version`);
  assertStrictSemver(
    meta.minPluginApiVersion,
    `Plugin ${meta.pluginName ?? pluginDir} package minPluginApiVersion`,
  );

  const stageDir = path.join(stagingRoot, meta.pluginName);
  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });

  for (const item of meta.include) {
    const sourcePath = path.join(pluginDir, item.from);
    const optional = item.optional === true;
    if (!await pathExists(sourcePath)) {
      if (optional) {
        continue;
      }
      throw new Error(`Missing package include source for ${meta.pluginName}: ${item.from}`);
    }
    await copyRecursive(sourcePath, path.join(stageDir, item.to));
  }

  let runtimeEntryPath;
  for (const candidate of RUNTIME_ENTRY_CANDIDATES) {
    const candidatePath = path.join(stageDir, candidate);
    if (await pathExists(candidatePath)) {
      runtimeEntryPath = candidatePath;
      break;
    }
  }
  if (!runtimeEntryPath) {
    throw new Error(
      `Packaged plugin ${meta.pluginName} is missing a runtime entry (${RUNTIME_ENTRY_CANDIDATES.join(', ')})`,
    );
  }

  // Import the staged entry, not the workspace build output. This catches
  // missing relative modules and other packaging-only failures before release.
  const moduleUrl = pathToFileURL(runtimeEntryPath);
  moduleUrl.searchParams.set('ts5dr_market', `${Date.now()}`);
  const loaded = await import(moduleUrl.href);
  const plugin = loaded.default ?? loaded;
  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`Packaged plugin entry did not export a plugin object: ${meta.pluginName}`);
  }
  if (plugin.name !== meta.pluginName) {
    throw new Error(
      `Packaged plugin name mismatch: metadata=${meta.pluginName}, runtime=${String(plugin.name)}`,
    );
  }
  if (plugin.version !== pkg.version) {
    throw new Error(
      `Packaged plugin version mismatch for ${meta.pluginName}: package=${pkg.version}, runtime=${String(plugin.version)}`,
    );
  }
  assertStrictSemver(
    plugin.minPluginApiVersion,
    `Plugin ${meta.pluginName} runtime minPluginApiVersion`,
  );
  if (plugin.minPluginApiVersion !== meta.minPluginApiVersion) {
    throw new Error(
      `Packaged plugin Plugin API requirement mismatch for ${meta.pluginName}: `
      + `package=${String(meta.minPluginApiVersion)}, runtime=${String(plugin.minPluginApiVersion)}`,
    );
  }

  const artifactManifest = {
    schemaVersion: 1,
    name: plugin.name,
    version: plugin.version,
    minPluginApiVersion: plugin.minPluginApiVersion,
    ...(plugin.apiVersion === 2 ? { apiVersion: 2 } : {}),
    type: plugin.type,
    instanceScope: plugin.instanceScope ?? 'operator',
    permissions: Array.isArray(plugin.permissions) ? plugin.permissions : [],
    ...(plugin.strategyFeatures ? { strategyFeatures: plugin.strategyFeatures } : {}),
  };
  await fs.writeFile(
    path.join(stageDir, ARTIFACT_MANIFEST_FILE),
    `${JSON.stringify(artifactManifest, null, 2)}\n`,
    'utf8',
  );

  const zipPath = path.join(artifactsDir, meta.pluginName, `${pkg.version}.zip`);
  await writeDeterministicZip(stageDir, zipPath);
  const artifactBytes = await fs.readFile(zipPath);
  const locales = await readLocales(path.join(stageDir, 'locales'));

  return {
    name: meta.pluginName,
    pluginDir: path.relative(rootDir, pluginDir),
    meta: {
      title: meta.title,
      description: meta.description,
      readmeMarkdown: await readPluginReadme(pluginDir),
      readmeSourceUrl: buildReadmeSourceUrl(meta.repository, pluginDir),
      locales: Object.keys(locales).length > 0 ? locales : undefined,
      author: meta.author,
      license: meta.license ?? 'GPL-3.0-only',
      repository: meta.repository,
      homepage: meta.homepage,
      categories: Array.isArray(meta.categories) ? meta.categories : [],
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      screenshots: Array.isArray(meta.screenshots) ? meta.screenshots : [],
    },
    version: {
      version: pkg.version,
      minPluginApiVersion: meta.minPluginApiVersion,
      permissions: artifactManifest.permissions,
      sha256: createHash('sha256').update(artifactBytes).digest('hex'),
      size: artifactBytes.length,
      artifactManifestVersion: 1,
    },
    archive: path.relative(rootDir, zipPath),
  };
}

await fs.rm(artifactsRoot, { recursive: true, force: true });
await fs.rm(stagingRoot, { recursive: true, force: true });
await fs.mkdir(artifactsDir, { recursive: true });

const candidates = [];
for (const pluginDir of await getPluginDirs()) {
  candidates.push(await buildCandidate(pluginDir));
}

await writeJson(path.join(artifactsRoot, 'candidates.json'), {
  sourceCommit: git(['rev-parse', 'HEAD']),
  candidates: candidates.sort((left, right) => left.name.localeCompare(right.name)),
});

console.log(`Packaged ${candidates.length} plugin candidate(s): ${artifactsRoot}`);
