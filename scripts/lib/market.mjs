// Shared helpers for marketplace validation, packaging and publication.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const rootDir = process.cwd();
export const registryDir = path.join(rootDir, 'registry');
export const artifactsRoot = path.join(rootDir, '.artifacts', 'market');
export const DEFAULT_BASE_URL = 'https://dl.tx5dr.com/plugins/market';

/**
 * Newest Host Plugin API that still reads the legacy channel catalogs
 * (`nightly/index.json`, `stable/index.json`, schema v2). Hosts after it read
 * the channel-free `index.json` (schema v3). Do not raise this value.
 */
export const LEGACY_HOST_PLUGIN_API = '2.6.0';

const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertStrictSemver(value, label) {
  if (typeof value !== 'string' || !STRICT_SEMVER_PATTERN.test(value)) {
    throw new Error(`${label} must be a strict semantic version`);
  }
}

function parseSemver(value) {
  const match = STRICT_SEMVER_PATTERN.exec(String(value).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

/** SemVer precedence; build metadata ignored. */
export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`Invalid semantic version comparison: ${left} vs ${right}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Mirrors the Host rule: `host` satisfies `^min` (npm caret semantics). */
export function isPluginApiCompatible(min, host) {
  const required = parseSemver(min);
  const current = parseSemver(host);
  if (!required || !current || compareSemver(host, min) < 0) return false;
  if (required.major > 0) return current.major === required.major;
  if (required.minor > 0) return current.major === 0 && current.minor === required.minor;
  return current.major === 0 && current.minor === 0 && current.patch === required.patch;
}

/** Lower bound of a `^X.Y.Z`, `~X.Y.Z`, `>=X.Y.Z` or exact `X.Y.Z` range; null otherwise. */
export function rangeFloor(range) {
  const match = /^\s*(?:\^|~|>=\s*)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(String(range ?? ''));
  return match ? match[1] : null;
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Top-level directories whose package.json declares `tx5drPlugin`. */
export async function getPluginDirs() {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const pluginDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || ['scripts', 'registry', 'shared'].includes(entry.name)) {
      continue;
    }
    const packageJsonPath = path.join(rootDir, entry.name, 'package.json');
    if (!await pathExists(packageJsonPath)) continue;
    const pkg = await readJson(packageJsonPath);
    if (!isObject(pkg.tx5drPlugin)) continue;
    pluginDirs.push(path.join(rootDir, entry.name));
  }
  if (pluginDirs.length === 0) {
    throw new Error('No plugin directories with package.json were found');
  }
  return pluginDirs.sort();
}

function allDependencies(pkg) {
  return { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies };
}

/** Local `file:` dependencies, resolved to repository-relative directories. */
export function localDependencyDirs(pluginDir, pkg) {
  return Object.values(allDependencies(pkg))
    .filter((spec) => typeof spec === 'string' && spec.startsWith('file:'))
    .map((spec) => path.relative(rootDir, path.resolve(pluginDir, spec.slice('file:'.length))));
}

/**
 * Every `@tx5dr/plugin-api` range the plugin builds against: its own and those
 * of local shared packages it bundles.
 */
export async function pluginApiRanges(pluginDir, pkg) {
  const ranges = [];
  const own = allDependencies(pkg)['@tx5dr/plugin-api'];
  if (own) ranges.push({ source: path.relative(rootDir, pluginDir), range: own });
  for (const dir of localDependencyDirs(pluginDir, pkg)) {
    const shared = await readJson(path.join(rootDir, dir, 'package.json'));
    const range = allDependencies(shared)['@tx5dr/plugin-api'];
    if (range) ranges.push({ source: dir, range });
  }
  return ranges;
}

/**
 * Paths whose changes alter a plugin's packaged artifact. README and tests do
 * not ship in the archive, so documentation edits do not need a version bump.
 */
export function pluginSourcePathspecs(pluginDir, pkg) {
  const dirs = [path.relative(rootDir, pluginDir), ...localDependencyDirs(pluginDir, pkg)];
  return [
    ...dirs,
    ...dirs.flatMap((dir) => [
      `:(exclude)${dir}/README.md`,
      `:(exclude,glob)${dir}/**/*.test.*`,
      `:(exclude,glob)${dir}/**/__tests__/**`,
    ]),
  ];
}

export function git(args) {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Whether plugin sources changed between `commit` and HEAD (working tree included). */
export function sourceChangedSince(commit, pathspecs) {
  try {
    git(['cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    throw new Error(`Registry source commit ${commit} is not available; fetch full history (fetch-depth: 0)`);
  }
  return git(['diff', '--name-only', commit, '--', ...pathspecs]) !== '';
}

export function registryPath(pluginName) {
  return path.join(registryDir, `${pluginName}.json`);
}

/**
 * Registry entries are edited by hand to yank versions, and Hosts parse the
 * generated index strictly, so a malformed field must fail here, in CI.
 */
function validateRegistryVersion(pluginName, entry) {
  const label = `registry ${pluginName}@${entry?.version}`;
  assertStrictSemver(entry.version, `${label} version`);
  assertStrictSemver(entry.minPluginApiVersion, `${label} minPluginApiVersion`);
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error(`${label} sha256 must be 64 lowercase hex characters`);
  if (!Number.isInteger(entry.size) || entry.size <= 0) throw new Error(`${label} size must be a positive integer`);
  if (typeof entry.artifactUrl !== 'string' || !entry.artifactUrl.startsWith('https://')) {
    throw new Error(`${label} artifactUrl must be an https URL`);
  }
  if (Number.isNaN(Date.parse(entry.publishedAt))) throw new Error(`${label} publishedAt must be an ISO date`);
  if (!Array.isArray(entry.permissions) || entry.permissions.some((permission) => typeof permission !== 'string')) {
    throw new Error(`${label} permissions must be an array of strings`);
  }
  if (entry.artifactManifestVersion !== 1) throw new Error(`${label} artifactManifestVersion must be 1`);
  if (!/^[a-f0-9]{40}$/.test(entry.sourceCommit ?? '')) throw new Error(`${label} sourceCommit must be a full commit SHA`);
  if (entry.yanked !== undefined && typeof entry.yanked !== 'boolean') throw new Error(`${label} yanked must be true or false`);
  if (entry.yankedReason !== undefined && typeof entry.yankedReason !== 'string') {
    throw new Error(`${label} yankedReason must be a string`);
  }
}

/** Reads every registry record keyed by plugin name. */
export async function readRegistry() {
  const records = new Map();
  if (!await pathExists(registryDir)) return records;
  for (const file of (await fs.readdir(registryDir)).filter((name) => name.endsWith('.json')).sort()) {
    const record = await readJson(path.join(registryDir, file));
    if (`${record.name}.json` !== file) {
      throw new Error(`Registry file ${file} does not match plugin name ${record.name}`);
    }
    if (!isObject(record.meta) || !Array.isArray(record.versions) || record.versions.length === 0) {
      throw new Error(`Registry ${file} must contain meta and a non-empty versions array`);
    }
    const seen = new Set();
    for (const entry of record.versions) {
      validateRegistryVersion(record.name, entry);
      if (seen.has(entry.version)) throw new Error(`Registry ${record.name} lists ${entry.version} twice`);
      seen.add(entry.version);
    }
    records.set(record.name, record);
  }
  return records;
}

export function sortVersionsDescending(versions) {
  return [...versions].sort((left, right) => compareSemver(right.version, left.version));
}
