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

if (!['stable', 'nightly'].includes(channel)) {
  throw new Error(`Unsupported channel: ${channel}`);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
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

  const buildEntryPath = path.join(pluginDir, meta.entry);
  const moduleUrl = pathToFileURL(buildEntryPath);
  moduleUrl.searchParams.set('ts5dr_market', `${Date.now()}`);
  const loaded = await import(moduleUrl.href);
  const plugin = loaded.default ?? loaded;
  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`Built plugin entry did not export a plugin object: ${meta.pluginName}`);
  }

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

  return {
    name: meta.pluginName,
    title: meta.title,
    description: meta.description,
    locales: Object.keys(locales).length > 0 ? locales : undefined,
    latestVersion: pkg.version,
    minHostVersion: meta.minHostVersion,
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
  schemaVersion: 1,
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
