import type {
  HitBoxPort,
  InteractionContext,
  ModelGraph,
  ModelStatePort,
  PointerEventPort,
  RuntimeLogger,
  InteractionSession,
} from './contracts';

export class InteractionRuntime {
  private activeSession: InteractionSession | null = null;

  constructor(
    private readonly graph: ModelGraph,
    private readonly state: ModelStatePort,
    private readonly hitBoxes: readonly HitBoxPort[],
    private readonly logger: RuntimeLogger,
    private readonly context: Omit<InteractionContext, 'graph' | 'state'>,
  ) {}

  dispatch(event: PointerEventPort): boolean {
    if (event.type === 'move' && this.activeSession) {
      this.activeSession.update(event);
      return true;
    }
    if (event.type === 'up' || event.type === 'cancel') {
      this.activeSession?.finish(event.type);
      this.activeSession = null;
      return event.isClaimed();
    }
    const source = this.select(event);
    if (!source || !event.claim(source)) return false;
    this.activeSession = source.start({ ...this.context, graph: this.graph, state: this.state }, event);
    this.logger.debug('interaction started', { id: this.activeSession.id, source: source.id });
    return true;
  }

  private select(event: PointerEventPort) {
    for (const box of event.targetHitBoxes.length > 0 ? event.targetHitBoxes : this.hitBoxes) {
      if (!box.sources.length) continue;
      const source = box.sources.find(candidate => candidate.canStart(
        { ...this.context, graph: this.graph, state: this.state },
        event,
      ));
      if (source) return source;
    }
    return null;
  }
}
