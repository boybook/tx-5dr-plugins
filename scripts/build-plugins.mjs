#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();

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
  return pluginDirs.sort();
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed in ${cwd}: ${command} ${args.join(' ')}`);
  }
}

async function installAndBuild(pluginDir) {
  const pkg = await readJson(path.join(pluginDir, 'package.json'));
  const hasLockfile = await fileExists(path.join(pluginDir, 'package-lock.json'));

  console.log(`\n==> Building plugin: ${pkg.name ?? path.basename(pluginDir)}`);
  if (hasLockfile) {
    run('npm', ['ci'], pluginDir);
  } else {
    run('npm', ['install', '--no-fund', '--no-audit'], pluginDir);
  }

  if (typeof pkg?.scripts?.build !== 'string' || pkg.scripts.build.trim() === '') {
    throw new Error(`Plugin ${pkg.name ?? path.basename(pluginDir)} must define scripts.build`);
  }

  run('npm', ['run', 'build'], pluginDir);
}

const pluginDirs = await getPluginDirs();
if (pluginDirs.length === 0) {
  console.log('No plugin directories found.');
  process.exit(0);
}

for (const pluginDir of pluginDirs) {
  await installAndBuild(pluginDir);
}

console.log(`Built ${pluginDirs.length} plugin(s).`);
