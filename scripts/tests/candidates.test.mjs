import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyCandidate } from '../lib/candidates.mjs';
import { rootDir } from '../lib/market.mjs';

async function fixture() {
  const archives = await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-candidates-'));
  const stage = path.join(archives, 'stage');
  await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, 'tx5dr-plugin.json'), JSON.stringify({
    schemaVersion: 1, name: 'demo', version: '1.0.0', minPluginApiVersion: '2.6.0', permissions: ['network:fetch'],
  }));
  await fs.mkdir(path.join(archives, 'demo'));
  const zip = path.join(archives, 'demo', '1.0.0.zip');
  execFileSync('zip', ['-q', zip, 'tx5dr-plugin.json'], { cwd: stage });
  const bytes = await fs.readFile(zip);
  const candidate = {
    name: 'demo',
    archive: path.relative(rootDir, zip),
    version: {
      version: '1.0.0',
      minPluginApiVersion: '2.6.0',
      permissions: ['network:fetch'],
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    },
  };
  return { archives, candidate };
}

test('accepts a candidate whose archive matches its metadata', async () => {
  const { archives, candidate } = await fixture();
  assert.equal(await verifyCandidate(candidate, archives), path.join(archives, 'demo', '1.0.0.zip'));
});

test('rejects archive paths outside the expected location', async () => {
  const { archives, candidate } = await fixture();
  await assert.rejects(verifyCandidate({ ...candidate, archive: '../../.ossutilconfig' }, archives), /outside the expected/);
  await assert.rejects(verifyCandidate({ ...candidate, name: '../demo' }, archives), /Invalid candidate plugin name/);
});

test('rejects tampered hashes and manifests', async () => {
  const { archives, candidate } = await fixture();
  await assert.rejects(verifyCandidate({ ...candidate, version: { ...candidate.version, sha256: 'b'.repeat(64) } }, archives), /hash or size/);
  await assert.rejects(verifyCandidate({ ...candidate, version: { ...candidate.version, permissions: [] } }, archives), /archive manifest/);
  await assert.rejects(verifyCandidate({ ...candidate, version: { ...candidate.version, minPluginApiVersion: '2.0.0' } }, archives), /archive manifest/);
});
