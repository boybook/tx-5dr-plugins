import { ftContestCatalog } from '@tx5dr/ft8-contest-family-shared/ft-contests';

const entry = ftContestCatalog.find((candidate) => candidate.name === 'ybdxpi-ft8');
if (!entry) throw new Error('Missing contest catalog entry: ybdxpi-ft8');

export const plugin = entry.definition;
export const locales = entry.locales;

export default plugin;
