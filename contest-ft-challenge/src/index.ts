import { ftContestCatalog } from '@tx5dr/ft8-contest-family-shared/ft-contests';

const entry = ftContestCatalog.find((candidate) => candidate.name === 'ft-challenge');
if (!entry) throw new Error('Missing contest catalog entry: ft-challenge');

export const plugin = { ...entry.definition, name: 'contest-ft-challenge' };
export const locales = entry.locales;

export default plugin;
