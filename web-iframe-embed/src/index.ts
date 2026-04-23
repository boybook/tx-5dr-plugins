import type { PluginContext, PluginDefinition, PluginUIRequestContext } from '@tx5dr/plugin-api';

export const WEB_IFRAME_EMBED_PLUGIN_NAME = 'web-iframe-embed';

const PANEL_DEFINITIONS = [
  {
    pageId: 'operator-webview',
    placement: 'operator',
    configKey: 'operatorCardUrl',
    titleKey: 'operatorPageTitle',
    entry: 'operator-webview.html',
    panel: { width: 'full' as const },
  },
  {
    pageId: 'automation-webview',
    placement: 'automation',
    configKey: 'automationPopoverUrl',
    titleKey: 'automationPageTitle',
    entry: 'automation-webview.html',
    panel: { slot: 'automation' as const },
  },
  {
    pageId: 'main-right-webview',
    placement: 'main-right',
    configKey: 'mainRightPaneUrl',
    titleKey: 'mainRightPageTitle',
    entry: 'main-right-webview.html',
    panel: { slot: 'main-right' as const, width: 'full' as const },
  },
  {
    pageId: 'voice-left-top-webview',
    placement: 'voice-left-top',
    configKey: 'voiceLeftTopUrl',
    titleKey: 'voiceLeftTopPageTitle',
    entry: 'voice-left-top-webview.html',
    panel: { slot: 'voice-left-top' as const, width: 'full' as const },
  },
  {
    pageId: 'voice-right-top-webview',
    placement: 'voice-right-top',
    configKey: 'voiceRightTopUrl',
    titleKey: 'voiceRightTopPageTitle',
    entry: 'voice-right-top-webview.html',
    panel: { slot: 'voice-right-top' as const, width: 'full' as const },
  },
] as const;

type Placement = typeof PANEL_DEFINITIONS[number]['placement'];
type ConfigKey = typeof PANEL_DEFINITIONS[number]['configKey'];
type PageId = typeof PANEL_DEFINITIONS[number]['pageId'];

interface PageConfigResponse {
  pageId: PageId;
  placement: Placement;
  url: string;
}

function requireOperatorTarget(requestContext: PluginUIRequestContext): string {
  if (requestContext.instanceTarget.kind !== 'operator') {
    throw new Error('This page requires an operator-scoped plugin instance');
  }
  return requestContext.instanceTarget.operatorId;
}

function getPanelDefinition(pageId: string) {
  const panel = PANEL_DEFINITIONS.find((entry) => entry.pageId === pageId);
  if (!panel) {
    throw new Error(`Unknown page id: ${pageId}`);
  }
  return panel;
}

function getConfiguredUrl(ctx: { config: Record<string, unknown> }, key: ConfigKey): string {
  const value = ctx.config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function buildPageConfig(ctx: PluginContext, pageId: string): PageConfigResponse {
  const panel = getPanelDefinition(pageId);
  return {
    pageId: panel.pageId,
    placement: panel.placement,
    url: getConfiguredUrl(ctx, panel.configKey),
  };
}

function syncPanelMeta(ctx: PluginContext) {
  for (const panel of PANEL_DEFINITIONS) {
    const url = getConfiguredUrl(ctx, panel.configKey);
    ctx.ui.setPanelMeta(panel.pageId, {
      visible: url.length > 0,
      title: '',
    });
  }
}

function pushConfigUpdated(ctx: PluginContext, pageId: string): void {
  const nextConfig = buildPageConfig(ctx, pageId);
  const sessions = ctx.ui.listActivePageSessions(pageId);
  ctx.log.debug('Pushing web iframe config update', {
    pageId,
    placement: nextConfig.placement,
    sessionCount: sessions.length,
    hasUrl: nextConfig.url.length > 0,
  });
  for (const session of sessions) {
    ctx.ui.pushToSession(session.sessionId, 'configUpdated', nextConfig);
  }
}

function notifyConfigUpdated(ctx: PluginContext): void {
  for (const panel of PANEL_DEFINITIONS) {
    pushConfigUpdated(ctx, panel.pageId);
  }
}

const plugin: PluginDefinition = {
  name: WEB_IFRAME_EMBED_PLUGIN_NAME,
  version: '1.1.2',
  type: 'utility',
  description: 'pluginDescription',

  settings: {
    globalLayoutGuide: {
      type: 'info',
      default: '',
      label: 'globalLayoutGuideLabel',
      description: 'globalLayoutGuideDescription',
      scope: 'global',
    },
    embedNotice: {
      type: 'info',
      default: '',
      label: 'embedNoticeLabel',
      description: 'embedNoticeDescription',
      scope: 'global',
    },
    operatorLayoutGuide: {
      type: 'info',
      default: '',
      label: 'operatorLayoutGuideLabel',
      description: 'operatorLayoutGuideDescription',
      scope: 'operator',
    },
    operatorCardUrl: {
      type: 'string',
      default: '',
      label: 'operatorCardUrlLabel',
      description: 'operatorCardUrlDescription',
      scope: 'operator',
    },
    automationPopoverUrl: {
      type: 'string',
      default: '',
      label: 'automationPopoverUrlLabel',
      description: 'automationPopoverUrlDescription',
      scope: 'global',
    },
    mainRightPaneUrl: {
      type: 'string',
      default: '',
      label: 'mainRightPaneUrlLabel',
      description: 'mainRightPaneUrlDescription',
      scope: 'global',
    },
    voiceLeftTopUrl: {
      type: 'string',
      default: '',
      label: 'voiceLeftTopUrlLabel',
      description: 'voiceLeftTopUrlDescription',
      scope: 'global',
    },
    voiceRightTopUrl: {
      type: 'string',
      default: '',
      label: 'voiceRightTopUrlLabel',
      description: 'voiceRightTopUrlDescription',
      scope: 'global',
    },
  },

  panels: PANEL_DEFINITIONS.map((panel) => ({
    id: panel.pageId,
    title: '',
    component: 'iframe' as const,
    pageId: panel.pageId,
    ...panel.panel,
  })),

  ui: {
    dir: 'ui',
    pages: PANEL_DEFINITIONS.map((panel) => ({
      id: panel.pageId,
      title: panel.titleKey,
      entry: panel.entry,
      accessScope: 'operator' as const,
      resourceBinding: 'operator' as const,
    })),
  },

  async onLoad(ctx) {
    syncPanelMeta(ctx);

    ctx.ui.registerPageHandler({
      async onMessage(pageId, action, _data, requestContext) {
        switch (action) {
          case 'getConfig': {
            const operatorId = requireOperatorTarget(requestContext);
            const response = buildPageConfig(ctx, pageId);

            ctx.log.debug('Resolved panel embed config', {
              operatorId,
              pageId,
              placement: response.placement,
              hasUrl: response.url.length > 0,
            });

            return response;
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      },
    });
  },

  hooks: {
    onConfigChange(_changes, ctx) {
      syncPanelMeta(ctx);
      notifyConfigUpdated(ctx);
    },
  },
};

export default plugin;
