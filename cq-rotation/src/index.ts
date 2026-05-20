import type { PluginDefinition, PluginContext } from '@tx5dr/plugin-api';
import { RotationManager } from './rotation-manager.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Support both src/ (dev) and root (deployed) layouts
function loadLocale(lang: string): Record<string, string> {
  const candidates = [
    join(__dirname, '..', 'locales', `${lang}.json`),
    join(__dirname, 'locales', `${lang}.json`),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch { /* try next */ }
  }
  return {};
}
const zhLocale = loadLocale('zh');
const enLocale = loadLocale('en');

export const CQ_ROTATION_PLUGIN_NAME = 'cq-rotation';

const managers = new Map<string, RotationManager>();

function getOrCreateManager(ctx: PluginContext): RotationManager {
  let manager = managers.get(ctx.operator.id);
  if (!manager) {
    manager = new RotationManager(ctx);
    managers.set(ctx.operator.id, manager);
  }
  return manager;
}

export const cqRotationPlugin: PluginDefinition = {
  name: CQ_ROTATION_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  description: 'pluginDescription',

  storage: { scopes: ['global'] },

  settings: {
    rotationOverview: {
      type: 'info',
      default: '',
      label: 'rotationOverview',
      description: 'rotationOverviewDesc',
      scope: 'operator',
    },
    enabled: {
      type: 'boolean',
      default: false,
      label: 'enabled',
      description: 'enabledDesc',
      scope: 'operator',
    },
    intervalSeconds: {
      type: 'number',
      default: 120,
      label: 'intervalSeconds',
      description: 'intervalSecondsDesc',
      scope: 'operator',
      min: 15,
      max: 600,
    },
    mode: {
      type: 'string',
      default: 'sequential',
      label: 'mode',
      description: 'modeDesc',
      scope: 'operator',
      options: [
        { label: 'modeSequential', value: 'sequential' },
        { label: 'modeRandom', value: 'random' },
      ],
    },
    shuffleCoverAll: {
      type: 'boolean',
      default: true,
      label: 'shuffleCoverAll',
      description: 'shuffleCoverAllDesc',
      scope: 'operator',
      visibleWhen: { setting: 'mode', equals: 'random' },
    },
  },

  quickActions: [
    { id: 'start-rotation', label: 'startRotation', icon: 'play' },
    { id: 'stop-rotation', label: 'stopRotation', icon: 'stop' },
    { id: 'skip-to-next', label: 'skipToNext', icon: 'forward-step' },
  ],

  quickSettings: [
    { settingKey: 'enabled' },
  ],

  ui: {
    dir: 'ui',
    pages: [
      {
        id: 'rotation-panel',
        title: 'rotationPanel',
        entry: 'rotation-panel.html',
        accessScope: 'operator',
        resourceBinding: 'none',
      },
    ],
  },

  panels: [
    {
      id: 'cq-rotation-panel',
      title: 'cqRotationPanel',
      component: 'iframe',
      pageId: 'rotation-panel',
      slot: 'operator',
      width: 'full',
    },
  ],

  onLoad(ctx: PluginContext) {
    const manager = getOrCreateManager(ctx);
    manager.initialize();

    ctx.ui.registerPageHandler({
      async onMessage(
        _pageId: string,
        action: string,
        data: unknown,
        requestContext,
      ) {
        const d = data as Record<string, unknown>;
        switch (action) {
          case 'getState':
            return manager.getFullState();

          case 'startRotation':
            manager.start();
            return { ok: true };

          case 'stopRotation':
            manager.stop();
            return { ok: true };

          case 'skipToNext':
            manager.skipToNext();
            return { ok: true };

          case 'shuffleOrder':
            manager.shuffleOrder();
            return { ok: true };

          case 'setOrder':
            manager.setOrder((d?.callsigns as string[]) || []);
            return { ok: true };

          case 'updateSettings':
            if (d?.intervalSeconds !== undefined) {
              await ctx.updateConfig({ intervalSeconds: d.intervalSeconds });
            }
            if (d?.mode !== undefined) {
              await ctx.updateConfig({ mode: d.mode });
            }
            return { ok: true };

          default:
            return null;
        }
      },
    });
  },

  onUnload(ctx: PluginContext) {
    const manager = managers.get(ctx.operator.id);
    if (manager) {
      manager.cleanup();
      managers.delete(ctx.operator.id);
    }
  },

  hooks: {
    onTimer(timerId: string, ctx: PluginContext) {
      const manager = managers.get(ctx.operator.id);
      if (!manager) return;

      switch (timerId) {
        case 'coordinator-heartbeat':
          manager.handleHeartbeat();
          break;
        case 'operator-check':
          manager.handleOperatorCheck();
          break;
        case 'rotation-tick':
          manager.handleRotationTick();
          break;
      }
    },

    onAutoCallCandidate(_slotInfo, _messages, ctx: PluginContext) {
      const state = ctx.store.global.get<{
        isRunning: boolean;
        operatorCallsigns: string[];
        currentIndex: number;
      }>('rotationState', { isRunning: false, operatorCallsigns: [], currentIndex: 0 });

      if (!state.isRunning) return null;

      const activeCallsign = state.operatorCallsigns[state.currentIndex];
      if (activeCallsign === ctx.operator.callsign) {
        ctx.log.debug('Suppressing autocall during active CQ rotation turn');
        return null;
      }

      return null;
    },

    onUserAction(actionId: string, _payload: unknown, ctx: PluginContext) {
      const manager = getOrCreateManager(ctx);

      switch (actionId) {
        case 'start-rotation':
          manager.start();
          break;
        case 'stop-rotation':
          manager.stop();
          break;
        case 'skip-to-next':
          manager.skipToNext();
          break;
      }
    },

    onConfigChange(changes: Record<string, unknown>, ctx: PluginContext) {
      const manager = managers.get(ctx.operator.id);
      if (!manager) return;

      if (changes.intervalSeconds !== undefined) {
        manager.updateInterval(changes.intervalSeconds as number);
      }
      if (changes.mode !== undefined) {
        manager.updateMode(changes.mode as string);
      }
      if (changes.enabled !== undefined) {
        if (changes.enabled) {
          manager.start();
        } else {
          manager.stop();
        }
      }
    },
  },
};

export default cqRotationPlugin;

export const cqRotationPluginLocales = { zh: zhLocale, en: enLocale };
