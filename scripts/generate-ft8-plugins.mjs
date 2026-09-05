import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const plugins = [
  ['contest-arrl-digital', 'ARRL International Digital Contest', 'arrl-digital'],
  ['contest-ft-roundup', 'FT Roundup', 'ft-roundup'],
  ['contest-ft-challenge', 'FT Challenge', 'ft-challenge'],
  ['contest-european-ft8-dx', 'European FT8 DX Contest', 'european-ft8-dx'],
  ['contest-european-ft4-dx', 'European FT4 DX Contest', 'european-ft4-dx'],
  ['contest-rsgb-ft4-international-activity-day', 'RSGB FT4 International Activity Day', 'rsgb-ft4-international-activity-day'],
  ['contest-rsgb-ft4-contest-series', 'RSGB FT4 Contest Series', 'rsgb-ft4-contest-series'],
  ['contest-ft8-activity-europe', 'VHF-UHF FT8 Activity Europe', 'ft8-activity-europe'],
  ['contest-ft8-activity-na', 'VHF-UHF FT8 Activity-NA', 'ft8-activity-na'],
  ['contest-nccc-ft4-sprint', 'NCCC FT4 Sprint', 'nccc-ft4-sprint'],
  ['contest-batavia-ft8', 'Batavia FT8 Contest', 'batavia-ft8'],
  ['contest-ybdxpi-ft8', 'YBDXPI FT8 Contest', 'ybdxpi-ft8'],
  ['contest-africa-ft4-dx', 'Africa FT4 DX Contest', 'africa-ft4-dx'],
  ['contest-ww-digi', 'WW Digi', 'ww-digi'],
];

const root = process.cwd();
for (const [name, title, catalogName] of plugins) {
  const dir = join(root, name);
  const isWw = catalogName === 'ww-digi';
  const importPath = isWw
    ? '@tx5dr/ft8-contest-family-shared/ww-digi'
    : '@tx5dr/ft8-contest-family-shared/ft-contests';
  const source = isWw
    ? `import { wwDigiStrategyPlugin, wwDigiLocales } from '${importPath}';\n\nexport const plugin = { ...wwDigiStrategyPlugin, name: '${name}' };\nexport const locales = wwDigiLocales;\n\nexport default plugin;\n`
    : `import { ftContestCatalog } from '${importPath}';\n\nconst entry = ftContestCatalog.find((candidate) => candidate.name === '${catalogName}');\nif (!entry) throw new Error('Missing contest catalog entry: ${catalogName}');\n\nexport const plugin = { ...entry.definition, name: '${name}' };\nexport const locales = entry.locales;\n\nexport default plugin;\n`;
  const packageJson = {
    name: `tx5dr-plugin-${name}`,
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'dist/index.mjs',
    types: 'dist/index.d.ts',
    scripts: {
      build: 'tsc --emitDeclarationOnly && esbuild src/index.ts --bundle --platform=node --format=esm --target=node20 --legal-comments=none --outfile=dist/index.mjs && node ../scripts/copy-contest-ui.mjs',
    },
    tx5drPlugin: {
      pluginName: name,
      title,
      description: `${title} strategy for TX-5DR.`,
      minPluginApiVersion: '2.5.0',
      author: 'TX-5DR',
      license: 'GPL-3.0-only',
      repository: 'https://github.com/boybook/tx-5dr-plugins',
      homepage: `https://tx5dr.com/plugins/${name}`,
      categories: ['contest', 'ft8', 'ft4'],
      keywords: ['amateur-radio', 'contest', name],
      entry: 'dist/index.mjs',
      include: [
        { from: 'dist/index.mjs', to: 'index.mjs' },
        { from: 'dist/ui', to: 'ui' },
        { from: 'dist/locales', to: 'locales' },
        { from: 'README.md', to: 'README.md' },
      ],
    },
    dependencies: {
      '@tx5dr/ft8-contest-family-shared': 'file:../shared/ft8-contest-family',
      '@tx5dr/plugin-api': '^2.5.0',
    },
    devDependencies: {
      '@types/node': '^22.0.0',
      esbuild: '^0.25.0',
      typescript: '^5.0.0',
    },
  };
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      declaration: true,
      declarationMap: true,
      emitDeclarationOnly: true,
      resolveJsonModule: true,
      outDir: 'dist',
      skipLibCheck: true,
    },
    include: ['src'],
  };
  const locales = {
    en: { pluginName: title, pluginDescription: `${title} strategy for TX-5DR.`, contestLogTitle: 'Contest log', contestNewCallsign: 'New on band', contestNewMultiplier: 'New multiplier' },
    zh: { pluginName: title, pluginDescription: `TX-5DR ${title} 比赛策略。`, contestLogTitle: '比赛日志', contestNewCallsign: '本波段新台', contestNewMultiplier: '新系数' },
    ja: { pluginName: title, pluginDescription: `TX-5DR ${title} コンテスト戦略。`, contestLogTitle: 'コンテストログ', contestNewCallsign: 'このバンドで未交信', contestNewMultiplier: '新マルチ' },
  };
  mkdirSync(join(dir, 'src/locales'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);
  writeFileSync(join(dir, 'src/index.ts'), source);
  for (const [locale, values] of Object.entries(locales)) writeFileSync(join(dir, 'src/locales', `${locale}.json`), `${JSON.stringify(values, null, 2)}\n`);
  writeFileSync(join(dir, 'README.md'), `# ${title}\n\nOfficial TX-5DR Marketplace strategy plugin for the ${title}.\n\nThis artifact uses the shared FT8/FT4 contest session, logbook UI, standard QSO runtime, contest scoring projection, ADIF import/export, and official submission format.\n`);
}
console.log(`Generated ${plugins.length} FT8/FT4 Marketplace plugin package(s).`);
