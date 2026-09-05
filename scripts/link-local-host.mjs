import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const hostRoot = resolve(process.env.TX5DR_HOST_ROOT ?? join(root, '..', 'tx-5dr'));
const hostPackages = join(hostRoot, 'packages');
const hostNodeModules = join(hostRoot, 'node_modules');
const sharedPackage = join(root, 'shared', 'ft8-contest-family');
const pluginDirs = ['contest-arrl-digital', 'contest-ft-roundup', 'contest-ft-challenge', 'contest-european-ft8-dx', 'contest-european-ft4-dx', 'contest-rsgb-ft4-international-activity-day', 'contest-rsgb-ft4-contest-series', 'contest-ft8-activity-europe', 'contest-ft8-activity-na', 'contest-nccc-ft4-sprint', 'contest-batavia-ft8', 'contest-ybdxpi-ft8', 'contest-africa-ft4-dx', 'contest-ww-digi'];

function link(source, target) {
  mkdirSync(join(target, '..'), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  symlinkSync(source, target, 'junction');
}

function linkDependencies(directory) {
  link(join(hostPackages, 'plugin-api'), join(directory, 'node_modules/@tx5dr/plugin-api'));
  link(join(hostPackages, 'contracts'), join(directory, 'node_modules/@tx5dr/contracts'));
  link(sharedPackage, join(directory, 'node_modules/@tx5dr/ft8-contest-family-shared'));
  link(join(hostNodeModules, 'esbuild'), join(directory, 'node_modules/esbuild'));
  link(join(hostNodeModules, 'typescript'), join(directory, 'node_modules/typescript'));
  link(join(hostNodeModules, '@types/node'), join(directory, 'node_modules/@types/node'));
  link(join(hostNodeModules, 'vitest'), join(directory, 'node_modules/vitest'));
  link(join(hostNodeModules, '.bin/vitest'), join(directory, 'node_modules/.bin/vitest'));
  link(join(hostNodeModules, '.bin/esbuild'), join(directory, 'node_modules/.bin/esbuild'));
  link(join(hostNodeModules, '.bin/tsc'), join(directory, 'node_modules/.bin/tsc'));
}

if (!existsSync(join(hostPackages, 'plugin-api'))) throw new Error(`Host plugin-api package is unavailable: ${hostPackages}`);
if (!existsSync(sharedPackage)) throw new Error(`Shared contest package is unavailable: ${sharedPackage}`);
for (const name of pluginDirs) linkDependencies(join(root, name));
linkDependencies(sharedPackage);
console.log(`Linked local Host Plugin API from ${hostRoot} into ${pluginDirs.length} Marketplace plugin(s).`);
