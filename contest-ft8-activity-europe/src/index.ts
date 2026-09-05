import { ftContestCatalog } from '@tx5dr/ft8-contest-family-shared/ft-contests';

const entry = ftContestCatalog.find((candidate) => candidate.name === 'ft8-activity-europe');
if (!entry) throw new Error('Missing contest catalog entry: ft8-activity-europe');

export const plugin = { ...entry.definition, name: 'contest-ft8-activity-europe' };
export const locales = entry.locales;

export default plugin;
