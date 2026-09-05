import type { AnyPluginDefinition } from '@tx5dr/plugin-api';
import { ftContestCatalog } from '@tx5dr/ft8-contest-family-shared/ft-contests';

const entry = ftContestCatalog.find((candidate) => candidate.name === 'arrl-digital');
if (!entry) throw new Error('Missing contest catalog entry: arrl-digital');

export const plugin: AnyPluginDefinition = { ...entry.definition, name: 'contest-arrl-digital' };
export const locales = entry.locales;

export default plugin;
