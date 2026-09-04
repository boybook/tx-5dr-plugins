import { ftContestCatalog } from '@tx5dr/ft8-contest-family-shared/ft-contests';

const entry = ftContestCatalog.find((candidate) => candidate.name === 'rsgb-ft4-contest-series');
if (!entry) throw new Error('Missing contest catalog entry: rsgb-ft4-contest-series');

export const plugin = entry.definition;
export const locales = entry.locales;

export default plugin;
