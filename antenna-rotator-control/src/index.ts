import type { PluginContext, PluginDefinition, PluginUIRequestContext } from '@tx5dr/plugin-api';
import type {
  HamlibConfigFieldDescriptor,
  HamlibPortCaps,
  RotatorCaps,
  RotatorConnectionInfo,
  RotatorDirection,
  RotatorPosition,
  RotatorStatus,
  SupportedRotatorInfo,
} from 'hamlib';
import {
  DEFAULT_CONFIG,
  angularDistance,
  coerceRotatorConfig,
  getConnectionPort,
  isAzimuthWithinSoftLimits,
  validateTargetAzimuth,
  type RotatorConfig,
} from './rotator-utils.js';

const PLUGIN_NAME = 'antenna-rotator-control';
const PAGE_ID = 'rotator';
const CONFIG_KEY = 'rotatorConfig';
const POLL_TIMER_ID = 'rotator-position-poll';
const MAX_LOG_ENTRIES = 80;

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'moving' | 'error';
type PositionSource = 'hardware' | 'last-commanded';

interface HamlibRotatorInstance {
  open(): Promise<number>;
  close(): Promise<number>;
  destroy(): void;
  getConnectionInfo(): RotatorConnectionInfo;
  setPosition(azimuth: number, elevation: number): Promise<number>;
  getPosition(): Promise<RotatorPosition>;
  move(direction: RotatorDirection, speed: number): Promise<number>;
  stop(): Promise<number>;
  park(): Promise<number>;
  reset(resetType: 'ALL' | number): Promise<number>;
  getInfo(): Promise<string>;
  getStatus(): Promise<RotatorStatus>;
  setConf(name: string, value: string): Promise<number>;
  getConfigSchema(): HamlibConfigFieldDescriptor[];
  getPortCaps(): HamlibPortCaps;
  getRotatorCaps(): RotatorCaps;
}

interface HamlibModuleShape {
  Rotator: {
    new(model: number, port?: string): HamlibRotatorInstance;
    getSupportedRotators(): SupportedRotatorInfo[];
    getHamlibVersion(): string;
    setDebugLevel(level: number): void;
  };
}

interface PositionSnapshot {
  azimuth: number;
  elevation: number;
  source: PositionSource;
  stale: boolean;
  updatedAt: string;
}

interface DiagnosticLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: string;
}

interface MovementSnapshot {
  targetAzimuth: number;
  startedAt: string;
  deadlineAt: string;
}

interface RotatorStateSnapshot {
  status: ConnectionStatus;
  config: RotatorConfig;
  position: PositionSnapshot | null;
  lastCommandedAzimuth: number | null;
  caps: RotatorCaps | null;
  portCaps: HamlibPortCaps | null;
  configSchema: HamlibConfigFieldDescriptor[];
  connectionInfo: RotatorConnectionInfo | null;
  rotatorInfo: SupportedRotatorInfo | null;
  hamlibVersion: string | null;
  hardwareInfo: string;
  statusFlags: string[];
  movement: MovementSnapshot | null;
  error: string | null;
  logs: DiagnosticLogEntry[];
}

interface BootstrapResponse {
  state: RotatorStateSnapshot;
  supportedRotators: SupportedRotatorInfo[];
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readNumber(value: unknown, fallback = Number.NaN): number {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback;
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getContextHamlib(ctx: PluginContext): HamlibModuleShape {
  const dependency = (ctx as PluginContext & { hostDependencies?: { hamlib?: HamlibModuleShape } }).hostDependencies?.hamlib;
  if (!dependency?.Rotator) {
    throw new Error('host_hamlib_dependency_unavailable');
  }
  return dependency;
}

class RotatorService {
  private ctx: PluginContext | null = null;
  private rotator: HamlibRotatorInstance | null = null;
  private config: RotatorConfig = DEFAULT_CONFIG;
  private status: ConnectionStatus = 'disconnected';
  private position: PositionSnapshot | null = null;
  private lastCommandedAzimuth: number | null = null;
  private caps: RotatorCaps | null = null;
  private portCaps: HamlibPortCaps | null = null;
  private configSchema: HamlibConfigFieldDescriptor[] = [];
  private connectionInfo: RotatorConnectionInfo | null = null;
  private rotatorInfo: SupportedRotatorInfo | null = null;
  private hamlibVersion: string | null = null;
  private hardwareInfo = '';
  private statusFlags: string[] = [];
  private movement: MovementSnapshot | null = null;
  private error: string | null = null;
  private logs: DiagnosticLogEntry[] = [];
  private hamlib: HamlibModuleShape | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private polling = false;

  attach(ctx: PluginContext): void {
    this.ctx = ctx;
    this.hamlib = getContextHamlib(ctx);
    this.config = coerceRotatorConfig(ctx.store.global.get(CONFIG_KEY, DEFAULT_CONFIG));
    this.log('info', 'service_loaded');
    this.schedulePoll();
  }

  async dispose(): Promise<void> {
    this.ctx?.timers.clear(POLL_TIMER_ID);
    await this.disconnect({ stopFirst: true });
    this.ctx = null;
    this.hamlib = null;
  }

  getSnapshot(): RotatorStateSnapshot {
    return {
      status: this.status,
      config: this.config,
      position: this.position,
      lastCommandedAzimuth: this.lastCommandedAzimuth,
      caps: this.caps,
      portCaps: this.portCaps,
      configSchema: this.configSchema,
      connectionInfo: this.connectionInfo,
      rotatorInfo: this.rotatorInfo,
      hamlibVersion: this.hamlibVersion,
      hardwareInfo: this.hardwareInfo,
      statusFlags: this.statusFlags,
      movement: this.movement,
      error: this.error,
      logs: [...this.logs],
    };
  }

  async getBootstrap(): Promise<BootstrapResponse> {
    return {
      state: this.getSnapshot(),
      supportedRotators: await this.listRotators(),
    };
  }

  async listRotators(): Promise<SupportedRotatorInfo[]> {
    const hamlib = this.requireHamlib();
    this.hamlibVersion = hamlib.Rotator.getHamlibVersion();
    return hamlib.Rotator.getSupportedRotators();
  }

  async saveConfig(input: unknown): Promise<RotatorStateSnapshot> {
    const next = coerceRotatorConfig(input, this.config);
    this.config = next;
    this.ctx?.store.global.set(CONFIG_KEY, next);
    await this.ctx?.store.global.flush();
    this.schedulePoll();
    this.log('info', 'config_saved');
    this.broadcastState();
    return this.getSnapshot();
  }

  async testConnection(input?: unknown): Promise<RotatorStateSnapshot> {
    const config = input === undefined ? this.config : coerceRotatorConfig(input, this.config);
    return this.enqueue('test_connection', async () => {
      const hamlib = this.requireHamlib();
      const rotator = await this.createRotator(hamlib, config);
      try {
        await rotator.open();
        this.hamlibVersion = hamlib.Rotator.getHamlibVersion();
        this.caps = safeRead(() => rotator.getRotatorCaps(), null);
        this.portCaps = safeRead(() => rotator.getPortCaps(), null);
        this.configSchema = safeRead(() => rotator.getConfigSchema(), []);
        this.connectionInfo = safeRead(() => rotator.getConnectionInfo(), null);
        this.hardwareInfo = await safeReadAsync(() => rotator.getInfo(), '');
        const status = await safeReadAsync(() => rotator.getStatus(), null);
        this.statusFlags = status?.flags ?? [];
        await this.readPositionFrom(rotator);
        this.error = null;
        this.log('info', 'test_connection_ok');
      } finally {
        await safeReadAsync(() => rotator.close(), 0);
        safeRead(() => rotator.destroy(), undefined);
      }
      this.broadcastState();
      return this.getSnapshot();
    });
  }

  async connect(): Promise<RotatorStateSnapshot> {
    return this.enqueue('connect', async () => {
      if (this.rotator) {
        await this.disconnect({ stopFirst: false, queued: true });
      }
      this.setStatus('connecting');
      const hamlib = this.requireHamlib();
      const rotator = await this.createRotator(hamlib, this.config);
      await rotator.open();
      this.rotator = rotator;
      this.hamlibVersion = hamlib.Rotator.getHamlibVersion();
      this.caps = safeRead(() => rotator.getRotatorCaps(), null);
      this.portCaps = safeRead(() => rotator.getPortCaps(), null);
      this.configSchema = safeRead(() => rotator.getConfigSchema(), []);
      this.connectionInfo = safeRead(() => rotator.getConnectionInfo(), null);
      this.hardwareInfo = await safeReadAsync(() => rotator.getInfo(), '');
      const status = await safeReadAsync(() => rotator.getStatus(), null);
      this.statusFlags = status?.flags ?? [];
      await this.readPositionFrom(rotator);
      this.setStatus('connected');
      this.error = null;
      this.log('info', 'connected');
      this.schedulePoll();
      this.broadcastState();
      return this.getSnapshot();
    });
  }

  async disconnect(options: { stopFirst?: boolean; queued?: boolean } = {}): Promise<RotatorStateSnapshot> {
    const task = async () => {
      const rotator = this.rotator;
      this.rotator = null;
      this.movement = null;
      if (rotator) {
        if (options.stopFirst) {
          await safeReadAsync(() => rotator.stop(), 0);
        }
        await safeReadAsync(() => rotator.close(), 0);
        safeRead(() => rotator.destroy(), undefined);
      }
      this.connectionInfo = null;
      this.statusFlags = [];
      this.setStatus('disconnected');
      this.log('info', 'disconnected');
      this.broadcastState();
      return this.getSnapshot();
    };
    return options.queued ? task() : this.enqueue('disconnect', task);
  }

  async setAzimuth(targetAzimuth: number): Promise<RotatorStateSnapshot> {
    validateTargetAzimuth(this.config, targetAzimuth);
    return this.enqueue('set_azimuth', async () => {
      const rotator = this.requireRotator();
      validateTargetAzimuth(this.config, targetAzimuth);
      const currentElevation = this.position?.elevation ?? 0;
      const startedAt = new Date();
      this.movement = {
        targetAzimuth,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + this.config.movementTimeoutMs).toISOString(),
      };
      this.lastCommandedAzimuth = targetAzimuth;
      this.position = {
        azimuth: targetAzimuth,
        elevation: currentElevation,
        source: 'last-commanded',
        stale: true,
        updatedAt: new Date().toISOString(),
      };
      this.setStatus('moving');
      await rotator.setPosition(targetAzimuth, currentElevation);
      this.log('info', 'set_position', `${targetAzimuth.toFixed(1)} deg`);
      this.broadcastState();
      await this.pollPosition();
      return this.getSnapshot();
    });
  }

  async nudge(step: number): Promise<RotatorStateSnapshot> {
    const base = this.movement?.targetAzimuth ?? this.lastCommandedAzimuth ?? this.position?.azimuth;
    if (base === null || base === undefined) {
      throw new Error('position_unknown');
    }
    return this.setAzimuth(base + step);
  }

  async moveStart(direction: RotatorDirection, speed: number): Promise<RotatorStateSnapshot> {
    return this.enqueue('move_start', async () => {
      const rotator = this.requireRotator();
      const safeSpeed = Math.max(1, Math.min(100, Math.round(speed)));
      const startedAt = new Date();
      this.movement = {
        targetAzimuth: this.lastCommandedAzimuth ?? this.position?.azimuth ?? 0,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + Math.min(this.config.movementTimeoutMs, 30000)).toISOString(),
      };
      this.setStatus('moving');
      await rotator.move(direction, safeSpeed);
      this.log('warn', 'manual_move_started', `${String(direction)} speed=${safeSpeed}`);
      this.broadcastState();
      return this.getSnapshot();
    });
  }

  async stop(): Promise<RotatorStateSnapshot> {
    return this.enqueue('stop', async () => {
      const rotator = this.rotator;
      if (rotator) {
        await safeReadAsync(() => rotator.stop(), 0);
      }
      this.movement = null;
      this.setStatus(rotator ? 'connected' : 'disconnected');
      this.log('warn', 'stop_sent');
      this.broadcastState();
      await this.pollPosition();
      return this.getSnapshot();
    });
  }

  async park(): Promise<RotatorStateSnapshot> {
    return this.enqueue('park', async () => {
      const rotator = this.requireRotator();
      const startedAt = new Date();
      const parkTarget = this.config.homeAzimuth;
      this.movement = {
        targetAzimuth: parkTarget,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + this.config.movementTimeoutMs).toISOString(),
      };
      try {
        this.setStatus('moving');
        await rotator.park();
        this.lastCommandedAzimuth = parkTarget;
        this.log('warn', 'park_sent');
      } catch (error) {
        this.log('warn', 'park_fallback_set_home', errorMessage(error));
        await rotator.setPosition(parkTarget, this.position?.elevation ?? 0);
        this.lastCommandedAzimuth = parkTarget;
      }
      this.broadcastState();
      await this.pollPosition();
      return this.getSnapshot();
    });
  }

  async reset(): Promise<RotatorStateSnapshot> {
    return this.enqueue('reset', async () => {
      const rotator = this.requireRotator();
      await rotator.reset('ALL');
      this.log('warn', 'reset_sent');
      this.broadcastState();
      await this.pollPosition();
      return this.getSnapshot();
    });
  }

  async handleTimer(timerId: string): Promise<void> {
    if (timerId !== POLL_TIMER_ID) {
      return;
    }
    await this.pollPosition();
  }

  async pollPosition(): Promise<void> {
    if (this.polling || !this.rotator) {
      return;
    }
    this.polling = true;
    try {
      await this.readPositionFrom(this.rotator);
      if (this.status === 'moving' && this.movement && Date.now() > Date.parse(this.movement.deadlineAt)) {
        this.log('error', 'movement_timeout');
        await safeReadAsync(() => this.rotator?.stop() ?? Promise.resolve(0), 0);
        this.movement = null;
        this.setStatus('error', 'movement_timeout');
      } else if (this.status === 'moving' && this.movement && this.position?.source === 'hardware') {
        const delta = angularDistance(this.position.azimuth ?? 0, this.movement.targetAzimuth);
        if (delta <= 2) {
          this.movement = null;
          this.setStatus('connected');
        }
      }
      this.broadcastState();
    } catch (error) {
      this.markPositionStale();
      this.error = errorMessage(error);
      this.log('warn', 'position_poll_failed', this.error);
      this.broadcastState();
    } finally {
      this.polling = false;
    }
  }

  private async createRotator(hamlib: HamlibModuleShape, config: RotatorConfig): Promise<HamlibRotatorInstance> {
    hamlib.Rotator.setDebugLevel(1);
    const port = getConnectionPort(config);
    if (!port) {
      throw new Error(config.connectionMode === 'network' ? 'network_address_required' : 'serial_port_required');
    }
    const rotator = new hamlib.Rotator(config.rotModel, port);
    for (const [name, value] of Object.entries(config.conf)) {
      if (name.trim() && value.trim()) {
        await rotator.setConf(name.trim(), value.trim());
      }
    }
    this.rotatorInfo = hamlib.Rotator.getSupportedRotators().find((entry) => entry.rotModel === config.rotModel) ?? null;
    return rotator;
  }

  private requireRotator(): HamlibRotatorInstance {
    if (!this.rotator) {
      throw new Error('rotator_not_connected');
    }
    return this.rotator;
  }

  private requireHamlib(): HamlibModuleShape {
    if (!this.hamlib) {
      throw new Error('host_hamlib_dependency_unavailable');
    }
    return this.hamlib;
  }

  private async readPositionFrom(rotator: HamlibRotatorInstance): Promise<void> {
    const position = await rotator.getPosition();
    this.position = {
      azimuth: position.azimuth,
      elevation: position.elevation,
      source: 'hardware',
      stale: false,
      updatedAt: new Date().toISOString(),
    };
    this.connectionInfo = safeRead(() => rotator.getConnectionInfo(), this.connectionInfo);
    const status = await safeReadAsync(() => rotator.getStatus(), null);
    this.statusFlags = status?.flags ?? this.statusFlags;
    if (!isAzimuthWithinSoftLimits(position.azimuth, this.config.softMinAz, this.config.softMaxAz)) {
      this.log('warn', 'hardware_position_outside_soft_limits', `${position.azimuth.toFixed(1)} deg`);
    }
  }

  private markPositionStale(): void {
    if (this.position) {
      this.position = { ...this.position, stale: true };
    } else if (this.lastCommandedAzimuth !== null) {
      this.position = {
        azimuth: this.lastCommandedAzimuth,
        elevation: 0,
        source: 'last-commanded',
        stale: true,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  private enqueue<T>(label: string, task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      try {
        return await task();
      } catch (error) {
        this.error = errorMessage(error);
        this.setStatus(this.rotator ? 'error' : 'disconnected', this.error);
        this.log('error', label, this.error);
        this.broadcastState();
        throw error;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private setStatus(status: ConnectionStatus, error: string | null = null): void {
    this.status = status;
    this.error = error;
  }

  private schedulePoll(): void {
    if (!this.ctx) {
      return;
    }
    this.ctx.timers.clear(POLL_TIMER_ID);
    this.ctx.timers.set(POLL_TIMER_ID, this.config.pollIntervalMs);
  }

  private log(level: DiagnosticLogEntry['level'], message: string, detail?: string): void {
    const entry = { timestamp: new Date().toISOString(), level, message, detail };
    this.logs = [entry, ...this.logs].slice(0, MAX_LOG_ENTRIES);
    if (level === 'error') {
      this.ctx?.log.error(message, detail);
    } else if (level === 'warn') {
      this.ctx?.log.warn(message, detail ? { detail } : undefined);
    } else {
      this.ctx?.log.info(message, detail ? { detail } : undefined);
    }
  }

  private broadcastState(): void {
    if (!this.ctx) {
      return;
    }
    for (const session of this.ctx.ui.listActivePageSessions(PAGE_ID)) {
      try {
        this.ctx.ui.pushToSession(session.sessionId, 'stateUpdated', this.getSnapshot());
      } catch (error) {
        this.ctx.log.warn('Failed to push rotator state', { error: errorMessage(error), sessionId: session.sessionId });
      }
    }
  }
}

function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

async function safeReadAsync<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

const service = new RotatorService();

type HamlibPluginDefinition = Omit<PluginDefinition, 'apiVersion' | 'permissions'> & {
  apiVersion: 2;
  permissions: readonly ['host:hamlib'];
};

async function handlePageMessage(action: string, data: unknown): Promise<unknown> {
  const record = readRecord(data);
  switch (action) {
    case 'getBootstrap':
      return service.getBootstrap();
    case 'listRotators':
      return service.listRotators();
    case 'saveConfig':
      return service.saveConfig(record.config ?? data);
    case 'testConnection':
      return service.testConnection(record.config);
    case 'connect':
      if (record.config) {
        await service.saveConfig(record.config);
      }
      return service.connect();
    case 'disconnect':
      return service.disconnect({ stopFirst: true });
    case 'setAzimuth':
      return service.setAzimuth(readNumber(record.azimuth));
    case 'nudge':
      return service.nudge(readNumber(record.step));
    case 'moveStart':
      return service.moveStart(readString(record.direction, 'RIGHT') as RotatorDirection, readNumber(record.speed, 1));
    case 'stop':
      return service.stop();
    case 'park':
      return service.park();
    case 'reset':
      return service.reset();
    case 'getDiagnostics':
      return service.getSnapshot();
    default:
      throw new Error(`unknown_action:${action}`);
  }
}

const plugin: HamlibPluginDefinition = {
  apiVersion: 2,
  name: PLUGIN_NAME,
  version: '0.1.1',
  type: 'utility',
  instanceScope: 'global',
  permissions: ['host:hamlib'],
  description: 'pluginDescription',
  storage: { scopes: ['global'] },
  settings: {
    setupHint: {
      type: 'info',
      default: '',
      label: 'setupHintLabel',
      description: 'setupHintDescription',
      scope: 'global',
    },
  },
  panels: [{
    id: 'rotator-button',
    title: 'rotatorTitle',
    component: 'iframe',
    pageId: PAGE_ID,
    slot: 'radio-control-toolbar',
    icon: 'arrows-rotate',
    openMode: 'popover',
    uiSize: 'lg',
  }],
  ui: {
    dir: 'ui',
    pages: [{
      id: PAGE_ID,
      title: 'rotatorTitle',
      entry: 'rotator.html',
      accessScope: 'operator',
      resourceBinding: 'none',
    }],
  },
  onLoad(ctx: PluginContext) {
    service.attach(ctx);
    ctx.ui.registerPageHandler({
      async onMessage(_pageId: string, action: string, data: unknown, _requestContext: PluginUIRequestContext) {
        return handlePageMessage(action, data);
      },
    });
  },
  async onUnload() {
    await service.dispose();
  },
  hooks: {
    onTimer(timerId) {
      void service.handleTimer(timerId);
    },
  },
};

export {
  angularDistance,
  coerceRotatorConfig,
  isAzimuthWithinSoftLimits,
  normalizeAzimuth,
  requiresLargeStepConfirmation,
  validateTargetAzimuth,
} from './rotator-utils.js';
export default plugin;
