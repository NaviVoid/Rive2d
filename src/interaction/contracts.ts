export type JsonRecord = Record<string, unknown>;

export interface RuntimeLogger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export type EventMap = object;

export interface EventBus<Events extends EventMap> {
  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void;
  emit<K extends keyof Events>(event: K, payload: Events[K]): void;
  clear(): void;
}

export interface MotionReference {
  readonly raw: string;
  readonly group: string;
  readonly name?: string;
  readonly index?: number;
}

export interface ResolvedMotionRoute extends MotionReference {
  readonly key: string;
  readonly entry: MotionEntry | null;
}

export interface MotionEntry {
  readonly name?: string;
  readonly file?: string;
  readonly nextMtn?: string;
  readonly postCommand?: string;
  readonly command?: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly fileLoop?: boolean;
  readonly wrapMode?: number;
  readonly varFloats: readonly JsonRecord[];
  readonly conditions: readonly JsonRecord[];
  readonly [key: string]: unknown;
}

export interface HitAreaDefinition {
  readonly name: string;
  readonly id?: string;
  readonly motion?: string;
  readonly pressAction?: string;
  readonly releaseAction?: string;
  readonly enterAction?: string;
  readonly exitAction?: string;
  readonly clickableWhenInvisible: boolean;
  readonly order: number;
  readonly enabled: boolean;
}

export interface ControllerDefinition {
  readonly name: string;
  readonly enabled: boolean;
  readonly items: readonly JsonRecord[];
}

export interface ModelGraph {
  readonly motions: ReadonlyMap<string, readonly MotionEntry[]>;
  readonly hitAreas: readonly HitAreaDefinition[];
  readonly controllers: ReadonlyMap<string, ControllerDefinition>;
  resolve(reference: string): ResolvedMotionRoute | null;
  findMotion(group: string, index?: number): ResolvedMotionRoute | null;
  findInitEntry(): ResolvedMotionRoute | null;
  findIdleGroup(): string | null;
  getHitArea(name: string): HitAreaDefinition | null;
}

export interface StateSnapshot {
  readonly variables: ReadonlyMap<string, number>;
  readonly parameters: ReadonlyMap<string, number>;
  readonly locks: ReadonlyMap<string, number>;
  readonly disabledMotionGroups: ReadonlySet<string>;
  readonly disabledHitAreas: boolean;
}

export interface ModelStatePort {
  getVariable(name: string): number | undefined;
  setVariable(name: string, value: number): void;
  getParameter(name: string): number | undefined;
  setParameter(name: string, value: number): void;
  lockParameter(name: string, value?: number): void;
  unlockParameter(name: string): void;
  isParameterLocked(name: string): boolean;
  setMotionGroupEnabled(group: string, enabled: boolean): void;
  setHitAreasEnabled(enabled: boolean): void;
  snapshot(): StateSnapshot;
  restore(snapshot: StateSnapshot): void;
}

export interface MotionPlayOptions {
  readonly priority?: number;
  readonly loop?: boolean;
  readonly source?: string;
}

export interface MotionHandle {
  readonly id: string;
  readonly route: ResolvedMotionRoute;
  readonly started: boolean;
  cancel(reason?: string): void;
}

export interface MotionPlayer {
  play(route: ResolvedMotionRoute, options?: MotionPlayOptions): Promise<MotionHandle>;
}

export interface BehaviorContext {
  readonly graph: ModelGraph;
  readonly state: ModelStatePort;
  readonly motionPlayer: MotionPlayer;
  readonly logger: RuntimeLogger;
  readonly source: string;
}

export interface BehaviorResult {
  readonly executed: boolean;
  readonly reason?: string;
  readonly handle?: MotionHandle;
}

export interface BehaviorNode {
  readonly id: string;
  execute(context: BehaviorContext): Promise<BehaviorResult>;
  cancel(reason?: string): void;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface HitBoxBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PointerEventPort {
  readonly interactionId: string;
  readonly pointerId: number;
  readonly type: 'down' | 'move' | 'up' | 'cancel' | 'tap';
  readonly button: number;
  readonly position: ScreenPoint;
  readonly timestamp: number;
  readonly targetHitBoxes: readonly HitBoxPort[];
  claim(owner: InteractionSource): boolean;
  isClaimed(): boolean;
  preventTap(): void;
  isTapPrevented(): boolean;
  release(): void;
}

export interface HitBoxPort {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly sources: readonly InteractionSource[];
  readonly bounds: HitBoxBounds | null;
  hitTest(point: ScreenPoint): boolean;
  update(bounds: HitBoxBounds): void;
  dispose(): void;
}

export interface InteractionContext {
  readonly graph: ModelGraph;
  readonly state: ModelStatePort;
  readonly behaviorTree: BehaviorTreePort;
  readonly logger: RuntimeLogger;
}

export interface InteractionSession {
  readonly id: string;
  update(event: PointerEventPort): void;
  finish(reason: string): void;
}

export interface InteractionSource {
  readonly id: string;
  readonly hitBoxName: string;
  canStart(context: InteractionContext, event: PointerEventPort): boolean;
  start(context: InteractionContext, event: PointerEventPort): InteractionSession;
}

export interface BehaviorTreePort {
  execute(context: BehaviorContext): Promise<BehaviorResult>;
  cancel(reason?: string): void;
}

export interface ModelAdapter {
  readonly id: string;
  dispatchMotion(route: ResolvedMotionRoute, options?: MotionPlayOptions): Promise<MotionHandle>;
  hitTest(point: ScreenPoint): readonly HitBoxPort[];
  setInputRegion?(enabled: boolean): void;
}
