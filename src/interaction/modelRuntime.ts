import { CommandRuntime } from './commandRuntime';
import { BehaviorTreeBuilder } from './behaviorTree';
import { TypedEventBus } from './events';
import { ClickInteraction, DragInteraction, HitBox, PointerEventObject } from './hitAreaInteraction';
import { ConsoleRuntimeLogger } from './logger';
import { JsonModelGraphBuilder } from './modelGraph';
import { AnimationPlayer, type MotionDispatcher } from './motionRuntime';
import { ModelStateStore } from './stateStore';
import type {
  BehaviorTreePort,
  HitBoxPort,
  ModelAdapter,
  ModelGraph,
  ModelStatePort,
  MotionHandle,
  MotionPlayOptions,
  RuntimeLogger,
  ScreenPoint,
} from './contracts';
import type { ModelRuntimeEvents } from './events';

export type ModelLifecycle = 'created' | 'loading' | 'ready' | 'interacting' | 'disposed';

export class ModelStateMachine {
  private current: ModelLifecycle = 'created';

  get state(): ModelLifecycle { return this.current; }

  transition(next: ModelLifecycle): void {
    if (this.current === 'disposed' && next !== 'disposed') throw new Error('disposed model cannot transition');
    this.current = next;
  }
}

export class Live2DModelObject {
  constructor(
    readonly id: string,
    readonly adapter: ModelAdapter,
    readonly graph: ModelGraph,
    readonly state: ModelStatePort,
    readonly hitBoxes: readonly HitBoxPort[],
  ) {}
}

export interface ModelRuntimeOptions {
  readonly id: string;
  readonly rawJson: unknown;
  readonly dispatchMotion: MotionDispatcher['dispatch'];
  readonly hitTest?: (point: ScreenPoint) => readonly HitBoxPort[];
  readonly logger?: RuntimeLogger;
  /** Set false when the injected legacy player already interprets commands. */
  readonly executeCommands?: boolean;
  readonly resolveHitRoute?: (hitAreaName: string) => string | null | undefined;
  readonly isDragHitArea?: (hitAreaName: string) => boolean;
}

export class ModelRuntime {
  readonly events = new TypedEventBus<ModelRuntimeEvents>();
  readonly stateMachine = new ModelStateMachine();
  readonly state = new ModelStateStore();
  readonly graph: ModelGraph;
  readonly model: Live2DModelObject;
  readonly behaviorTree: BehaviorTreePort;

  private readonly logger: RuntimeLogger;
  private readonly animationPlayer: AnimationPlayer;
  private readonly treeBuilder: BehaviorTreeBuilder;
  private disposed = false;

  constructor(options: ModelRuntimeOptions) {
    this.logger = options.logger ?? new ConsoleRuntimeLogger(`model:${options.id}`);
    this.graph = new JsonModelGraphBuilder().build(options.rawJson);
    this.animationPlayer = new AnimationPlayer({ dispatch: options.dispatchMotion }, this.logger);
    this.treeBuilder = new BehaviorTreeBuilder(new CommandRuntime(this.logger), {
      executeCommands: options.executeCommands,
    });
    const hitBoxes = this.createHitBoxes(options.resolveHitRoute, options.isDragHitArea);
    const adapter: ModelAdapter = {
      id: options.id,
      dispatchMotion: (route, motionOptions) => this.animationPlayer.play(route, motionOptions),
      hitTest: options.hitTest ?? (() => hitBoxes),
    };
    this.model = new Live2DModelObject(options.id, adapter, this.graph, this.state, hitBoxes);
    this.behaviorTree = this.treeBuilder.build(this.graph, this.graph.findMotion('Idle', 0) ?? {
      raw: 'Idle', group: 'Idle', key: 'Idle', entry: null,
    });
    this.stateMachine.transition('loading');
    this.stateMachine.transition('ready');
    this.logger.info('model runtime ready', {
      motions: this.graph.motions.size,
      hitAreas: this.graph.hitAreas.length,
      init: this.graph.findInitEntry()?.key,
    });
  }

  async requestMotion(reference: string, source: string): Promise<boolean> {
    const route = this.graph.resolve(reference);
    if (!route) {
      this.logger.debug('motion reference not found', { reference, source });
      return false;
    }
    const tree = this.treeBuilder.build(this.graph, route);
    this.events.emit('motion-requested', { route: route.key, source });
    const result = await tree.execute({
      graph: this.graph,
      state: this.state,
      motionPlayer: this.animationPlayer,
      logger: this.logger,
      source,
    });
    if (result.executed) this.events.emit('motion-started', { route: route.key, source });
    return result.executed;
  }

  handleHit(type: 'down' | 'tap', names: readonly string[], button = 0): boolean {
    if (this.disposed || this.stateMachine.state === 'disposed') return false;
    const boxes = names
      .map(name => this.model.hitBoxes.find(box => box.name === name))
      .filter((box): box is HitBoxPort => box !== undefined);
    const event = new PointerEventObject(type, 0, button, { x: 0, y: 0 }, boxes);
    const context = {
      graph: this.graph,
      state: this.state,
      behaviorTree: this.behaviorTree,
      logger: this.logger,
    };
    for (const box of boxes) {
      for (const source of box.sources) {
        if (!source.canStart(context, event) || !event.claim(source)) continue;
        source.start(context, event).finish('completed');
        this.stateMachine.transition('interacting');
        return true;
      }
    }
    return false;
  }

  dispatchMotion(route: Parameters<ModelAdapter['dispatchMotion']>[0], options?: MotionPlayOptions): Promise<MotionHandle> {
    return this.animationPlayer.play(route, options);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stateMachine.transition('disposed');
    this.events.clear();
    for (const box of this.model.hitBoxes) box.dispose();
  }

  private createHitBoxes(
    resolveHitRoute?: (hitAreaName: string) => string | null | undefined,
    isDragHitArea?: (hitAreaName: string) => boolean,
  ): readonly HitBoxPort[] {
    return this.graph.hitAreas.map(area => {
      const configuredRoute = resolveHitRoute?.(area.name);
      const route = configuredRoute === '__none__'
        ? null
        : configuredRoute ?? area.motion ?? this.conventionFor(area.name);
      if (!route) return new HitBox(`hit:${area.name}`, area.name, area.order, []);
      const Interaction = isDragHitArea?.(area.name) ? DragInteraction : ClickInteraction;
      const source = new Interaction(area.name, route, (reference, sourceId) => {
        void this.requestMotion(reference, sourceId);
      });
      return new HitBox(`hit:${area.name}`, area.name, area.order, [source]);
    });
  }

  private conventionFor(name: string): string | null {
    const candidates = [`tap_${name}`, name, `Tap${name}`, name.replace(/^Touch/i, '').toLowerCase()];
    return candidates.find(candidate => this.graph.findMotion(candidate) !== null) ?? null;
  }
}
