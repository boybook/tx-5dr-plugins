#!/usr/bin/env node

/**
 * Publishes marketplace versions from `.artifacts/market/candidates.json`.
 *
 *   node scripts/publish-market.mjs --dry-run
 *       Merge candidates into an in-memory registry and write the index files
 *       to `.artifacts/market/site`. Nothing is uploaded or written to registry/.
 *   node scripts/publish-market.mjs artifacts --upload
 *       Upload each new version's immutable archive and append it to registry/.
 *       CI commits registry/ before the index phase.
 *   node scripts/publish-market.mjs index --upload
 *       Rebuild index files from the committed registry/ and upload them.
 *
 * Published archives live at `artifacts/<plugin>/<version>.zip` and are never
 * overwritten. A version stays in the registry forever; withdraw a bad one by
 * setting `"yanked": true` (and `"yankedReason"`) in its registry entry.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  artifactsRoot,
  DEFAULT_BASE_URL,
  git,
  readJson,
  readRegistry,
  registryPath,
  rootDir,
  writeJson,
} from './lib/market.mjs';
import { buildIndex, buildLegacyCatalog, mergeCandidates } from './lib/catalog.mjs';
import { verifyCandidate } from './lib/candidates.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 || index === args.length - 1 ? fallback : args[index + 1];
};

const dryRun = flag('--dry-run');
const upload = flag('--upload');
const phase = dryRun ? 'dry-run' : args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--base-url');
const baseUrl = option('--base-url', DEFAULT_BASE_URL).replace(/\/+$/, '');
const bucket = process.env.OSS_BUCKET || 'tx5dr';
const objectPrefix = (process.env.OSS_OBJECT_PREFIX || 'plugins/market').replace(/^\/+|\/+$/g, '');
const siteDir = path.join(artifactsRoot, 'site');

if (!['dry-run', 'artifacts', 'index'].includes(phase)) {
  throw new Error('Usage: publish-market.mjs --dry-run | artifacts --upload | index --upload');
}
if (!dryRun && !upload) {
  throw new Error(`The ${phase} phase publishes; pass --upload, or use --dry-run`);
}

function oss(...ossArgs) {
  return execFileSync('ossutil', ossArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function objectUrl(key) {
  return `oss://${bucket}/${objectPrefix}/${key}`;
}

function objectExists(key) {
  try {
    oss('stat', objectUrl(key));
    return true;
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (/StatusCode=404|NoSuchKey|not exist/i.test(output)) return false;
    throw new Error(`Cannot inspect ${objectUrl(key)}: ${output.trim() || error.message}`);
  }
}

async function remoteSha256(key) {
  const tempDir = await fs.mkdtemp(path.join(artifactsRoot, 'verify-'));
  try {
    const local = path.join(tempDir, 'object');
    oss('cp', objectUrl(key), local);
    return createHash('sha256').update(await fs.readFile(local)).digest('hex');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** Uploads an archive once; an existing object must hold identical bytes. */
async function uploadImmutable(key, file, sha256) {
  if (objectExists(key)) {
    const existing = await remoteSha256(key);
    if (existing !== sha256) {
      throw new Error(`Immutable archive conflict at ${key}: published bytes differ; bump the plugin version`);
    }
    console.log(`Archive already published with identical bytes: ${key}`);
    return;
  }
  oss('cp', file, objectUrl(key));
  if (await remoteSha256(key) !== sha256) {
    throw new Error(`Uploaded archive verification failed: ${key}`);
  }
  console.log(`Uploaded ${key}`);
}

function assertPublishableCheckout(candidateCommit) {
  const head = git(['rev-parse', 'HEAD']);
  if (candidateCommit !== head) {
    throw new Error(`Candidates were packaged from ${candidateCommit}, but HEAD is ${head}; repackage first`);
  }
  if (git(['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error('Refusing to publish from a working tree with uncommitted changes');
  }
}

async function writeSite(records) {
  const generatedAt = new Date().toISOString();
  await fs.rm(siteDir, { recursive: true, force: true });
  await writeJson(path.join(siteDir, 'index.json'), buildIndex(records, generatedAt));
  for (const channel of ['nightly', 'stable']) {
    await writeJson(path.join(siteDir, channel, 'index.json'), buildLegacyCatalog(records, channel, generatedAt));
  }
  return ['index.json', 'nightly/index.json', 'stable/index.json'];
}

const records = await readRegistry();

if (phase === 'index') {
  const files = await writeSite(records);
  for (const file of files) {
    oss('cp', path.join(siteDir, file), objectUrl(file), '--force');
    console.log(`Uploaded ${file}`);
  }
  console.log(`Published marketplace index for ${records.size} plugin(s)`);
} else {
  const { sourceCommit, candidates } = await readJson(path.join(artifactsRoot, 'candidates.json'));
  if (upload) assertPublishableCheckout(sourceCommit);
  const archives = new Map();
  for (const candidate of candidates) archives.set(candidate, await verifyCandidate(candidate));
  const additions = mergeCandidates(records, candidates, sourceCommit, baseUrl);

  if (phase === 'artifacts') {
    for (const { candidate, key } of additions) {
      await uploadImmutable(key, archives.get(candidate), candidate.version.sha256);
    }
    for (const record of records.values()) {
      await writeJson(registryPath(record.name), record);
    }
  } else {
    await writeSite(records);
    console.log(`Dry run wrote index files to ${path.relative(rootDir, siteDir)}`);
  }

  console.log(additions.length === 0
    ? 'No new plugin versions'
    : `New versions: ${additions.map(({ candidate }) => `${candidate.name}@${candidate.version.version}`).join(', ')}`);
}
