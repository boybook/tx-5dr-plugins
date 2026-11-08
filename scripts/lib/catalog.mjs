// Pure registry and index transformations shared by publication and tests.

import {
  compareSemver,
  isPluginApiCompatible,
  LEGACY_HOST_PLUGIN_API,
  sortVersionsDescending,
} from './market.mjs';

export function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/** Merges candidates into registry records; returns new versions to upload. */
export function mergeCandidates(records, candidates, sourceCommit, baseUrl, now = new Date()) {
  const additions = [];
  for (const candidate of candidates) {
    const record = records.get(candidate.name) ?? { name: candidate.name, meta: {}, versions: [] };
    record.meta = withoutUndefined(candidate.meta);
    const published = record.versions.find((entry) => entry.version === candidate.version.version);
    if (published) {
      // validate-marketplace.mjs rejects source changes without a version bump,
      // so a differing hash here only reflects a non-reproducible build.
      if (published.sha256 !== candidate.version.sha256) {
        console.log(`Keeping published bytes for ${candidate.name}@${published.version}; rebuilt archive differs`);
      }
    } else {
      const key = `artifacts/${candidate.name}/${candidate.version.version}.zip`;
      record.versions.push({
        ...candidate.version,
        artifactUrl: `${baseUrl}/${key}`,
        publishedAt: now.toISOString(),
        sourceCommit,
      });
      additions.push({ candidate, key });
    }
    record.versions = sortVersionsDescending(record.versions);
    records.set(candidate.name, record);
  }
  return additions;
}

function toIndexVersion(entry) {
  const { sourceCommit: _sourceCommit, ...version } = entry;
  return withoutUndefined({ ...version, yanked: version.yanked === true ? true : undefined });
}

/** Channel-free index read by Hosts that resolve versions by Plugin API (schema v3). */
export function buildIndex(records, generatedAt) {
  return {
    schemaVersion: 3,
    generatedAt,
    plugins: [...records.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((record) => ({
        name: record.name,
        ...record.meta,
        versions: record.versions.map(toIndexVersion),
      })),
  };
}

/**
 * Older Hosts (Plugin API <= LEGACY_HOST_PLUGIN_API) read one version per
 * plugin from `<channel>/index.json`, parse the whole file with their own
 * schema, and only check `minPluginApiVersion <= bundled`. Offer the newest
 * version they can run. A plugin with no such version is left out: listing a
 * newer one could carry permissions their schema does not know and make the
 * whole catalog unreadable for them.
 */
export function selectLegacyVersion(versions) {
  const candidates = sortVersionsDescending(versions.filter((entry) => !entry.yanked));
  return candidates.find((entry) => isPluginApiCompatible(entry.minPluginApiVersion, LEGACY_HOST_PLUGIN_API))
    ?? candidates.find((entry) => compareSemver(entry.minPluginApiVersion, LEGACY_HOST_PLUGIN_API) <= 0);
}

export function buildLegacyCatalog(records, channel, generatedAt) {
  const plugins = [];
  for (const record of [...records.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const selected = selectLegacyVersion(record.versions);
    if (!selected) continue;
    plugins.push(withoutUndefined({
      name: record.name,
      ...record.meta,
      latestVersion: selected.version,
      minPluginApiVersion: selected.minPluginApiVersion,
      permissions: selected.permissions ?? [],
      artifactUrl: selected.artifactUrl,
      sha256: selected.sha256,
      size: selected.size,
      publishedAt: selected.publishedAt,
      artifactManifestVersion: 1,
    }));
  }
  return { schemaVersion: 2, generatedAt, channel, plugins };
}

