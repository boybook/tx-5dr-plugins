import { ftContestCatalog } from '@tx5dr/ft8-contest-family-shared/ft-contests';

const entry = ftContestCatalog.find((candidate) => candidate.name === 'nccc-ft4-sprint');
if (!entry) throw new Error('Missing contest catalog entry: nccc-ft4-sprint');

export const plugin = { ...entry.definition, name: 'contest-nccc-ft4-sprint' };
export const locales = entry.locales;

export default plugin;
