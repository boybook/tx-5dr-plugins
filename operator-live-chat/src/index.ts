import { randomUUID } from 'node:crypto';
import type {
  PluginContext,
  PluginDefinition,
  PluginPanelDescriptor,
  PluginUIRequestContext,
} from '@tx5dr/plugin-api';
import {
  ACTIVITY_WINDOW_MS,
  acknowledgeActivity,
  appendMessage,
  coerceChatState,
  createEmptyChatState,
  normalizeSenderLabel,
  normalizeMessageText,
  type ChatRole,
  type ChatState,
  upsertProfile,
  shouldExpireActivity,
} from './chat-state.js';

const PLUGIN_NAME = 'operator-live-chat';
const PAGE_ID = 'chat';
const TOOLBAR_GROUP_ID = 'toolbar-entry';
const PANEL_ID = 'chat-toolbar';
const ACTIVITY_TIMER_ID = 'activity-clear';
const STORE_KEY_MESSAGES = 'messages';
const STORE_KEY_PROFILES = 'profiles';
const STORE_KEY_ACTIVITY = 'activity';

type SupportedUserRole = 'operator' | 'admin';

interface BootstrapPayload {
  label?: unknown;
}

interface SendMessagePayload {
  text?: unknown;
  label?: unknown;
}

interface ChatSnapshotPayload {
  messages: ChatState['messages'];
  activity: ChatState['activity'];
}

interface BootstrapResult extends ChatSnapshotPayload {
  currentUser: {
    tokenId: string;
    label: string;
    role: SupportedUserRole;
  };
}

interface ToolbarTonePanelMeta {
  tone: 'default' | 'danger';
}

function toChatRole(role: PluginUIRequestContext['user']['role']): SupportedUserRole {
  return role === 'admin' ? 'admin' : 'operator';
}

function buildToolbarPanel(active: boolean): PluginPanelDescriptor {
  return {
    id: PANEL_ID,
    title: active ? 'toolbarActiveTitle' : 'toolbarTitle',
    component: 'iframe',
    pageId: PAGE_ID,
    slot: 'radio-control-toolbar',
    icon: active ? 'comment-dots' : 'comments',
    openMode: 'popover',
    uiSize: 'lg',
  };
}

function buildToolbarTone(active: boolean): 'default' | 'danger' {
  return active ? 'danger' : 'default';
}

class OperatorLiveChatService {
  private queue: Promise<unknown> = Promise.resolve();

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
            return this.enqueue(() => this.handleAckActivity());
          default:
            throw new Error(`unknown_action:${action}`);
        }
      },
    });

    this.renderToolbar(this.readState().activity.active);
  }

  unload(): void {
    this.ctx.timers.clear(ACTIVITY_TIMER_ID);
    this.ctx.ui.clearPanelContributions(TOOLBAR_GROUP_ID);
  }

  onTimer(timerId: string): void {
    if (timerId !== ACTIVITY_TIMER_ID) {
      return;
    }

    void this.enqueue(async () => {
      const state = this.readState();
      if (!shouldExpireActivity(state.activity, Date.now())) {
        return;
      }

      const nextState = acknowledgeActivity(state);
      await this.persistState(nextState);
      this.renderToolbar(false);
      this.pushSnapshot(this.toSnapshot(nextState));
    });
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
    });
  }

  private async persistState(state: ChatState): Promise<void> {
    this.ctx.store.global.set(STORE_KEY_MESSAGES, state.messages);
    this.ctx.store.global.set(STORE_KEY_PROFILES, state.profiles);
    this.ctx.store.global.set(STORE_KEY_ACTIVITY, state.activity);
    await this.ctx.store.global.flush();
  }

  private toSnapshot(state: ChatState): ChatSnapshotPayload {
    return {
      messages: state.messages,
      activity: state.activity,
    };
  }

  private renderToolbar(active: boolean): void {
    this.ctx.ui.setPanelContributions(TOOLBAR_GROUP_ID, [buildToolbarPanel(active)]);
    (this.ctx.ui as typeof this.ctx.ui & {
      setPanelMeta(panelId: string, meta: ToolbarTonePanelMeta): void;
    }).setPanelMeta(PANEL_ID, {
      tone: buildToolbarTone(active),
    });
  }

  private pushSnapshot(snapshot: ChatSnapshotPayload): void {
    for (const session of this.ctx.ui.listActivePageSessions(PAGE_ID)) {
      this.ctx.ui.pushToSession(session.sessionId, 'chatState', snapshot);
    }
  }

  private async handleBootstrap(
    payload: BootstrapPayload | undefined,
    requestContext: PluginUIRequestContext,
  ): Promise<BootstrapResult> {
    const role = toChatRole(requestContext.user.role);
    const currentState = this.readState();
    const label = normalizeSenderLabel(
      payload?.label,
      currentState.profiles[requestContext.user.tokenId]?.label ?? requestContext.user.tokenId,
    );

    const nextState = upsertProfile(currentState, {
      tokenId: requestContext.user.tokenId,
      label,
      role,
      lastSeenAt: new Date().toISOString(),
    });

    await this.persistState(nextState);

    return {
      ...this.toSnapshot(nextState),
      currentUser: {
        tokenId: requestContext.user.tokenId,
        label,
        role,
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
      currentState.profiles[requestContext.user.tokenId]?.label ?? requestContext.user.tokenId,
    );
    const now = new Date().toISOString();

    const profiledState = upsertProfile(currentState, {
      tokenId: requestContext.user.tokenId,
      label,
      role,
      lastSeenAt: now,
    });

    const { state: nextState } = appendMessage(profiledState, {
      id: randomUUID(),
      tokenId: requestContext.user.tokenId,
      senderLabel: label,
      role: role as ChatRole,
      text,
      createdAt: now,
    });

    await this.persistState(nextState);
    this.ctx.timers.set(ACTIVITY_TIMER_ID, ACTIVITY_WINDOW_MS);
    this.renderToolbar(true);

    const snapshot = this.toSnapshot(nextState);
    this.pushSnapshot(snapshot);

    return {
      ...snapshot,
      currentUser: {
        tokenId: requestContext.user.tokenId,
        label,
        role,
      },
    };
  }

  private async handleAckActivity(): Promise<ChatSnapshotPayload> {
    const currentState = this.readState();
    const nextState = acknowledgeActivity(currentState);
    if (nextState === currentState) {
      return this.toSnapshot(currentState);
    }

    this.ctx.timers.clear(ACTIVITY_TIMER_ID);
    await this.persistState(nextState);
    this.renderToolbar(false);
    const snapshot = this.toSnapshot(nextState);
    this.pushSnapshot(snapshot);
    return snapshot;
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

  hooks: {
    onTimer(timerId) {
      service?.onTimer(timerId);
    },
  },
};

export default plugin;
