#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const args = process.argv.slice(2);

function readFlag(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) {
    return fallback;
  }
  return args[index + 1];
}

const channel = readFlag('--channel', 'nightly');
const baseUrl = readFlag('--base-url', 'https://dl.tx5dr.com/plugins/market').replace(/\/+$/, '');
const outputDir = path.join(rootDir, '.artifacts', 'market', channel);
const artifactsDir = path.join(outputDir, 'artifacts');
const stagingRoot = path.join(rootDir, '.artifacts', 'staging');
const README_MAX_BYTES = 100 * 1024;
const RUNTIME_ENTRY_CANDIDATES = ['plugin.js', 'index.js', 'index.mjs'];
const ARTIFACT_MANIFEST_FILE = 'tx5dr-plugin.json';
const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

if (!['stable', 'nightly'].includes(channel)) {
  throw new Error(`Unsupported channel: ${channel}`);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStrictSemver(value, label) {
  if (typeof value !== 'string' || !STRICT_SEMVER_PATTERN.test(value)) {
    throw new Error(`${label} must be a strict semantic version`);
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

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

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getPluginDirs() {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const pluginDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.name === 'scripts') {
      continue;
    }
    const packageJsonPath = path.join(rootDir, entry.name, 'package.json');
    if (!await pathExists(packageJsonPath)) {
      continue;
    }
    const pkg = await readJson(packageJsonPath);
    if (!isObject(pkg.tx5drPlugin)) {
      continue;
    }
    pluginDirs.push(path.join(rootDir, entry.name));
  }
  if (pluginDirs.length === 0) {
    throw new Error('No plugin directories with package.json were found');
  }
  return pluginDirs.sort();
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

async function buildCatalogEntry(pluginDir) {
  const pkg = await readJson(path.join(pluginDir, 'package.json'));
  const meta = pkg.tx5drPlugin;

  if (!isObject(meta)) {
    throw new Error(`Missing tx5drPlugin metadata for plugin ${pluginDir}`);
  }
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

  const zipFileName = `${meta.pluginName}-${pkg.version}.zip`;
  const zipPath = path.join(artifactsDir, zipFileName);
  await fs.mkdir(artifactsDir, { recursive: true });
  const zipResult = spawnSync('zip', ['-qr', zipPath, '.'], {
    cwd: stageDir,
    stdio: 'inherit',
  });
  if (zipResult.status !== 0) {
    throw new Error(`zip command failed for ${meta.pluginName}`);
  }

  const artifactBytes = await fs.readFile(zipPath);
  const sha256 = createHash('sha256').update(artifactBytes).digest('hex');
  const stat = await fs.stat(zipPath);
  const locales = await readLocales(path.join(stageDir, 'locales'));
  const readmeMarkdown = await readPluginReadme(pluginDir);
  const readmeSourceUrl = buildReadmeSourceUrl(meta.repository, pluginDir);

  return {
    name: meta.pluginName,
    title: meta.title,
    description: meta.description,
    readmeMarkdown,
    readmeSourceUrl,
    locales: Object.keys(locales).length > 0 ? locales : undefined,
    latestVersion: pkg.version,
    minPluginApiVersion: meta.minPluginApiVersion,
    author: meta.author,
    license: meta.license ?? 'GPL-3.0-only',
    repository: meta.repository,
    homepage: meta.homepage,
    categories: Array.isArray(meta.categories) ? meta.categories : [],
    keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
    permissions: Array.isArray(plugin.permissions) ? plugin.permissions : [],
    screenshots: Array.isArray(meta.screenshots) ? meta.screenshots : [],
    artifactUrl: `${baseUrl}/${channel}/artifacts/${zipFileName}`,
    sha256,
    size: stat.size,
    publishedAt: new Date().toISOString(),
    artifactManifestVersion: 1,
  };
}

await fs.rm(outputDir, { recursive: true, force: true });
await fs.rm(stagingRoot, { recursive: true, force: true });
await fs.mkdir(artifactsDir, { recursive: true });

const pluginDirs = await getPluginDirs();
const plugins = [];
for (const pluginDir of pluginDirs) {
  plugins.push(await buildCatalogEntry(pluginDir));
}

const catalog = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  channel,
  plugins: plugins.sort((left, right) => left.name.localeCompare(right.name)),
};

await fs.writeFile(
  path.join(outputDir, 'index.json'),
  `${JSON.stringify(catalog, null, 2)}\n`,
  'utf8',
);

console.log(`Packaged ${plugins.length} plugin(s) for ${channel}: ${outputDir}`);
