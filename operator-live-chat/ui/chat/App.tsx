/// <reference types="@tx5dr/plugin-api/bridge" />
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchCurrentUserLabel } from '../shared/auth';
import { t } from '../shared/i18n';
import { useAutoResize } from '../shared/useAutoResize';
import './App.css';

type ChatRole = 'operator' | 'admin';

interface ChatMessage {
  id: string;
  tokenId: string;
  senderLabel: string;
  role: ChatRole;
  text: string;
  createdAt: string;
}

interface ChatActivity {
  active: boolean;
  lastMessageId: string | null;
  lastMessageAt: string | null;
}

interface ChatSnapshot {
  messages: ChatMessage[];
  activity: ChatActivity;
}

interface CurrentUser {
  tokenId: string;
  label: string;
  role: ChatRole;
}

interface BootstrapResult extends ChatSnapshot {
  currentUser: CurrentUser;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'numeric',
    day: 'numeric',
  }).format(date);
}

function roleLabel(role: ChatRole): string {
  return role === 'admin' ? t('roleAdmin', 'Admin') : t('roleOperator', 'Operator');
}

export function App() {
  const [snapshot, setSnapshot] = useState<ChatSnapshot>({
    messages: [],
    activity: {
      active: false,
      lastMessageId: null,
      lastMessageAt: null,
    },
  });
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  useAutoResize();

  const acknowledgeActivity = useCallback(() => {
    void window.tx5dr.invoke('ackActivity').catch(() => {});
  }, []);

  const applyBootstrap = useCallback((result: BootstrapResult) => {
    setSnapshot({
      messages: result.messages,
      activity: result.activity,
    });
    setCurrentUser(result.currentUser);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      await window.tx5dr.ready;
      const me = await fetchCurrentUserLabel();
      const result = await window.tx5dr.invoke('bootstrap', {
        label: me?.label ?? '',
      }) as BootstrapResult;
      applyBootstrap(result);
      acknowledgeActivity();
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : t('loadError', 'Failed to load chat.');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [acknowledgeActivity, applyBootstrap]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleSnapshot = (nextSnapshot: ChatSnapshot) => {
      setSnapshot(nextSnapshot);
      if (document.visibilityState === 'visible') {
        acknowledgeActivity();
      }
    };

    const handleWindowFocus = () => acknowledgeActivity();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        acknowledgeActivity();
      }
    };

    window.tx5dr.onPush('chatState', handleSnapshot);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.tx5dr.offPush('chatState', handleSnapshot);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [acknowledgeActivity]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [snapshot.messages.length]);

  const handleSend = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || sending || !currentUser) {
      return;
    }

    setSending(true);
    setError(null);
    try {
      const result = await window.tx5dr.invoke('sendMessage', {
        text: trimmed,
        label: currentUser.label,
      }) as BootstrapResult;
      applyBootstrap(result);
      setDraft('');
      acknowledgeActivity();
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : t('loadError', 'Failed to load chat.');
      setError(message);
    } finally {
      setSending(false);
    }
  }, [acknowledgeActivity, applyBootstrap, currentUser, draft, sending]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  const statusLabel = useMemo(() => {
    if (loading) {
      return t('statusSyncing', 'Syncing');
    }
    if (snapshot.activity.active) {
      return t('statusRecent', 'Recent activity');
    }
    return t('statusReady', 'Live');
  }, [loading, snapshot.activity.active]);

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <div>
          <p className="eyebrow">{t('headerTitle', 'Operator Chat')}</p>
          <h1>{t('pageTitle', 'Operator Chat')}</h1>
          <p className="subtitle">{t('headerSubtitle', 'Shared room for active operator and admin accounts')}</p>
        </div>
        <div className={`status-pill ${snapshot.activity.active ? 'status-pill-active' : ''}`}>
          <span className="status-dot" />
          {statusLabel}
        </div>
      </header>

      <div className="identity-bar">
        <span>{t('connectedAs', 'Connected as {{label}}', { label: currentUser?.label ?? '...' })}</span>
        {snapshot.activity.active && (
          <span className="activity-badge">{t('activityBadge', 'Recent activity')}</span>
        )}
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button type="button" className="ghost-button" onClick={() => { void load(); }}>
            {t('retryButton', 'Retry')}
          </button>
        </div>
      )}

      <div className="timeline" ref={timelineRef}>
        {snapshot.messages.length === 0 ? (
          <div className="empty-state">
            <strong>{t('emptyTitle', 'No messages yet')}</strong>
            <p>{t('emptyDescription', 'Start the room with a quick status update or coordination note.')}</p>
          </div>
        ) : (
          snapshot.messages.map((message) => {
            const own = currentUser?.tokenId === message.tokenId;
            return (
              <article key={message.id} className={`message-card ${own ? 'message-card-own' : ''}`}>
                <div className="message-meta">
                  <div className="message-sender">
                    <span className="sender-name">
                      {own ? t('youLabel', 'You') : message.senderLabel}
                    </span>
                    <span className={`role-chip role-chip-${message.role}`}>
                      {roleLabel(message.role)}
                    </span>
                  </div>
                  <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
                </div>
                <p className="message-text">{message.text}</p>
              </article>
            );
          })
        )}
      </div>

      <div className="composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('composerPlaceholder', 'Type a message')}
          rows={3}
          disabled={loading || sending}
        />
        <div className="composer-footer">
          <span>{t('inputHint', 'Enter to send, Shift+Enter for a newline')}</span>
          <button
            type="button"
            className="send-button"
            onClick={() => { void handleSend(); }}
            disabled={loading || sending || !draft.trim()}
          >
            {sending ? t('sendingButton', 'Sending...') : t('sendButton', 'Send')}
          </button>
        </div>
      </div>
    </div>
  );
}
