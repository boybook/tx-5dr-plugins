import { randomUUID } from 'node:crypto';
import type {
  PluginContext,
  PluginDefinition,
  PluginPanelDescriptor,
  PluginUIRequestContext,
} from '@tx5dr/plugin-api';
import {
  acknowledgeActivity,
  appendMessage,
  coerceChatState,
  createChatSnapshot,
  createEmptyChatState,
  hasUnreadActivity,
  normalizeSenderLabel,
  normalizeMessageText,
  type ChatRole,
  type ChatSnapshot,
  type ChatState,
  upsertProfile,
} from './chat-state.js';

const PLUGIN_NAME = 'operator-live-chat';
const PAGE_ID = 'chat';
const TOOLBAR_GROUP_ID = 'toolbar-entry';
const PANEL_ID = 'chat-toolbar';
const STORE_KEY_MESSAGES = 'messages';
const STORE_KEY_PROFILES = 'profiles';
const STORE_KEY_ACTIVITY = 'activity';
const STORE_KEY_READS = 'reads';

interface BootstrapPayload {
  label?: unknown;
}

interface SendMessagePayload {
  text?: unknown;
  label?: unknown;
}

interface ChatSnapshotPayload extends ChatSnapshot {}

interface BootstrapResult extends ChatSnapshotPayload {
  currentUser: {
    tokenId: string;
    label: string;
  };
}

interface UserScopedPanelMetaBridge {
  setPanelMeta(panelId: string, meta: { tone: 'default' | 'danger' }): void;
  setPanelMetaForUser(panelId: string, tokenId: string, meta: { tone: 'default' | 'danger' }): void;
}

function toChatRole(role: PluginUIRequestContext['user']['role']): ChatRole {
  return role === 'admin' ? 'admin' : 'operator';
}

function buildToolbarPanel(): PluginPanelDescriptor {
  return {
    id: PANEL_ID,
    title: 'toolbarTitle',
    component: 'iframe',
    pageId: PAGE_ID,
    slot: 'radio-control-toolbar',
    icon: 'comments',
    openMode: 'popover',
    uiSize: 'lg',
  };
}

function buildToolbarTone(active: boolean): 'default' | 'danger' {
  return active ? 'danger' : 'default';
}

class OperatorLiveChatService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sessionUsers = new Map<string, string>();

  constructor(private readonly ctx: PluginContext) {}

  load(): void {
    this.ctx.ui.registerPageHandler({
      onMessage: (pageId, action, data, requestContext) => {
        if (pageId !== PAGE_ID) {
          throw new Error(`unsupported_page:${pageId}`);
        }

        switch (action) {
          case 'bootstrap':
            return this.enqueue(() => this.handleBootstrap(data as BootstrapPayload | undefined, requestContext));
          case 'sendMessage':
            return this.enqueue(() => this.handleSendMessage(data as SendMessagePayload | undefined, requestContext));
          case 'ackActivity':
            return this.enqueue(() => this.handleAckActivity(requestContext));
          default:
            throw new Error(`unknown_action:${action}`);
        }
      },
    });

    this.renderGlobalToolbar(this.hasGlobalUnread(this.readState()));
  }

  unload(): void {
    this.ctx.ui.clearPanelContributions(TOOLBAR_GROUP_ID);
    this.sessionUsers.clear();
  }

  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const nextTask = this.queue.then(() => task());
    this.queue = nextTask.catch((error) => {
      this.ctx.log.error('operator_live_chat_queue_task_failed', error);
      return undefined;
    });
    return nextTask;
  }

  private readState(): ChatState {
    return coerceChatState({
      messages: this.ctx.store.global.get(STORE_KEY_MESSAGES, createEmptyChatState().messages),
      profiles: this.ctx.store.global.get(STORE_KEY_PROFILES, createEmptyChatState().profiles),
      activity: this.ctx.store.global.get(STORE_KEY_ACTIVITY, createEmptyChatState().activity),
      reads: this.ctx.store.global.get(STORE_KEY_READS, createEmptyChatState().reads),
    });
  }

  private async persistState(state: ChatState): Promise<void> {
    this.ctx.store.global.set(STORE_KEY_MESSAGES, state.messages);
    this.ctx.store.global.set(STORE_KEY_PROFILES, state.profiles);
    this.ctx.store.global.set(STORE_KEY_ACTIVITY, state.activity);
    this.ctx.store.global.set(STORE_KEY_READS, state.reads);
    await this.ctx.store.global.flush();
  }

  private hasGlobalUnread(state: ChatState): boolean {
    return state.activity.lastMessageId !== null;
  }

  private toSnapshotForUser(state: ChatState, tokenId: string): ChatSnapshotPayload {
    return createChatSnapshot(state, tokenId);
  }

  private renderGlobalToolbar(active: boolean): void {
    this.ctx.ui.setPanelContributions(TOOLBAR_GROUP_ID, [buildToolbarPanel()]);
    (this.ctx.ui as typeof this.ctx.ui & UserScopedPanelMetaBridge).setPanelMeta(PANEL_ID, {
      tone: buildToolbarTone(active),
    });
  }

  private renderToolbarForUser(state: ChatState, tokenId: string): void {
    (this.ctx.ui as typeof this.ctx.ui & UserScopedPanelMetaBridge).setPanelMetaForUser(PANEL_ID, tokenId, {
      tone: buildToolbarTone(hasUnreadActivity(state, tokenId)),
    });
  }

  private pruneSessionUsers(): void {
    const activeSessionIds = new Set(
      this.ctx.ui.listActivePageSessions(PAGE_ID).map((session) => session.sessionId),
    );
    for (const sessionId of this.sessionUsers.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.sessionUsers.delete(sessionId);
      }
    }
  }

  private pushSnapshots(state: ChatState): void {
    this.pruneSessionUsers();

    const renderedUsers = new Set<string>();
    for (const session of this.ctx.ui.listActivePageSessions(PAGE_ID)) {
      const tokenId = this.sessionUsers.get(session.sessionId);
      if (!tokenId) {
        continue;
      }
      if (!renderedUsers.has(tokenId)) {
        this.renderToolbarForUser(state, tokenId);
        renderedUsers.add(tokenId);
      }
      this.ctx.ui.pushToSession(session.sessionId, 'chatState', this.toSnapshotForUser(state, tokenId));
    }
  }

  private async handleBootstrap(
    payload: BootstrapPayload | undefined,
    requestContext: PluginUIRequestContext,
  ): Promise<BootstrapResult> {
    const currentState = this.readState();
    const label = normalizeSenderLabel(
      payload?.label,
      currentState.profiles[requestContext.user.tokenId] ?? requestContext.user.tokenId,
    );

    this.sessionUsers.set(requestContext.pageSessionId, requestContext.user.tokenId);

    const profiledState = upsertProfile(currentState, {
      tokenId: requestContext.user.tokenId,
      label,
    });
    const nextState = acknowledgeActivity(profiledState, requestContext.user.tokenId);

    await this.persistState(nextState);
    this.renderGlobalToolbar(this.hasGlobalUnread(nextState));
    this.pushSnapshots(nextState);

    return {
      ...this.toSnapshotForUser(nextState, requestContext.user.tokenId),
      currentUser: {
        tokenId: requestContext.user.tokenId,
        label,
      },
    };
  }

  private async handleSendMessage(
    payload: SendMessagePayload | undefined,
    requestContext: PluginUIRequestContext,
  ): Promise<BootstrapResult> {
    const role = toChatRole(requestContext.user.role);
    const currentState = this.readState();
    const text = normalizeMessageText(payload?.text);
    const label = normalizeSenderLabel(
      payload?.label,
      currentState.profiles[requestContext.user.tokenId] ?? requestContext.user.tokenId,
    );
    const createdAt = new Date().toISOString();

    this.sessionUsers.set(requestContext.pageSessionId, requestContext.user.tokenId);

    const profiledState = upsertProfile(currentState, {
      tokenId: requestContext.user.tokenId,
      label,
    });

    const appendedState = appendMessage(profiledState, {
      id: randomUUID(),
      tokenId: requestContext.user.tokenId,
      senderLabel: label,
      role,
      text,
      createdAt,
    });
    const nextState = acknowledgeActivity(appendedState, requestContext.user.tokenId);

    await this.persistState(nextState);
    this.renderGlobalToolbar(this.hasGlobalUnread(nextState));
    this.pushSnapshots(nextState);

    return {
      ...this.toSnapshotForUser(nextState, requestContext.user.tokenId),
      currentUser: {
        tokenId: requestContext.user.tokenId,
        label,
      },
    };
  }

  private async handleAckActivity(
    requestContext: PluginUIRequestContext,
  ): Promise<ChatSnapshotPayload> {
    const currentState = this.readState();
    this.sessionUsers.set(requestContext.pageSessionId, requestContext.user.tokenId);

    const nextState = acknowledgeActivity(currentState, requestContext.user.tokenId);
    if (nextState !== currentState) {
      await this.persistState(nextState);
    }

    this.renderGlobalToolbar(this.hasGlobalUnread(nextState));
    this.pushSnapshots(nextState);
    return this.toSnapshotForUser(nextState, requestContext.user.tokenId);
  }
}

let service: OperatorLiveChatService | null = null;

const plugin: PluginDefinition = {
  name: PLUGIN_NAME,
  version: '0.1.0',
  type: 'utility',
  instanceScope: 'global',
  description: 'pluginDescription',

  storage: { scopes: ['global'] },

  ui: {
    dir: 'ui',
    pages: [
      {
        id: PAGE_ID,
        title: 'pageTitle',
        entry: 'chat.html',
        accessScope: 'operator',
        resourceBinding: 'none',
      },
    ],
  },

  onLoad(ctx) {
    service = new OperatorLiveChatService(ctx);
    service.load();
  },

  onUnload() {
    service?.unload();
    service = null;
  },

  hooks: {},
};

export default plugin;
