import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeActivity,
  appendMessage,
  coerceChatState,
  createEmptyChatState,
  MAX_MESSAGES,
  normalizeMessageText,
  shouldExpireActivity,
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
    const result = appendMessage(state, {
      id: `msg-${index}`,
      tokenId: 'token-a',
      senderLabel: 'Alpha',
      role: 'operator',
      text: `message ${index}`,
      createdAt: new Date(index * 1_000).toISOString(),
    });
    state = result.state;
  }

  const result = appendMessage(state, {
    id: 'msg-final',
    tokenId: 'token-a',
    senderLabel: 'Alpha',
    role: 'operator',
    text: 'final message',
    createdAt: new Date(MAX_MESSAGES * 1_000).toISOString(),
  });

  assert.equal(result.state.messages.length, MAX_MESSAGES);
  assert.equal(result.state.messages[0]?.id, 'msg-1');
  assert.equal(result.state.messages.at(-1)?.id, 'msg-final');
  assert.equal(result.state.activity.active, true);
  assert.equal(result.state.activity.lastMessageId, 'msg-final');
});

test('upsertProfile binds sender metadata to token id', () => {
  const state = upsertProfile(createEmptyChatState(), {
    tokenId: 'token-1',
    label: 'Control Desk',
    role: 'admin',
    lastSeenAt: '2025-01-01T00:00:00.000Z',
  });

  assert.deepEqual(state.profiles['token-1'], {
    tokenId: 'token-1',
    label: 'Control Desk',
    role: 'admin',
    lastSeenAt: '2025-01-01T00:00:00.000Z',
  });
});

test('coerceChatState drops malformed persisted data', () => {
  const state = coerceChatState({
    messages: [{ id: 1 }, { id: 'ok', tokenId: 'token-2', senderLabel: 'Bravo', role: 'operator', text: 'hi', createdAt: '2025-01-01T00:00:00.000Z' }],
    profiles: {
      broken: { label: 'bad' },
      'token-2': { label: 'Bravo', role: 'operator', lastSeenAt: '2025-01-01T00:00:00.000Z' },
    },
    activity: {
      active: true,
      lastMessageId: 'ok',
      lastMessageAt: '2025-01-01T00:00:00.000Z',
    },
  });

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.id, 'ok');
  assert.deepEqual(state.profiles['token-2'], {
    tokenId: 'token-2',
    label: 'Bravo',
    role: 'operator',
    lastSeenAt: '2025-01-01T00:00:00.000Z',
  });
});

test('acknowledgeActivity clears active state only when needed', () => {
  const activeState = {
    ...createEmptyChatState(),
    activity: {
      active: true,
      lastMessageId: 'msg-1',
      lastMessageAt: '2025-01-01T00:00:00.000Z',
    },
  };
  const acknowledged = acknowledgeActivity(activeState);
  assert.equal(acknowledged.activity.active, false);
  assert.equal(acknowledged.activity.lastMessageId, 'msg-1');

  const idleState = createEmptyChatState();
  assert.equal(acknowledgeActivity(idleState), idleState);
});

test('shouldExpireActivity respects the activity window boundary', () => {
  const activity = {
    active: true,
    lastMessageId: 'msg-1',
    lastMessageAt: '2025-01-01T00:00:00.000Z',
  };

  assert.equal(
    shouldExpireActivity(activity, Date.parse('2025-01-01T00:00:19.999Z'), 20_000),
    false,
  );
  assert.equal(
    shouldExpireActivity(activity, Date.parse('2025-01-01T00:00:20.000Z'), 20_000),
    true,
  );
});

test('shouldExpireActivity expires invalid timestamps', () => {
  assert.equal(
    shouldExpireActivity({
      active: true,
      lastMessageId: 'msg-1',
      lastMessageAt: 'not-a-date',
    }, Date.now()),
    true,
  );
});
