/// <reference types="@tx5dr/plugin-api/bridge" />
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAutoResize } from '../shared/useAutoResize';
import { t } from '../shared/i18n';
import './App.css';

interface RotationState {
  isRunning: boolean;
  operatorCallsigns: string[];
  currentIndex: number;
  lastSwitchTimestamp: number;
  intervalMs: number;
  mode: 'sequential' | 'random';
  myCallsign: string;
  remainingMs: number;
}

export function App() {
  const [state, setState] = useState<RotationState | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useAutoResize();

  const fetchState = useCallback(() => {
    window.tx5dr.invoke('getState').then((s: unknown) => {
      const rs = s as RotationState;
      setState(rs);
      setRemaining(Math.max(0, Math.ceil(rs.remainingMs / 1000)));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchState();

    const off = window.tx5dr.onPush('stateUpdate', (data: unknown) => {
      const rs = data as RotationState;
      setState(rs);
      setRemaining(Math.max(0, Math.ceil(rs.remainingMs / 1000)));
    });

    return () => { off(); };
  }, [fetchState]);

  useEffect(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
    }

    if (state?.isRunning) {
      countdownRef.current = setInterval(() => {
        setRemaining((prev) => Math.max(0, prev - 1));
      }, 1000);
    }

    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
      }
    };
  }, [state?.isRunning, state?.lastSwitchTimestamp, state?.intervalMs]);

  const handleStart = () => window.tx5dr.invoke('startRotation').then(fetchState);
  const handleStop = () => window.tx5dr.invoke('stopRotation').then(fetchState);
  const handleSkip = () => window.tx5dr.invoke('skipToNext').then(fetchState);
  const handleShuffle = () => window.tx5dr.invoke('shuffleOrder').then(fetchState);

  const handleDragStart = (index: number) => {
    setDragIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDrop = (index: number) => {
    if (dragIndex === null || dragIndex === index || !state) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }

    const newOrder = [...state.operatorCallsigns];
    const [moved] = newOrder.splice(dragIndex, 1);
    newOrder.splice(index, 0, moved);

    window.tx5dr.invoke('setOrder', { callsigns: newOrder }).then(fetchState);

    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  if (!state) {
    return <div className="cq-rotation-panel">{t('loading', 'Loading...')}</div>;
  }

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${s}s`;
  };

  return (
    <div className="cq-rotation-panel">
      <div className="cq-rotation-status">
        <span className={`dot ${state.isRunning ? 'running' : 'stopped'}`} />
        <span className="status-text">
          {state.isRunning ? t('statusRunning') : t('statusStopped')}
        </span>
        {state.isRunning && (
          <span className="countdown">{formatTime(remaining)}</span>
        )}
      </div>

      <div className="cq-rotation-meta">
        <span>{t('modeLabel')}: {state.mode === 'sequential' ? t('sequentialLabel') : t('randomLabel')}</span>
        <span>{t('intervalLabel')}: {formatTime(Math.floor(state.intervalMs / 1000))}</span>
      </div>

      {state.operatorCallsigns.length === 0 ? (
        <div className="cq-rotation-empty">{t('noOperators')}</div>
      ) : (
        <div className="cq-rotation-queue">
          <div className="cq-rotation-queue-title">{t('operatorQueue')}</div>
          {state.operatorCallsigns.map((callsign, index) => {
            const isActive = index === state.currentIndex;
            const isMe = callsign === state.myCallsign;
            const isDragOver = index === dragOverIndex && dragIndex !== null && dragIndex !== index;

            let className = 'queue-item';
            if (isActive) className += ' active';
            if (isDragOver) className += ' drag-over';

            return (
              <div
                key={callsign}
                className={className}
                draggable={state.isRunning}
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={() => handleDrop(index)}
                onDragEnd={handleDragEnd}
              >
                <span className="index">{index + 1}</span>
                <span className="callsign">
                  {callsign}{isMe ? ' *' : ''}
                </span>
                {isActive && state.isRunning ? (
                  <span className="badge active-badge">{t('activeLabel')}</span>
                ) : (
                  <span className="badge waiting-badge">{t('waitingLabel')}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="cq-rotation-controls">
        {!state.isRunning ? (
          <button className="btn-primary" onClick={handleStart}>
            {t('startRotation')}
          </button>
        ) : (
          <>
            <button className="btn-danger" onClick={handleStop}>
              {t('stopRotation')}
            </button>
            <button onClick={handleSkip}>{t('skipToNext')}</button>
            <button onClick={handleShuffle}>{t('shuffleOrder')}</button>
          </>
        )}
      </div>
    </div>
  );
}
