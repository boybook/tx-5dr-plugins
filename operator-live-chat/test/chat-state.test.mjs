import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeActivity,
  appendMessage,
  coerceChatState,
  createChatSnapshot,
  createEmptyChatState,
  hasUnreadActivity,
  MAX_MESSAGES,
  normalizeMessageText,
  upsertProfile,
} from '../dist/chat-state.js';

test('normalizeMessageText trims content', () => {
  assert.equal(normalizeMessageText('  hello world  '), 'hello world');
});

test('normalizeMessageText rejects empty values', () => {
  assert.throws(() => normalizeMessageText('   '), /message_empty/);
});

test('normalizeMessageText rejects overly long values', () => {
  assert.throws(() => normalizeMessageText('x'.repeat(501)), /message_too_long/);
});

test('appendMessage caps message history', () => {
  let state = createEmptyChatState();
  for (let index = 0; index < MAX_MESSAGES; index += 1) {
    state = appendMessage(state, {
      id: `msg-${index}`,
      tokenId: 'token-a',
      senderLabel: 'Alpha',
      role: 'operator',
      text: `message ${index}`,
      createdAt: new Date(index * 1_000).toISOString(),
    });
  }

  const result = appendMessage(state, {
    id: 'msg-final',
    tokenId: 'token-a',
    senderLabel: 'Alpha',
    role: 'operator',
    text: 'final message',
    createdAt: new Date(MAX_MESSAGES * 1_000).toISOString(),
  });

  assert.equal(result.messages.length, MAX_MESSAGES);
  assert.equal(result.messages[0]?.id, 'msg-1');
  assert.equal(result.messages.at(-1)?.id, 'msg-final');
  assert.equal(result.activity.lastMessageId, 'msg-final');
});

test('upsertProfile stores sender label by token id', () => {
  const state = upsertProfile(createEmptyChatState(), {
    tokenId: 'token-1',
    label: 'Control Desk',
  });

  assert.equal(state.profiles['token-1'], 'Control Desk');
});

test('coerceChatState drops malformed persisted data', () => {
  const state = coerceChatState({
    messages: [
      { id: 1 },
      { id: 'ok', tokenId: 'token-2', senderLabel: 'Bravo', role: 'operator', text: 'hi', createdAt: '2025-01-01T00:00:00.000Z' },
    ],
    profiles: {
      broken: {},
      'token-2': { label: 'Bravo', role: 'operator', lastSeenAt: '2025-01-01T00:00:00.000Z' },
      'token-3': 'Charlie',
    },
    activity: {
      active: true,
      lastMessageId: 'ok',
      lastMessageAt: '2025-01-01T00:00:00.000Z',
    },
    reads: {
      broken: null,
      'token-2': 'ok',
    },
  });

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.id, 'ok');
  assert.deepEqual(state.profiles, {
    'token-2': 'Bravo',
    'token-3': 'Charlie',
  });
  assert.deepEqual(state.activity, {
    lastMessageId: 'ok',
    lastMessageAt: '2025-01-01T00:00:00.000Z',
  });
  assert.deepEqual(state.reads, {
    'token-2': 'ok',
  });
});

test('acknowledgeActivity records the last read message per token', () => {
  const activeState = {
    ...createEmptyChatState(),
    activity: {
      lastMessageId: 'msg-1',
      lastMessageAt: '2025-01-01T00:00:00.000Z',
    },
  };
  const acknowledged = acknowledgeActivity(activeState, 'token-1');
  assert.equal(acknowledged.reads['token-1'], 'msg-1');
  assert.equal(acknowledged.activity.lastMessageId, 'msg-1');

  const idleState = createEmptyChatState();
  assert.equal(acknowledgeActivity(idleState, 'token-1'), idleState);
});

test('sender sees the new message as read while other users keep unread activity', () => {
  let state = createEmptyChatState();
  state = appendMessage(state, {
    id: 'msg-1',
    tokenId: 'token-a',
    senderLabel: 'Alpha',
    role: 'operator',
    text: 'hello',
    createdAt: '2025-01-01T00:00:00.000Z',
  });
  state = acknowledgeActivity(state, 'token-a');

  assert.equal(hasUnreadActivity(state, 'token-a'), false);
  assert.equal(hasUnreadActivity(state, 'token-b'), true);
  assert.equal(createChatSnapshot(state, 'token-a').activity.active, false);
  assert.equal(createChatSnapshot(state, 'token-b').activity.active, true);
});
