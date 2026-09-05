import { ftContestCatalog } from '@tx5dr/ft8-contest-family-shared/ft-contests';

const entry = ftContestCatalog.find((candidate) => candidate.name === 'european-ft4-dx');
if (!entry) throw new Error('Missing contest catalog entry: european-ft4-dx');

export const plugin = { ...entry.definition, name: 'contest-european-ft4-dx' };
export const locales = entry.locales;

export default plugin;
