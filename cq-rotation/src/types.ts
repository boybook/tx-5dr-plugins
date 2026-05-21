/**
 * Shared rotation state stored in ctx.store.global.
 *
 * All operator-scope plugin instances read/write this state
 * to coordinate CQ rotation across operators.
 */
export interface RotationState {
  /** Whether rotation is currently active. */
  isRunning: boolean;
  /** Ordered list of operator callsigns in the rotation queue. */
  operatorCallsigns: string[];
  /** Index of the currently active operator in operatorCallsigns. */
  currentIndex: number;
  /** Timestamp (ms) when the last rotation switch occurred. */
  lastSwitchTimestamp: number;
  /** Rotation interval in milliseconds. */
  intervalMs: number;
  /** Rotation mode: sequential or random. */
  mode: 'sequential' | 'random';
  /** Indices already covered in the current random cycle (for coverage guarantee). */
  coveredIndices: number[];
  /** Operator instance ID of the current coordinator. */
  coordinatorOperatorId: string;
  /** Heartbeat timestamp (ms) of the coordinator. */
  coordinatorHeartbeat: number;
  /** Number of consecutive QSO failures (triggers forced rotation at 2). */
  failCount: number;
  /** Whether we're waiting for the current QSO to complete before rotating. */
  waitingForQSO: boolean;
}

export const DEFAULT_ROTATION_STATE: RotationState = {
  isRunning: false,
  operatorCallsigns: [],
  currentIndex: 0,
  lastSwitchTimestamp: 0,
  intervalMs: 120000,
  mode: 'sequential',
  coveredIndices: [],
  coordinatorOperatorId: '',
  coordinatorHeartbeat: 0,
  failCount: 0,
  waitingForQSO: false,
};

export const COORDINATOR_HEARTBEAT_INTERVAL = 5000;
export const COORDINATOR_HEARTBEAT_TIMEOUT = 10000;
export const OPERATOR_CHECK_INTERVAL = 2000;
