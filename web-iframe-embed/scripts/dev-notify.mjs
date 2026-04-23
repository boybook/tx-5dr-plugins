#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN_NAME = 'web-iframe-embed';

function getDataDir() {
  if (process.env.TX5DR_DATA_DIR) {
    return process.env.TX5DR_DATA_DIR;
  }

  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'TX-5DR');
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'TX-5DR');
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'TX-5DR');
  }
}

const runtimePluginDir = path.join(getDataDir(), 'plugins', PLUGIN_NAME);
if (!fs.existsSync(runtimePluginDir)) {
  process.exit(0);
}

const stampPath = path.join(runtimePluginDir, 'reload.stamp');
fs.writeFileSync(stampPath, `${new Date().toISOString()}\n`, 'utf8');
console.log(`[dev-notify] updated ${stampPath}`);
