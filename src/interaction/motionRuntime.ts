import type {
  BehaviorContext,
  MotionHandle,
  MotionPlayer,
  MotionPlayOptions,
  ModelGraph,
  ResolvedMotionRoute,
  RuntimeLogger,
} from './contracts';

export interface MotionDispatcher {
  dispatch(route: ResolvedMotionRoute, options?: MotionPlayOptions): Promise<boolean>;
}

export class AnimationAsset {
  constructor(
    readonly file: string,
    readonly loop: boolean,
  ) {}
}

export class AnimationInstance {
  readonly startedAt = Date.now();
  private cancelled = false;

  constructor(readonly asset: AnimationAsset, readonly route: ResolvedMotionRoute) {}

  cancel(): void { this.cancelled = true; }
  isCancelled(): boolean { return this.cancelled; }
}

export class AnimationPlayer implements MotionPlayer {
  private sequence = 0;

  constructor(
    private readonly dispatcher: MotionDispatcher,
    private readonly logger: RuntimeLogger,
  ) {}

  async play(route: ResolvedMotionRoute, options: MotionPlayOptions = {}): Promise<MotionHandle> {
    const asset = new AnimationAsset(route.entry?.file ?? '', options.loop ?? false);
    const instance = new AnimationInstance(asset, route);
    const id = `animation-${++this.sequence}`;
    const started = await this.dispatcher.dispatch(route, options);
    this.logger.debug('animation dispatch', { id, route: route.key, started, source: options.source });
    return {
      id,
      route,
      started,
      cancel: (reason = 'cancelled') => {
        instance.cancel();
        this.logger.debug('animation cancelled', { id, reason });
      },
    };
  }
}

export class CommandAnimation implements MotionPlayer {
  constructor(
    private readonly player: MotionPlayer,
    private readonly graph: ModelGraph,
  ) {}

  play(route: ResolvedMotionRoute, options?: MotionPlayOptions): Promise<MotionHandle> {
    if (route.entry?.file) return this.player.play(route, options);
    return Promise.resolve({
      id: `command-${route.key}`,
      route,
      started: true,
      cancel: () => undefined,
    });
  }

  resolveNext(route: ResolvedMotionRoute): ResolvedMotionRoute | null {
    return route.entry?.nextMtn ? this.graph.resolve(route.entry.nextMtn) : null;
  }
}

export class LayerAnimation implements MotionPlayer {
  constructor(private readonly players: readonly MotionPlayer[]) {}

  async play(route: ResolvedMotionRoute, options?: MotionPlayOptions): Promise<MotionHandle> {
    const handles = await Promise.all(this.players.map(player => player.play(route, options)));
    const first = handles[0];
    return first ?? {
      id: `layer-${route.key}`,
      route,
      started: false,
      cancel: () => undefined,
    };
  }
}

export function motionContext(context: BehaviorContext, source: string): BehaviorContext {
  return { ...context, source };
}
