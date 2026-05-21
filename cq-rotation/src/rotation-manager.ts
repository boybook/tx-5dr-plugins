import type { PluginContext } from '@tx5dr/plugin-api';
import {
  type RotationState,
  DEFAULT_ROTATION_STATE,
  COORDINATOR_HEARTBEAT_INTERVAL,
  COORDINATOR_HEARTBEAT_TIMEOUT,
  OPERATOR_CHECK_INTERVAL,
} from './types.js';

const TIMER_HEARTBEAT = 'coordinator-heartbeat';
const TIMER_OPERATOR_CHECK = 'operator-check';

export class RotationManager {
  private ctx: PluginContext;
  private isCoordinator = false;
  private lastBroadcastState = '';

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

    const callsigns = (this.ctx.config.operatorCallsigns as string[]) || [];
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
      failCount: 0,
      waitingForQSO: false,
    };

    this.setState(newState);
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
      failCount: 0,
      waitingForQSO: false,
    });

    if (this.ctx.operator.isTransmitting) {
      this.ctx.operator.stopTransmitting();
    }

    this.ctx.log.info('CQ rotation stopped');
    this.broadcastState();
  }

  updateOperatorList(callsigns: string[]): void {
    const state = this.getState();
    if (!state.isRunning) return;

    if (callsigns.length < 2) {
      this.ctx.log.warn('Operator list too short, stopping rotation');
      this.stop();
      return;
    }

    let orderedCallsigns = [...callsigns];
    if (state.mode === 'random') {
      orderedCallsigns = this.shuffleArray([...callsigns]);
    }

    this.setState({
      operatorCallsigns: orderedCallsigns,
      currentIndex: 0,
      lastSwitchTimestamp: Date.now(),
      coveredIndices: state.mode === 'random' ? [0] : [],
    });

    this.ctx.log.info('Operator list updated', { operators: orderedCallsigns });
    this.broadcastState();
  }

  handleHeartbeat(): void {
    if (this.isCoordinator) {
      this.setState({ coordinatorHeartbeat: Date.now() });
    } else {
      this.tryClaimCoordinator();
    }
  }

  handleOperatorCheck(): void {
    const state = this.getState();
    if (!state.isRunning) return;
    if (state.operatorCallsigns.length === 0) return;

    // Broadcast state to this instance's own panels (Fix #1: sync across all operators)
    this.broadcastState();

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

  /**
   * Called on every FT8 slot start. Uses slot-aligned timing for rotation.
   * (Fix #2: align with FT8 timing)
   */
  handleSlotStart(slotStartMs: number): void {
    if (!this.isCoordinator) return;

    const state = this.getState();
    if (!state.isRunning) return;

    // If waiting for QSO to complete, don't rotate
    if (state.waitingForQSO) {
      this.ctx.log.debug('Waiting for QSO to complete before rotating');
      return;
    }

    const elapsed = slotStartMs - state.lastSwitchTimestamp;
    if (elapsed < state.intervalMs) return;

    // Time is up — check if current operator is mid-QSO
    const currentCallsign = state.operatorCallsigns[state.currentIndex];
    const isCurrentOperator = this.ctx.operator.callsign === currentCallsign;

    if (isCurrentOperator && this.ctx.operator.automation) {
      const currentState = this.ctx.operator.automation.currentState;
      // If not in TX6 (idle/CQ), operator is mid-QSO
      if (currentState && currentState !== 'TX6') {
        this.setState({ waitingForQSO: true });
        this.ctx.log.info('Rotation time up but operator mid-QSO, waiting', {
          callsign: currentCallsign,
          state: currentState,
        });
        this.broadcastState();
        return;
      }
    }

    this.rotateToNext(slotStartMs);
  }

  /**
   * Called when a QSO completes. Reset fail count.
   * If we were waiting for QSO, rotate now.
   * (Fix #3)
   */
  handleQSOComplete(): void {
    const state = this.getState();
    if (!state.isRunning) return;

    this.setState({ failCount: 0 });

    if (state.waitingForQSO) {
      this.ctx.log.info('QSO completed, proceeding with rotation');
      this.setState({ waitingForQSO: false });
      if (this.isCoordinator) {
        this.rotateToNext(Date.now());
      }
    }
  }

  /**
   * Called when a QSO fails. Increment fail count.
   * If fail count reaches 2, force rotate.
   * (Fix #3)
   */
  handleQSOFail(): void {
    const state = this.getState();
    if (!state.isRunning) return;

    const newFailCount = state.failCount + 1;
    this.setState({ failCount: newFailCount });

    this.ctx.log.info('QSO failed', { failCount: newFailCount });

    if (newFailCount >= 2) {
      this.ctx.log.warn('Two consecutive QSO failures, forcing rotation');
      this.setState({ failCount: 0, waitingForQSO: false });
      if (this.isCoordinator) {
        this.rotateToNext(Date.now());
      }
    } else if (state.waitingForQSO) {
      // First fail while waiting — keep waiting for the second attempt
      this.ctx.log.info('First fail while waiting, will retry once more');
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

  // ─── Private ───

  private rotateToNext(slotStartMs: number): void {
    const state = this.getState();
    const nextIndex = this.computeNextIndex(state);
    this.setState({
      currentIndex: nextIndex,
      lastSwitchTimestamp: slotStartMs,
      failCount: 0,
      waitingForQSO: false,
    });

    this.ctx.log.info('Rotation switched to operator', {
      nextCallsign: state.operatorCallsigns[nextIndex],
      nextIndex,
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
    } else if (state.coordinatorOperatorId === this.ctx.operator.id) {
      this.isCoordinator = true;
      this.setState({ coordinatorHeartbeat: now });
    }
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
    const stateKey = JSON.stringify(fullState);
    if (stateKey === this.lastBroadcastState) return;
    this.lastBroadcastState = stateKey;
    // State is already in ctx.store.global via setState()
  }
}
