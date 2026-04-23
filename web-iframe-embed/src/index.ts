import type { PluginContext, PluginDefinition, PluginUIRequestContext } from '@tx5dr/plugin-api';

export const WEB_IFRAME_EMBED_PLUGIN_NAME = 'web-iframe-embed';

const OPERATOR_PAGE_ID = 'operator-webview';
const AUTOMATION_PAGE_ID = 'automation-webview';

type Placement = 'operator' | 'automation';

type ConfigKey = 'operatorCardUrl' | 'automationPopoverUrl';

interface PageConfigResponse {
  pageId: string;
  placement: Placement;
  url: string;
}

function buildPageConfig(ctx: PluginContext, pageId: string): PageConfigResponse {
  return {
    pageId,
    placement: getPlacement(pageId),
    url: getConfiguredUrl(ctx, getConfigKey(pageId)),
  };
}

function requireOperatorTarget(requestContext: PluginUIRequestContext): string {
  if (requestContext.instanceTarget.kind !== 'operator') {
    throw new Error('This page requires an operator-scoped plugin instance');
  }
  return requestContext.instanceTarget.operatorId;
}

function getPlacement(pageId: string): Placement {
  return pageId === AUTOMATION_PAGE_ID ? 'automation' : 'operator';
}

function getConfigKey(pageId: string): ConfigKey {
  return pageId === AUTOMATION_PAGE_ID ? 'automationPopoverUrl' : 'operatorCardUrl';
}

function getConfiguredUrl(ctx: { config: Record<string, unknown> }, key: ConfigKey): string {
  const value = ctx.config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function syncPanelMeta(ctx: PluginContext) {
  const operatorUrl = getConfiguredUrl(ctx, 'operatorCardUrl');
  const automationUrl = getConfiguredUrl(ctx, 'automationPopoverUrl');

  ctx.ui.setPanelMeta(OPERATOR_PAGE_ID, {
    visible: operatorUrl.length > 0,
    title: '',
  });
  ctx.ui.setPanelMeta(AUTOMATION_PAGE_ID, {
    visible: automationUrl.length > 0,
    title: '',
  });
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
  pushConfigUpdated(ctx, OPERATOR_PAGE_ID);
  pushConfigUpdated(ctx, AUTOMATION_PAGE_ID);
}

const plugin: PluginDefinition = {
  name: WEB_IFRAME_EMBED_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  description: 'pluginDescription',

  settings: {
    embedNotice: {
      type: 'info',
      default: '',
      label: 'embedNoticeLabel',
      description: 'embedNoticeDescription',
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
      scope: 'operator',
    },
  },

  panels: [
    {
      id: OPERATOR_PAGE_ID,
      title: '',
      component: 'iframe',
      pageId: OPERATOR_PAGE_ID,
      width: 'full',
    },
    {
      id: AUTOMATION_PAGE_ID,
      title: '',
      component: 'iframe',
      pageId: AUTOMATION_PAGE_ID,
      slot: 'automation',
    },
  ],

  ui: {
    dir: 'ui',
    pages: [
      {
        id: OPERATOR_PAGE_ID,
        title: 'operatorPageTitle',
        entry: 'operator-webview.html',
        accessScope: 'operator',
        resourceBinding: 'operator',
      },
      {
        id: AUTOMATION_PAGE_ID,
        title: 'automationPageTitle',
        entry: 'automation-webview.html',
        accessScope: 'operator',
        resourceBinding: 'operator',
      },
    ],
  },

  async onLoad(ctx) {
    syncPanelMeta(ctx);

    ctx.ui.registerPageHandler({
      async onMessage(pageId, action, _data, requestContext) {
        switch (action) {
          case 'getConfig': {
            const operatorId = requireOperatorTarget(requestContext);
            const placement = getPlacement(pageId);
            const key = getConfigKey(pageId);
            const url = getConfiguredUrl(ctx, key);

            ctx.log.debug('Resolved panel embed config', {
              operatorId,
              pageId,
              placement,
              hasUrl: url.length > 0,
            });

            const response = buildPageConfig(ctx, pageId);
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
