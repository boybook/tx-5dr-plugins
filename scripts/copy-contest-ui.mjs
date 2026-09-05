import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(join(process.cwd(), 'package.json'));
const { standardQSOLocales } = require('@tx5dr/plugin-api/ft8');
const packageRoot = dirname(require.resolve('@tx5dr/plugin-api/contest-logbook-ui/contest-log.html'));
const target = resolve(process.cwd(), 'dist/ui');

if (!existsSync(packageRoot)) throw new Error(`Contest logbook UI package is missing: ${packageRoot}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(dirname(target), { recursive: true });
cpSync(packageRoot, target, { recursive: true });

const locales = resolve(process.cwd(), 'src/locales');
const localeTarget = resolve(process.cwd(), 'dist/locales');
const runtime = await import(pathToFileURL(resolve(process.cwd(), 'dist/index.mjs')).href);
const exportedLocales = runtime.locales ?? {};
rmSync(localeTarget, { recursive: true, force: true });
mkdirSync(localeTarget, { recursive: true });
for (const locale of ['en', 'zh', 'ja']) {
  const source = resolve(locales, `${locale}.json`);
  const overrides = existsSync(source) ? JSON.parse(readFileSync(source, 'utf8')) : {};
  const merged = {
    ...(standardQSOLocales[locale] ?? {}),
    ...(exportedLocales[locale] ?? {}),
    ...overrides,
  };
  writeFileSync(resolve(localeTarget, `${locale}.json`), `${JSON.stringify(merged, null, 2)}\n`);
}
