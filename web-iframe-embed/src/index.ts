import type { PluginContext, PluginDefinition, PluginUIRequestContext } from '@tx5dr/plugin-api';

export const WEB_IFRAME_EMBED_PLUGIN_NAME = 'web-iframe-embed';

const STATIC_PANEL_DEFINITIONS = [
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
] as const;

const VOICE_RIGHT_DYNAMIC_PAGE_ID = 'voice-right-webview';
const VOICE_RIGHT_CONTRIBUTION_GROUP_ID = 'voice-right-web-tabs';

type Placement = typeof STATIC_PANEL_DEFINITIONS[number]['placement'] | 'voice-right-top';
type ConfigKey = typeof STATIC_PANEL_DEFINITIONS[number]['configKey'];
type PageId = typeof STATIC_PANEL_DEFINITIONS[number]['pageId'] | typeof VOICE_RIGHT_DYNAMIC_PAGE_ID;

interface VoiceRightTabConfig {
  id: string;
  title: string;
  url: string;
}

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
  const panel = STATIC_PANEL_DEFINITIONS.find((entry) => entry.pageId === pageId);
  if (!panel) {
    throw new Error(`Unknown page id: ${pageId}`);
  }
  return panel;
}

function normalizeTabId(input: unknown, fallback: string): string {
  const value = typeof input === 'string' ? input.trim() : '';
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function getVoiceRightTabs(ctx: { config: Record<string, unknown> }): VoiceRightTabConfig[] {
  const rawTabs = ctx.config.voiceRightTabs;
  if (Array.isArray(rawTabs)) {
    const usedIds = new Set<string>();
    return rawTabs.flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return [];
      }
      const record = entry as Record<string, unknown>;
      const url = typeof record.url === 'string' ? record.url.trim() : '';
      if (!url) {
        return [];
      }
      let id = normalizeTabId(record.id, `tab-${index + 1}`);
      while (usedIds.has(id)) {
        id = `${id}-${index + 1}`;
      }
      usedIds.add(id);
      const title = typeof record.title === 'string' && record.title.trim()
        ? record.title.trim()
        : `Web ${index + 1}`;
      return [{ id, title, url }];
    });
  }

  return [];
}

function getConfiguredUrl(ctx: { config: Record<string, unknown> }, key: ConfigKey): string {
  const value = ctx.config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function buildPageConfig(ctx: PluginContext, pageId: string, tabId?: string): PageConfigResponse {
  if (pageId === VOICE_RIGHT_DYNAMIC_PAGE_ID) {
    const tab = getVoiceRightTabs(ctx).find((entry) => entry.id === tabId);
    return {
      pageId: VOICE_RIGHT_DYNAMIC_PAGE_ID,
      placement: 'voice-right-top',
      url: tab?.url ?? '',
    };
  }

  const panel = getPanelDefinition(pageId);
  return {
    pageId: panel.pageId,
    placement: panel.placement,
    url: getConfiguredUrl(ctx, panel.configKey),
  };
}

function syncPanelMeta(ctx: PluginContext) {
  for (const panel of STATIC_PANEL_DEFINITIONS) {
    const url = getConfiguredUrl(ctx, panel.configKey);
    ctx.ui.setPanelMeta(panel.pageId, {
      visible: url.length > 0,
      title: '',
    });
  }
}

function publishVoiceRightTabs(ctx: PluginContext): void {
  const tabs = getVoiceRightTabs(ctx);
  const panels = tabs.map((tab) => ({
    id: `voice-right-tab:${tab.id}`,
    title: tab.title,
    component: 'iframe' as const,
    pageId: VOICE_RIGHT_DYNAMIC_PAGE_ID,
    params: { tabId: tab.id },
    slot: 'voice-right-top' as const,
    width: 'full' as const,
  }));
  ctx.ui.setPanelContributions(VOICE_RIGHT_CONTRIBUTION_GROUP_ID, panels);
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
  for (const panel of STATIC_PANEL_DEFINITIONS) {
    pushConfigUpdated(ctx, panel.pageId);
  }
  for (const session of ctx.ui.listActivePageSessions(VOICE_RIGHT_DYNAMIC_PAGE_ID)) {
    ctx.ui.pushToSession(session.sessionId, 'configUpdated');
  }
}

const plugin: PluginDefinition = {
  name: WEB_IFRAME_EMBED_PLUGIN_NAME,
  version: '1.2.0',
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
    voiceRightTabs: {
      type: 'object[]',
      default: [],
      label: 'voiceRightTabsLabel',
      description: 'voiceRightTabsDescription',
      scope: 'global',
      itemFields: [
        { key: 'title', type: 'string', label: 'voiceRightTabTitleLabel', placeholder: 'DX Cluster' },
        { key: 'url', type: 'string', label: 'voiceRightTabUrlLabel', placeholder: 'https://example.com' },
      ],
    },
  },

  panels: STATIC_PANEL_DEFINITIONS.map((panel) => ({
    id: panel.pageId,
    title: '',
    component: 'iframe' as const,
    pageId: panel.pageId,
    ...panel.panel,
  })),

  ui: {
    dir: 'ui',
    pages: [
      ...STATIC_PANEL_DEFINITIONS.map((panel) => ({
        id: panel.pageId,
        title: panel.titleKey,
        entry: panel.entry,
        accessScope: 'operator' as const,
        resourceBinding: 'operator' as const,
      })),
      {
        id: VOICE_RIGHT_DYNAMIC_PAGE_ID,
        title: 'voiceRightDynamicPageTitle',
        entry: 'voice-right-top-webview.html',
        accessScope: 'operator' as const,
        resourceBinding: 'operator' as const,
      },
    ],
  },

  async onLoad(ctx: PluginContext) {
    syncPanelMeta(ctx);
    publishVoiceRightTabs(ctx);

    ctx.ui.registerPageHandler({
      async onMessage(
        pageId: string,
        action: string,
        data: unknown,
        requestContext: PluginUIRequestContext,
      ) {
        switch (action) {
          case 'getConfig': {
            const operatorId = requireOperatorTarget(requestContext);
            const tabId = data && typeof data === 'object' && typeof (data as Record<string, unknown>).tabId === 'string'
              ? String((data as Record<string, unknown>).tabId)
              : undefined;
            const response = buildPageConfig(ctx, pageId, tabId);

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
    onConfigChange(_changes: Record<string, unknown>, ctx: PluginContext) {
      syncPanelMeta(ctx);
      publishVoiceRightTabs(ctx);
      notifyConfigUpdated(ctx);
    },
  },
};

export default plugin;
