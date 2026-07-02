#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

const PLUGIN_NAME = 'operator-live-chat';
const unlinkMode = process.argv.includes('--unlink');

function getPluginsDir() {
  if (process.env.TX5DR_PLUGINS_DIR) {
    return process.env.TX5DR_PLUGINS_DIR;
  }

  const dataDir = process.env.TX5DR_DATA_DIR;
  if (dataDir) {
    return join(dataDir, 'plugins');
  }

  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'TX-5DR', 'plugins');
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'TX-5DR', 'plugins');
    default:
      return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'TX-5DR', 'plugins');
  }
}

const pluginsDir = getPluginsDir();
const target = resolve('dist');
const linkPath = join(pluginsDir, PLUGIN_NAME);

if (unlinkMode) {
  if (existsSync(linkPath)) {
    unlinkSync(linkPath);
    console.log(`Unlinked: ${linkPath}`);
  } else {
    console.log(`No link found at: ${linkPath}`);
  }
  process.exit(0);
}

if (!existsSync(target)) {
  console.error('Error: dist/ not found. Run "npm run build" first.');
  process.exit(1);
}

if (existsSync(linkPath)) {
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      console.log(`Already linked: ${linkPath} -> ${target}`);
      process.exit(0);
    }
  } catch {
    // fall through
  }

  console.error(`Error: ${linkPath} already exists and is not a symlink.`);
  process.exit(1);
}

mkdirSync(pluginsDir, { recursive: true });
symlinkSync(target, linkPath, 'junction');

const hotreloadPath = join(target, '.hotreload');
if (!existsSync(hotreloadPath)) {
  writeFileSync(hotreloadPath, '', 'utf8');
}

console.log(`Linked: ${linkPath} -> ${target}`);
console.log('Created .hotreload marker for dev auto-reload.');
