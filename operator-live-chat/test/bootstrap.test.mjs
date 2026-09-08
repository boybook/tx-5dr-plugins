import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../dist/index.js';

function createMockContext(initialState) {
  let pageHandler;
  let flushCount = 0;
  const store = { ...initialState };
  const pushes = [];
  const userMetaUpdates = [];

  return {
    ctx: {
      ui: {
        registerPageHandler(handler) {
          pageHandler = handler;
        },
        setPanelContributions() {},
        setPanelMeta() {},
        setPanelMetaForUser(panelId, tokenId, meta) {
          userMetaUpdates.push({ panelId, tokenId, meta });
        },
        listActivePageSessions() {
          return [{ sessionId: 'session-1' }];
        },
        pushToSession(sessionId, event, payload) {
          pushes.push({ sessionId, event, payload });
        },
        clearPanelContributions() {},
      },
      store: {
        global: {
          get(key, fallback) {
            return key in store ? store[key] : fallback;
          },
          set(key, value) {
            store[key] = value;
          },
          async flush() {
            flushCount += 1;
          },
        },
      },
      log: {
        error() {},
      },
    },
    getPageHandler() {
      return pageHandler;
    },
    getFlushCount() {
      return flushCount;
    },
    pushes,
    store,
    userMetaUpdates,
  };
}

test('bootstrap marks the current user as read without an extra ack call', async () => {
  const { ctx, getFlushCount, getPageHandler, pushes, store, userMetaUpdates } = createMockContext({
    messages: [
      {
        id: 'msg-1',
        tokenId: 'token-b',
        senderLabel: 'Bravo',
        role: 'operator',
        text: 'hello',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    ],
    profiles: {
      'token-b': 'Bravo',
    },
    activity: {
      lastMessageId: 'msg-1',
      lastMessageAt: '2025-01-01T00:00:00.000Z',
    },
    reads: {},
  });

  plugin.onLoad(ctx);
  const pageHandler = getPageHandler();
  assert.equal(typeof pageHandler?.onMessage, 'function');

  const result = await pageHandler.onMessage(
    'chat',
    'bootstrap',
    { label: '  Alpha  ' },
    {
      pageSessionId: 'session-1',
      user: {
        tokenId: 'token-a',
        role: 'operator',
      },
    },
  );

  assert.deepEqual(result.currentUser, {
    tokenId: 'token-a',
    label: 'Alpha',
  });
  assert.equal(result.activity.active, false);
  assert.equal(getFlushCount(), 1);
  assert.deepEqual(store.profiles, {
    'token-a': 'Alpha',
    'token-b': 'Bravo',
  });
  assert.deepEqual(store.reads, {
    'token-a': 'msg-1',
  });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]?.payload.activity.active, false);
  assert.deepEqual(userMetaUpdates.at(-1), {
    panelId: 'chat-toolbar',
    tokenId: 'token-a',
    meta: { tone: 'default' },
  });

  plugin.onUnload();
});
