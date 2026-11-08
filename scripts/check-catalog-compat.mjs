#!/usr/bin/env node

// Parses generated catalogs with the schemas released Hosts actually ship, so a
// generated file can never make a Host's marketplace unreadable.
//   node scripts/check-catalog-compat.mjs [site-dir]

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { artifactsRoot, readJson } from './lib/market.mjs';

// Released Hosts that read `<channel>/index.json`, by bundled contracts version.
const LEGACY_HOST_CONTRACTS = { 'v1.0.0': '2.5.0', 'v1.0.1': '2.6.0' };
// Hosts that read `index.json` (schema v3) ship contracts 2.7.0 or newer.
const INDEX_HOST_CONTRACTS = '^2.7.0';

const siteDir = path.resolve(process.argv[2] ?? path.join(artifactsRoot, 'site'));
const installDir = path.join(artifactsRoot, 'compat-schemas');

function install(alias, spec) {
  try {
    execFileSync('npm', ['install', '--prefix', installDir, '--no-save', '--no-fund', '--no-audit', '--loglevel', 'error',
      `${alias}@npm:@tx5dr/contracts@${spec}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    return createRequire(path.join(installDir, 'package.json'))(alias);
  } catch (error) {
    if (/ETARGET|No matching version/i.test(String(error.stderr ?? ''))) return undefined;
    throw error;
  }
}

await fs.mkdir(installDir, { recursive: true });
let failures = 0;
const check = (label, schema, value) => {
  const result = schema.safeParse(value);
  if (result.success) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}: ${JSON.stringify(result.error.issues.slice(0, 3))}`);
  }
};

for (const [host, version] of Object.entries(LEGACY_HOST_CONTRACTS)) {
  const contracts = install(`contracts-${version.replaceAll('.', '-')}`, version);
  if (!contracts) throw new Error(`@tx5dr/contracts@${version} is not available`);
  for (const channel of ['nightly', 'stable']) {
    const catalog = await readJson(path.join(siteDir, channel, 'index.json'));
    check(`${channel}/index.json with Host ${host} (contracts ${version})`, contracts.PluginMarketCatalogSchema, catalog);
    if (catalog.channel !== channel) {
      failures += 1;
      console.error(`FAIL ${channel}/index.json declares channel ${catalog.channel}`);
    }
  }
}

const current = install('contracts-index', INDEX_HOST_CONTRACTS);
if (current?.PluginMarketIndexSchema) {
  check(`index.json with contracts ${INDEX_HOST_CONTRACTS}`, current.PluginMarketIndexSchema, await readJson(path.join(siteDir, 'index.json')));
} else {
  console.warn(`SKIP index.json: @tx5dr/contracts ${INDEX_HOST_CONTRACTS} is not published yet`);
}

if (failures > 0) throw new Error(`${failures} catalog compatibility check(s) failed`);
