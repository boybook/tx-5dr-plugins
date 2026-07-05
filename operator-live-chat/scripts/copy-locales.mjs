#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(rootDir, 'src', 'locales');
const targetDir = join(rootDir, 'dist', 'locales');

if (!existsSync(sourceDir)) {
  console.error(`Locales source directory not found: ${sourceDir}`);
  process.exit(1);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(dirname(targetDir), { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log(`Copied locales: ${sourceDir} -> ${targetDir}`);
