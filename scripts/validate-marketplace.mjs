#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function fileExists(filePath) {
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
    if (!await fileExists(packageJsonPath)) {
      continue;
    }
    pluginDirs.push(path.join(rootDir, entry.name));
  }
  if (pluginDirs.length === 0) {
    throw new Error('No plugin directories with package.json were found');
  }
  return pluginDirs.sort();
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
  for (const key of ['pluginName', 'title', 'description', 'minHostVersion', 'entry']) {
    if (typeof meta[key] !== 'string' || meta[key].trim() === '') {
      throw new Error(`Workspace ${pkg.name ?? workspaceDir} is missing tx5drPlugin.${key}`);
    }
  }

  if (!Array.isArray(meta.include) || meta.include.length === 0) {
    throw new Error(`Workspace ${pkg.name ?? workspaceDir} must define tx5drPlugin.include`);
  }

  for (const item of meta.include) {
    if (!isObject(item) || typeof item.from !== 'string' || typeof item.to !== 'string') {
      throw new Error(`Workspace ${pkg.name ?? workspaceDir} has invalid tx5drPlugin.include entry`);
    }
  }

  const srcIndexExists = await fileExists(path.join(workspaceDir, 'src', 'index.ts'))
    || await fileExists(path.join(workspaceDir, 'src', 'index.js'));
  if (!srcIndexExists) {
    throw new Error(`Workspace ${pkg.name ?? workspaceDir} must include src/index.ts or src/index.js`);
  }

  console.log(`Validated workspace: ${pkg.name} -> ${meta.pluginName}`);
}

const pluginDirs = await getPluginDirs();
for (const pluginDir of pluginDirs) {
  await validateWorkspace(pluginDir);
}

console.log(`Validated ${pluginDirs.length} plugin(s).`);
