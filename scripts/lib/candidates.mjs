// The publish job holds OSS and repository write credentials, while candidates
// come from the build job that ran third-party plugin code. Nothing in a
// candidate is trusted until it is checked against the archive bytes here.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { artifactsRoot, assertStrictSemver, rootDir } from './market.mjs';

const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function sameList(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/** Throws unless the candidate's archive exists where expected and matches its metadata. */
export async function verifyCandidate(candidate, archivesDir = path.join(artifactsRoot, 'artifacts')) {
  const name = candidate?.name;
  const version = candidate?.version?.version;
  if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) throw new Error(`Invalid candidate plugin name: ${String(name)}`);
  assertStrictSemver(version, `Candidate ${name} version`);
  if (version.includes('+')) throw new Error(`Candidate ${name} version must not carry build metadata`);

  const expected = path.join(archivesDir, name, `${version}.zip`);
  if (path.resolve(rootDir, String(candidate.archive)) !== expected) {
    throw new Error(`Candidate ${name}@${version} archive path is outside the expected location`);
  }
  const stat = await fs.lstat(expected);
  if (!stat.isFile()) throw new Error(`Candidate ${name}@${version} archive is not a regular file`);

  const bytes = await fs.readFile(expected);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== candidate.version.sha256 || bytes.length !== candidate.version.size) {
    throw new Error(`Candidate ${name}@${version} hash or size does not match its archive`);
  }

  let manifest;
  try {
    manifest = JSON.parse(execFileSync('unzip', ['-p', expected, 'tx5dr-plugin.json'], { encoding: 'utf8' }));
  } catch {
    throw new Error(`Candidate ${name}@${version} archive has no readable tx5dr-plugin.json`);
  }
  if (manifest.name !== name || manifest.version !== version
      || manifest.minPluginApiVersion !== candidate.version.minPluginApiVersion
      || !sameList(manifest.permissions ?? [], candidate.version.permissions ?? [])) {
    throw new Error(`Candidate ${name}@${version} metadata does not match its archive manifest`);
  }
  return expected;
}
