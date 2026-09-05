import type { AnyPluginDefinition } from '@tx5dr/plugin-api';
import { wwDigiStrategyPlugin, wwDigiLocales } from '@tx5dr/ft8-contest-family-shared/ww-digi';

export const plugin: AnyPluginDefinition = { ...wwDigiStrategyPlugin, name: 'contest-ww-digi' };
export const locales = wwDigiLocales;

export default plugin;
