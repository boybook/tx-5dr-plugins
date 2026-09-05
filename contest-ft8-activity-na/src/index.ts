import type { AnyPluginDefinition } from '@tx5dr/plugin-api';
import { ftContestCatalog } from '@tx5dr/ft8-contest-family-shared/ft-contests';

const entry = ftContestCatalog.find((candidate) => candidate.name === 'ft8-activity-na');
if (!entry) throw new Error('Missing contest catalog entry: ft8-activity-na');

export const plugin: AnyPluginDefinition = { ...entry.definition, name: 'contest-ft8-activity-na' };
export const locales = entry.locales;

export default plugin;
