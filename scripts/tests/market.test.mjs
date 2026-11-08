import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSemver, isPluginApiCompatible, rangeFloor } from '../lib/market.mjs';
import {
  buildIndex,
  buildLegacyCatalog,
  mergeCandidates,
  selectLegacyVersion,
} from '../lib/catalog.mjs';

const SHA = 'a'.repeat(64);

function version(value, min, extra = {}) {
  return {
    version: value,
    minPluginApiVersion: min,
    permissions: [],
    sha256: SHA,
    size: 1,
    artifactManifestVersion: 1,
    artifactUrl: `https://cdn.example.com/artifacts/demo/${value}.zip`,
    publishedAt: '2026-11-07T00:00:00.000Z',
    sourceCommit: 'c'.repeat(40),
    ...extra,
  };
}

test('caret compatibility matches the Host rule', () => {
  assert.equal(isPluginApiCompatible('2.5.0', '2.6.0'), true);
  assert.equal(isPluginApiCompatible('2.7.0', '2.6.0'), false);
  assert.equal(isPluginApiCompatible('1.7.8', '2.6.0'), false);
  assert.equal(isPluginApiCompatible('0.3.0', '0.4.0'), false);
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('2.0.0-beta.1', '2.0.0'), -1);
});

test('range floors cover supported dependency specs', () => {
  assert.equal(rangeFloor('^2.6.0'), '2.6.0');
  assert.equal(rangeFloor('~2.5.1'), '2.5.1');
  assert.equal(rangeFloor('>=2.0.0'), '2.0.0');
  assert.equal(rangeFloor('2.6.0'), '2.6.0');
  assert.equal(rangeFloor('*'), null);
  assert.equal(rangeFloor('file:../x'), null);
});

test('legacy catalogs offer the newest version an old Host can run', () => {
  const versions = [
    version('1.0.0', '1.2.0'),
    version('1.1.0', '2.5.0'),
    version('1.2.0', '2.6.0', { yanked: true }),
    version('2.0.0', '2.7.0'),
  ];
  assert.equal(selectLegacyVersion(versions).version, '1.1.0');
  // Unmigrated plugins stay installable on old Hosts that only check the floor.
  assert.equal(selectLegacyVersion([version('1.0.0', '1.2.0')]).version, '1.0.0');
  // Nothing an old Host can run: leave the plugin out of the legacy catalog.
  assert.equal(selectLegacyVersion([version('3.0.0', '2.8.0')]), undefined);
  assert.equal(selectLegacyVersion([version('1.0.0', '2.0.0', { yanked: true })]), undefined);
});

test('index builders emit v3 history and v2 legacy channels', () => {
  const records = new Map([['demo', {
    name: 'demo',
    meta: { title: 'Demo', description: 'demo', categories: [], keywords: [], screenshots: [] },
    versions: [version('1.1.0', '2.5.0'), version('1.0.0', '1.2.0', { yanked: true, yankedReason: 'broken' })],
  }]]);

  const index = buildIndex(records, 'now');
  assert.equal(index.schemaVersion, 3);
  assert.equal('channel' in index, false);
  assert.deepEqual(index.plugins[0].versions.map((entry) => entry.version), ['1.1.0', '1.0.0']);
  assert.equal('sourceCommit' in index.plugins[0].versions[0], false);
  assert.equal('yanked' in index.plugins[0].versions[0], false);
  assert.equal(index.plugins[0].versions[1].yanked, true);

  const legacy = buildLegacyCatalog(records, 'stable', 'now');
  assert.equal(legacy.schemaVersion, 2);
  assert.equal(legacy.channel, 'stable');
  assert.equal(legacy.plugins[0].latestVersion, '1.1.0');
  assert.equal(legacy.plugins[0].artifactManifestVersion, 1);
});

test('merging appends only unpublished versions and refreshes metadata', () => {
  const records = new Map([['demo', {
    name: 'demo',
    meta: { title: 'Old' },
    versions: [version('1.0.0', '2.0.0')],
  }]]);
  const candidate = (value) => ({
    name: 'demo',
    meta: { title: 'New', description: 'demo', readmeMarkdown: undefined },
    version: { version: value, minPluginApiVersion: '2.6.0', permissions: [], sha256: 'b'.repeat(64), size: 2, artifactManifestVersion: 1 },
    archive: '.artifacts/x.zip',
  });

  assert.deepEqual(mergeCandidates(records, [candidate('1.0.0')], 'd'.repeat(40), 'https://cdn.example.com'), []);
  assert.equal(records.get('demo').versions[0].sha256, SHA);

  const additions = mergeCandidates(records, [candidate('1.1.0')], 'd'.repeat(40), 'https://cdn.example.com', new Date(0));
  assert.deepEqual(additions.map((entry) => entry.key), ['artifacts/demo/1.1.0.zip']);
  const record = records.get('demo');
  assert.deepEqual(record.meta, { title: 'New', description: 'demo' });
  assert.equal(record.versions[0].version, '1.1.0');
  assert.equal(record.versions[0].artifactUrl, 'https://cdn.example.com/artifacts/demo/1.1.0.zip');
  assert.equal(record.versions[0].sourceCommit, 'd'.repeat(40));
  assert.equal(record.versions[0].publishedAt, '1970-01-01T00:00:00.000Z');
});
