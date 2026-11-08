#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertStrictSemver,
  compareSemver,
  getPluginDirs,
  isObject,
  pathExists as fileExists,
  pluginApiRanges,
  pluginSourcePathspecs,
  rangeFloor,
  readJson,
  readRegistry,
  sourceChangedSince,
} from './lib/market.mjs';

const README_MAX_BYTES = 100 * 1024;

/**
 * The Host accepts a plugin when its Plugin API satisfies `^minPluginApiVersion`,
 * so the declaration must not be lower than any Plugin API the plugin builds
 * against, and must stay within the same major.
 */
async function validatePluginApiDeclaration(workspaceDir, pkg) {
  const declared = pkg.tx5drPlugin.minPluginApiVersion;
  const ranges = await pluginApiRanges(workspaceDir, pkg);
  if (ranges.length === 0) {
    throw new Error(`Workspace ${pkg.name} must depend on @tx5dr/plugin-api so its Plugin API floor can be verified`);
  }
  for (const { source, range } of ranges) {
    const floor = rangeFloor(range);
    if (!floor) {
      throw new Error(`Workspace ${pkg.name}: unsupported @tx5dr/plugin-api range "${range}" in ${source}`);
    }
    if (compareSemver(declared, floor) < 0) {
      throw new Error(
        `Workspace ${pkg.name} declares minPluginApiVersion ${declared}, but ${source} builds against `
        + `@tx5dr/plugin-api ${range}; declare at least ${floor}`,
      );
    }
    if (declared.split('.')[0] !== floor.split('.')[0]) {
      throw new Error(
        `Workspace ${pkg.name} declares minPluginApiVersion ${declared} outside the major of ${source} range ${range}`,
      );
    }
  }
}

/** A published version is immutable: changing packaged sources requires a new version. */
function validateVersionNotRepublished(workspaceDir, pkg, record) {
  const published = record?.versions.find((entry) => entry.version === pkg.version);
  if (!published) return;
  if (published.minPluginApiVersion !== pkg.tx5drPlugin.minPluginApiVersion) {
    throw new Error(
      `Workspace ${pkg.name} ${pkg.version} is already published with minPluginApiVersion `
      + `${published.minPluginApiVersion}; bump the plugin version to change it`,
    );
  }
  if (sourceChangedSince(published.sourceCommit, pluginSourcePathspecs(workspaceDir, pkg))) {
    throw new Error(
      `Workspace ${pkg.name} sources changed since ${pkg.version} was published from `
      + `${published.sourceCommit.slice(0, 7)}; bump the plugin version`,
    );
  }
}

async function validateWorkspace(workspaceDir) {
  const packageJsonPath = path.join(workspaceDir, 'package.json');
  if (!await fileExists(packageJsonPath)) {
    throw new Error(`Missing package.json: ${workspaceDir}`);
  }

  const pkg = await readJson(packageJsonPath);
  if (!isObject(pkg.scripts) || typeof pkg.scripts.build !== 'string' || pkg.scripts.build.trim() === '') {
    throw new Error(`Workspace ${pkg.name ?? workspaceDir} must define a build script`);
  }

  if (!isObject(pkg.tx5drPlugin)) {
    throw new Error(`Workspace ${pkg.name ?? workspaceDir} must define tx5drPlugin metadata`);
  }

  const meta = pkg.tx5drPlugin;
  for (const key of ['pluginName', 'title', 'description', 'minPluginApiVersion', 'entry']) {
    if (typeof meta[key] !== 'string' || meta[key].trim() === '') {
      throw new Error(`Workspace ${pkg.name ?? workspaceDir} is missing tx5drPlugin.${key}`);
    }
  }
  assertStrictSemver(pkg.version, `Workspace ${pkg.name ?? workspaceDir} version`);
  assertStrictSemver(
    meta.minPluginApiVersion,
    `Workspace ${pkg.name ?? workspaceDir} tx5drPlugin.minPluginApiVersion`,
  );
  await validatePluginApiDeclaration(workspaceDir, pkg);
  validateVersionNotRepublished(workspaceDir, pkg, registry.get(meta.pluginName));

  if (!Array.isArray(meta.include) || meta.include.length === 0) {
    throw new Error(`Workspace ${pkg.name ?? workspaceDir} must define tx5drPlugin.include`);
  }

  for (const item of meta.include) {
    if (!isObject(item) || typeof item.from !== 'string' || typeof item.to !== 'string') {
      throw new Error(`Workspace ${pkg.name ?? workspaceDir} has invalid tx5drPlugin.include entry`);
    }
  }

  const readmePath = path.join(workspaceDir, 'README.md');
  if (!await fileExists(readmePath)) {
    throw new Error(`Workspace ${pkg.name ?? workspaceDir} must include README.md for marketplace details`);
  }

  const readmeStat = await fs.stat(readmePath);
  if (readmeStat.size > README_MAX_BYTES) {
    throw new Error(`Workspace ${pkg.name ?? workspaceDir} README.md exceeds ${README_MAX_BYTES} bytes`);
  }

  const srcIndexExists = await fileExists(path.join(workspaceDir, 'src', 'index.ts'))
    || await fileExists(path.join(workspaceDir, 'src', 'index.js'));
  if (!srcIndexExists) {
    throw new Error(`Workspace ${pkg.name ?? workspaceDir} must include src/index.ts or src/index.js`);
  }

  console.log(`Validated workspace: ${pkg.name} -> ${meta.pluginName}`);
}

const registry = await readRegistry();
const pluginDirs = await getPluginDirs();
const failures = [];
for (const pluginDir of pluginDirs) {
  try {
    await validateWorkspace(pluginDir);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR ${failure}`);
  throw new Error(`${failures.length} plugin(s) failed marketplace validation`);
}

console.log(`Validated ${pluginDirs.length} plugin(s).`);
