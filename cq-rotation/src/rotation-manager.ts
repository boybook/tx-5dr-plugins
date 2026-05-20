import type { PluginContext } from '@tx5dr/plugin-api';
import {
  type RotationState,
  DEFAULT_ROTATION_STATE,
  COORDINATOR_HEARTBEAT_INTERVAL,
  COORDINATOR_HEARTBEAT_TIMEOUT,
  OPERATOR_CHECK_INTERVAL,
  ROTATION_TICK_INTERVAL,
} from './types.js';

const TIMER_HEARTBEAT = 'coordinator-heartbeat';
const TIMER_OPERATOR_CHECK = 'operator-check';
const TIMER_ROTATION_TICK = 'rotation-tick';

export class RotationManager {
  private ctx: PluginContext;
  private isCoordinator = false;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  initialize(): void {
    this.tryClaimCoordinator();
    this.ctx.timers.set(TIMER_HEARTBEAT, COORDINATOR_HEARTBEAT_INTERVAL);
    this.ctx.timers.set(TIMER_OPERATOR_CHECK, OPERATOR_CHECK_INTERVAL);

    const state = this.getState();
    if (state.isRunning) {
      this.broadcastState();
    }
  }

  start(): void {
    const state = this.getState();
    if (state.isRunning) return;

    const callsigns = this.buildOperatorCallsignList();
    if (callsigns.length < 2) {
      this.ctx.log.warn('Need at least 2 operators for CQ rotation');
      return;
    }

    const mode = (this.ctx.config.mode as string) || 'sequential';
    const intervalSeconds = (this.ctx.config.intervalSeconds as number) || 120;

    let orderedCallsigns = [...callsigns];
    let coveredIndices: number[] = [];
    if (mode === 'random') {
      orderedCallsigns = this.shuffleArray([...callsigns]);
      coveredIndices = [0];
    }

    const newState: RotationState = {
      isRunning: true,
      operatorCallsigns: orderedCallsigns,
      currentIndex: 0,
      lastSwitchTimestamp: Date.now(),
      intervalMs: intervalSeconds * 1000,
      mode: mode as 'sequential' | 'random',
      coveredIndices,
      coordinatorOperatorId: this.isCoordinator ? this.ctx.operator.id : state.coordinatorOperatorId,
      coordinatorHeartbeat: Date.now(),
    };

    this.setState(newState);

    if (this.isCoordinator) {
      this.ctx.timers.set(TIMER_ROTATION_TICK, ROTATION_TICK_INTERVAL);
    }

    this.ctx.log.info('CQ rotation started', {
      operators: orderedCallsigns,
      mode,
      intervalSeconds,
    });

    this.broadcastState();
  }

  stop(): void {
    const state = this.getState();
    if (!state.isRunning) return;

    this.setState({
      isRunning: false,
      lastSwitchTimestamp: 0,
    });

    if (this.isCoordinator) {
      this.ctx.timers.clear(TIMER_ROTATION_TICK);
    }

    if (this.ctx.operator.isTransmitting) {
      this.ctx.operator.stopTransmitting();
    }

    this.ctx.log.info('CQ rotation stopped');
    this.broadcastState();
  }

  skipToNext(): void {
    const state = this.getState();
    if (!state.isRunning) return;

    const nextIndex = this.computeNextIndex(state);
    this.setState({
      currentIndex: nextIndex,
      lastSwitchTimestamp: Date.now(),
    });

    this.ctx.log.info('Skipped to next operator', {
      nextCallsign: state.operatorCallsigns[nextIndex],
    });

    this.broadcastState();
  }

  shuffleOrder(): void {
    const state = this.getState();
    if (!state.isRunning) return;

    const shuffled = this.shuffleArray([...state.operatorCallsigns]);
    this.setState({
      operatorCallsigns: shuffled,
      currentIndex: 0,
      lastSwitchTimestamp: Date.now(),
      coveredIndices: state.mode === 'random' ? [0] : [],
    });

    this.ctx.log.info('Operator order shuffled', { newOrder: shuffled });
    this.broadcastState();
  }

  setOrder(callsigns: string[]): void {
    const state = this.getState();
    if (!state.isRunning) return;

    this.setState({
      operatorCallsigns: callsigns,
      currentIndex: 0,
      lastSwitchTimestamp: Date.now(),
      coveredIndices: [],
    });

    this.ctx.log.info('Operator order set manually', { order: callsigns });
    this.broadcastState();
  }

  handleHeartbeat(): void {
    if (this.isCoordinator) {
      this.setState({ coordinatorHeartbeat: Date.now() });
    } else {
      this.tryClaimCoordinator();
    }
  }

  handleRotationTick(): void {
    if (!this.isCoordinator) return;

    const state = this.getState();
    if (!state.isRunning) return;

    const elapsed = Date.now() - state.lastSwitchTimestamp;
    if (elapsed < state.intervalMs) return;

    const nextIndex = this.computeNextIndex(state);
    this.setState({
      currentIndex: nextIndex,
      lastSwitchTimestamp: Date.now(),
    });

    this.ctx.log.info('Rotation tick: switched to operator', {
      nextCallsign: state.operatorCallsigns[nextIndex],
      nextIndex,
    });

    this.broadcastState();
  }

  handleOperatorCheck(): void {
    const state = this.getState();
    if (!state.isRunning) return;

    if (state.operatorCallsigns.length === 0) return;

    const myCallsign = this.ctx.operator.callsign;
    const activeCallsign = state.operatorCallsigns[state.currentIndex];
    const isMyTurn = activeCallsign === myCallsign;

    if (isMyTurn && !this.ctx.operator.isTransmitting) {
      this.ctx.operator.startTransmitting();
      this.ctx.log.debug('Started transmitting (my turn)', { callsign: myCallsign });
    } else if (!isMyTurn && this.ctx.operator.isTransmitting) {
      this.ctx.operator.stopTransmitting();
      this.ctx.log.debug('Stopped transmitting (not my turn)', { callsign: myCallsign });
    }
  }

  getFullState(): RotationState & { myCallsign: string; remainingMs: number } {
    const state = this.getState();
    const remainingMs = state.isRunning
      ? Math.max(0, state.intervalMs - (Date.now() - state.lastSwitchTimestamp))
      : 0;

    return {
      ...state,
      myCallsign: this.ctx.operator.callsign,
      remainingMs,
    };
  }

  cleanup(): void {
    this.ctx.timers.clear(TIMER_HEARTBEAT);
    this.ctx.timers.clear(TIMER_OPERATOR_CHECK);
    this.ctx.timers.clear(TIMER_ROTATION_TICK);

    if (this.isCoordinator) {
      const state = this.getState();
      if (state.coordinatorOperatorId === this.ctx.operator.id) {
        this.setState({ coordinatorOperatorId: '', coordinatorHeartbeat: 0 });
      }
    }

    if (this.ctx.operator.isTransmitting) {
      const state = this.getState();
      if (state.isRunning) {
        this.ctx.operator.stopTransmitting();
      }
    }
  }

  updateInterval(intervalSeconds: number): void {
    this.setState({ intervalMs: intervalSeconds * 1000 });
    this.broadcastState();
  }

  updateMode(mode: string): void {
    const state = this.getState();
    this.setState({
      mode: mode as 'sequential' | 'random',
      coveredIndices: mode === 'random' ? [state.currentIndex] : [],
    });
    this.broadcastState();
  }

  private getState(): RotationState {
    return this.ctx.store.global.get<RotationState>('rotationState', DEFAULT_ROTATION_STATE);
  }

  private setState(patch: Partial<RotationState>): void {
    const current = this.getState();
    this.ctx.store.global.set('rotationState', { ...current, ...patch });
  }

  private tryClaimCoordinator(): void {
    const state = this.getState();
    const now = Date.now();

    if (
      !state.coordinatorOperatorId ||
      now - state.coordinatorHeartbeat > COORDINATOR_HEARTBEAT_TIMEOUT
    ) {
      this.isCoordinator = true;
      this.setState({
        coordinatorOperatorId: this.ctx.operator.id,
        coordinatorHeartbeat: now,
      });
      this.ctx.log.info('Claimed coordinator role');

      if (state.isRunning) {
        this.ctx.timers.set(TIMER_ROTATION_TICK, ROTATION_TICK_INTERVAL);
      }
    } else if (state.coordinatorOperatorId === this.ctx.operator.id) {
      this.isCoordinator = true;
      this.setState({ coordinatorHeartbeat: now });
    }
  }

  private buildOperatorCallsignList(): string[] {
    const others = this.ctx.operator.getOtherOperators();
    const myCallsign = this.ctx.operator.callsign;
    const allCallsigns = [myCallsign, ...others.map((o) => o.callsign)];
    return [...new Set(allCallsigns)];
  }

  private computeNextIndex(state: RotationState): number {
    if (state.mode === 'random') {
      return this.getNextRandomIndex(state);
    }
    return (state.currentIndex + 1) % state.operatorCallsigns.length;
  }

  private getNextRandomIndex(state: RotationState): number {
    const total = state.operatorCallsigns.length;
    let covered = [...state.coveredIndices];

    if (covered.length >= total) {
      covered = [];
    }

    const remaining: number[] = [];
    for (let i = 0; i < total; i++) {
      if (!covered.includes(i)) {
        remaining.push(i);
      }
    }

    const picked = remaining[Math.floor(Math.random() * remaining.length)];
    covered.push(picked);

    this.setState({ coveredIndices: covered });
    return picked;
  }

  private shuffleArray<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  private broadcastState(): void {
    const fullState = this.getFullState();
    for (const session of this.ctx.ui.listActivePageSessions('rotation-panel')) {
      this.ctx.ui.pushToSession(session.sessionId, 'stateUpdate', fullState);
    }
  }
}
