import { ftContestCatalog } from '@tx5dr/ft8-contest-family-shared/ft-contests';

const entry = ftContestCatalog.find((candidate) => candidate.name === 'africa-ft4-dx');
if (!entry) throw new Error('Missing contest catalog entry: africa-ft4-dx');

export const plugin = { ...entry.definition, name: 'contest-africa-ft4-dx' };
export const locales = entry.locales;

export default plugin;
