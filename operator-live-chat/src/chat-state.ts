export const MAX_MESSAGES = 200;
export const MAX_MESSAGE_LENGTH = 500;
export const ACTIVITY_WINDOW_MS = 20_000;

export type ChatRole = 'operator' | 'admin';

export interface ChatProfile {
  tokenId: string;
  label: string;
  role: ChatRole;
  lastSeenAt: string;
}

export interface ChatMessage {
  id: string;
  tokenId: string;
  senderLabel: string;
  role: ChatRole;
  text: string;
  createdAt: string;
}

export interface ChatActivity {
  active: boolean;
  lastMessageId: string | null;
  lastMessageAt: string | null;
}

export interface ChatState {
  messages: ChatMessage[];
  profiles: Record<string, ChatProfile>;
  activity: ChatActivity;
}

interface AppendMessageInput {
  id: string;
  tokenId: string;
  senderLabel: string;
  role: ChatRole;
  text: string;
  createdAt: string;
}

interface UpsertProfileInput {
  tokenId: string;
  label: string;
  role: ChatRole;
  lastSeenAt: string;
}

function coerceRole(value: unknown): ChatRole | null {
  return value === 'admin' || value === 'operator' ? value : null;
}

function coerceString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function coerceBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function createEmptyChatState(): ChatState {
  return {
    messages: [],
    profiles: {},
    activity: {
      active: false,
      lastMessageId: null,
      lastMessageAt: null,
    },
  };
}

export function normalizeSenderLabel(label: unknown, fallback: string): string {
  if (typeof label !== 'string') {
    return fallback;
  }

  const normalized = label.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 100);
}

export function normalizeMessageText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('message_empty');
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error('message_empty');
  }

  if (normalized.length > MAX_MESSAGE_LENGTH) {
    throw new Error('message_too_long');
  }

  return normalized;
}

export function coerceChatState(input: {
  messages?: unknown;
  profiles?: unknown;
  activity?: unknown;
} | null | undefined): ChatState {
  const fallback = createEmptyChatState();
  if (!input || typeof input !== 'object') {
    return fallback;
  }

  const rawMessages = Array.isArray(input.messages) ? input.messages : [];
  const messages = rawMessages.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const id = coerceString((entry as Record<string, unknown>).id);
    const tokenId = coerceString((entry as Record<string, unknown>).tokenId);
    const senderLabel = coerceString((entry as Record<string, unknown>).senderLabel);
    const role = coerceRole((entry as Record<string, unknown>).role);
    const text = coerceString((entry as Record<string, unknown>).text);
    const createdAt = coerceString((entry as Record<string, unknown>).createdAt);
    if (!id || !tokenId || !senderLabel || !role || !text || !createdAt) {
      return [];
    }

    return [{
      id,
      tokenId,
      senderLabel,
      role,
      text,
      createdAt,
    }];
  }).slice(-MAX_MESSAGES);

  const rawProfiles = input.profiles && typeof input.profiles === 'object'
    ? input.profiles as Record<string, unknown>
    : {};
  const profiles = Object.fromEntries(
    Object.entries(rawProfiles).flatMap(([tokenId, entry]) => {
      if (!entry || typeof entry !== 'object') {
        return [];
      }

      const label = coerceString((entry as Record<string, unknown>).label);
      const role = coerceRole((entry as Record<string, unknown>).role);
      const lastSeenAt = coerceString((entry as Record<string, unknown>).lastSeenAt);
      if (!label || !role || !lastSeenAt) {
        return [];
      }

      return [[tokenId, {
        tokenId,
        label,
        role,
        lastSeenAt,
      } satisfies ChatProfile]];
    }),
  );

  const rawActivity = input.activity && typeof input.activity === 'object'
    ? input.activity as Record<string, unknown>
    : {};
  const active = coerceBoolean(rawActivity.active) ?? false;
  const lastMessageId = coerceString(rawActivity.lastMessageId);
  const lastMessageAt = coerceString(rawActivity.lastMessageAt);

  return {
    messages,
    profiles,
    activity: {
      active,
      lastMessageId,
      lastMessageAt,
    },
  };
}

export function upsertProfile(state: ChatState, input: UpsertProfileInput): ChatState {
  const profile: ChatProfile = {
    tokenId: input.tokenId,
    label: normalizeSenderLabel(input.label, input.tokenId),
    role: input.role,
    lastSeenAt: input.lastSeenAt,
  };

  return {
    ...state,
    profiles: {
      ...state.profiles,
      [input.tokenId]: profile,
    },
  };
}

export function appendMessage(state: ChatState, input: AppendMessageInput): {
  state: ChatState;
  message: ChatMessage;
} {
  const message: ChatMessage = {
    id: input.id,
    tokenId: input.tokenId,
    senderLabel: normalizeSenderLabel(input.senderLabel, input.tokenId),
    role: input.role,
    text: normalizeMessageText(input.text),
    createdAt: input.createdAt,
  };

  const messages = [...state.messages, message].slice(-MAX_MESSAGES);
  return {
    message,
    state: {
      ...state,
      messages,
      activity: {
        active: true,
        lastMessageId: message.id,
        lastMessageAt: message.createdAt,
      },
    },
  };
}

export function acknowledgeActivity(state: ChatState): ChatState {
  if (!state.activity.active) {
    return state;
  }

  return {
    ...state,
    activity: {
      ...state.activity,
      active: false,
    },
  };
}

export function shouldExpireActivity(
  activity: ChatActivity,
  nowMs: number,
  windowMs = ACTIVITY_WINDOW_MS,
): boolean {
  if (!activity.active || !activity.lastMessageAt) {
    return false;
  }

  const lastMessageTime = Date.parse(activity.lastMessageAt);
  if (!Number.isFinite(lastMessageTime)) {
    return true;
  }

  return lastMessageTime + windowMs <= nowMs;
}
