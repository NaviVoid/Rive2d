import type {
  BehaviorTreePort,
  HitBoxBounds,
  HitBoxPort,
  InteractionContext,
  InteractionSession,
  InteractionSource,
  PointerEventPort,
  ScreenPoint,
} from './contracts';

let pointerSequence = 0;

export class PointerEventObject implements PointerEventPort {
  private owner: InteractionSource | null = null;
  private tapPrevented = false;
  private released = false;

  constructor(
    readonly type: PointerEventPort['type'],
    readonly pointerId: number,
    readonly button: number,
    readonly position: ScreenPoint,
    readonly targetHitBoxes: readonly HitBoxPort[],
    readonly timestamp = Date.now(),
    readonly interactionId = `pointer-${++pointerSequence}`,
  ) {}

  claim(owner: InteractionSource): boolean {
    if (this.released || (this.owner && this.owner !== owner)) return false;
    this.owner = owner;
    return true;
  }

  isClaimed(): boolean { return this.owner !== null; }
  preventTap(): void { this.tapPrevented = true; }
  isTapPrevented(): boolean { return this.tapPrevented; }
  release(): void { this.released = true; }
}

export class HitBox implements HitBoxPort {
  private currentBounds: HitBoxBounds | null = null;
  private disposed = false;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly order: number,
    readonly sources: readonly InteractionSource[],
  ) {}

  get bounds(): HitBoxBounds | null { return this.currentBounds; }

  hitTest(point: ScreenPoint): boolean {
    const bounds = this.currentBounds;
    return !this.disposed && bounds !== null
      && point.x >= bounds.x && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
  }

  update(bounds: HitBoxBounds): void { if (!this.disposed) this.currentBounds = { ...bounds }; }
  dispose(): void { this.disposed = true; this.currentBounds = null; }
}

export class ClickInteraction implements InteractionSource {
  readonly id: string;

  constructor(
    readonly hitBoxName: string,
    private readonly route: string,
    private readonly onRequest: (route: string, source: string) => void,
  ) {
    this.id = `click:${hitBoxName}`;
  }

  canStart(_context: InteractionContext, event: PointerEventPort): boolean {
    return event.type === 'tap' && event.button === 0;
  }

  start(_context: InteractionContext, event: PointerEventPort): InteractionSession {
    const id = event.interactionId;
    this.onRequest(this.route, this.id);
    return new CompletedInteractionSession(id);
  }
}

export class DragInteraction implements InteractionSource {
  readonly id: string;

  constructor(
    readonly hitBoxName: string,
    private readonly route: string,
    private readonly onRequest: (route: string, source: string) => void,
  ) {
    this.id = `drag:${hitBoxName}`;
  }

  canStart(_context: InteractionContext, event: PointerEventPort): boolean {
    return event.type === 'down' && event.button === 0;
  }

  start(_context: InteractionContext, event: PointerEventPort): InteractionSession {
    event.preventTap();
    this.onRequest(this.route, this.id);
    return new CompletedInteractionSession(event.interactionId);
  }
}

export class KeyTriggerInteraction implements InteractionSource {
  readonly id: string;
  constructor(
    readonly hitBoxName: string,
    private readonly key: string,
    private readonly onRequest: (route: string, source: string) => void,
    private readonly route: string,
  ) {
    this.id = `key:${key}:${hitBoxName}`;
  }

  canStart(_context: InteractionContext, event: PointerEventPort): boolean {
    return event.type === 'tap' && event.button === 0;
  }

  start(_context: InteractionContext, event: PointerEventPort): InteractionSession {
    this.onRequest(this.route, this.id);
    return new CompletedInteractionSession(event.interactionId);
  }
}

export class ChoiceInteraction implements InteractionSource {
  readonly id: string;
  constructor(
    readonly hitBoxName: string,
    private readonly choiceId: string,
    private readonly onSelect: (choiceId: string) => void,
  ) {
    this.id = `choice:${choiceId}:${hitBoxName}`;
  }

  canStart(_context: InteractionContext, event: PointerEventPort): boolean {
    return event.type === 'tap' && event.button === 0;
  }

  start(_context: InteractionContext, event: PointerEventPort): InteractionSession {
    this.onSelect(this.choiceId);
    return new CompletedInteractionSession(event.interactionId);
  }
}

class CompletedInteractionSession implements InteractionSession {
  constructor(readonly id: string) {}
  update(_event: PointerEventPort): void {}
  finish(_reason: string): void {}
}

export function hitBoxesAt(boxes: readonly HitBoxPort[], point: ScreenPoint): HitBoxPort[] {
  return boxes.filter(box => box.hitTest(point)).sort((a, b) => b.order - a.order);
}

export function createInteractionContext(
  behaviorTree: BehaviorTreePort,
  graph: InteractionContext['graph'],
  state: InteractionContext['state'],
): InteractionContext {
  return { behaviorTree, graph, state, logger: { debug() {}, info() {}, warn() {}, error() {} } };
}
