import type {
  InteractionContext,
  InteractionSession,
  InteractionSource,
  PointerEventPort,
} from './contracts';

export interface ParameterTarget {
  readonly id: string;
  readonly axis?: 0 | 1;
  readonly factor?: number;
  readonly min?: number;
  readonly max?: number;
}

abstract class ParameterInteraction implements InteractionSource {
  abstract readonly id: string;

  constructor(readonly hitBoxName: string, protected readonly target: ParameterTarget) {}

  canStart(_context: InteractionContext, event: PointerEventPort): boolean {
    return event.type === 'down' && event.button === 0;
  }

  start(context: InteractionContext, event: PointerEventPort): InteractionSession {
    event.preventTap();
    const startedAt = Date.now();
    const startPosition = event.position;
    return new ParameterSession(
      event.interactionId,
      this.target,
      startPosition,
      (value) => context.state.setParameter(this.target.id, value),
      () => context.state.unlockParameter(this.target.id),
    );
  }
}

export class ParamHitInteraction extends ParameterInteraction {
  readonly id: string;
  constructor(hitBoxName: string, target: ParameterTarget) {
    super(hitBoxName, target);
    this.id = `param-hit:${hitBoxName}:${target.id}`;
  }
}

class ParameterSession implements InteractionSession {
  constructor(
    readonly id: string,
    private readonly target: ParameterTarget,
    private readonly startPosition: { readonly x: number; readonly y: number },
    private readonly write: (value: number) => void,
    private readonly release: () => void,
  ) {}

  update(event: PointerEventPort): void {
    const axis = this.target.axis ?? 0;
    const delta = (axis === 0 ? event.position.x - this.startPosition.x : event.position.y - this.startPosition.y)
      * (this.target.factor ?? 0.01);
    const min = this.target.min ?? -1;
    const max = this.target.max ?? 1;
    this.write(Math.max(min, Math.min(max, delta)));
  }

  finish(_reason: string): void { this.release(); }
}
