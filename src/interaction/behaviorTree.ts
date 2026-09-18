import { ConditionEvaluator } from './conditions';
import { CommandRuntime } from './commandRuntime';
import type {
  BehaviorContext,
  BehaviorNode,
  BehaviorResult,
  BehaviorTreePort,
  ModelGraph,
  MotionEntry,
  ResolvedMotionRoute,
} from './contracts';

abstract class BaseNode implements BehaviorNode {
  private stopped = false;

  constructor(readonly id: string) {}

  abstract execute(context: BehaviorContext): Promise<BehaviorResult>;

  cancel(): void { this.stopped = true; }
  protected isCancelled(): boolean { return this.stopped; }
}

export class ConditionNode extends BaseNode {
  constructor(id: string, private readonly predicate: (context: BehaviorContext) => boolean) { super(id); }

  async execute(context: BehaviorContext): Promise<BehaviorResult> {
    const executed = this.predicate(context);
    return executed ? { executed: true } : { executed: false, reason: `condition:${this.id}` };
  }
}

export class CommandNode extends BaseNode {
  constructor(id: string, private readonly command: string | undefined, private readonly runtime: CommandRuntime) { super(id); }

  async execute(context: BehaviorContext): Promise<BehaviorResult> {
    if (this.isCancelled()) return { executed: false, reason: 'cancelled' };
    this.runtime.execute(this.command, context.state);
    return { executed: true };
  }
}

export class AnimationNode extends BaseNode {
  constructor(id: string, private readonly route: ResolvedMotionRoute) { super(id); }

  async execute(context: BehaviorContext): Promise<BehaviorResult> {
    if (this.isCancelled()) return { executed: false, reason: 'cancelled' };
    const handle = await context.motionPlayer.play(this.route, {
      priority: this.route.entry?.priority,
      loop: this.route.entry?.fileLoop ?? this.route.entry?.wrapMode === 1,
      source: context.source,
    });
    return handle.started ? { executed: true, handle } : { executed: false, reason: 'motion-rejected', handle };
  }
}

export class SequenceNode extends BaseNode {
  constructor(id: string, private readonly nodes: readonly BehaviorNode[]) { super(id); }

  async execute(context: BehaviorContext): Promise<BehaviorResult> {
    let last: BehaviorResult = { executed: true };
    for (const node of this.nodes) {
      if (this.isCancelled()) return { executed: false, reason: 'cancelled' };
      last = await node.execute(context);
      if (!last.executed) return last;
    }
    return last;
  }
}

export class BehaviorTree implements BehaviorTreePort {
  constructor(private readonly root: BehaviorNode) {}
  execute(context: BehaviorContext): Promise<BehaviorResult> { return this.root.execute(context); }
  cancel(reason = 'cancelled'): void { this.root.cancel(reason); }
}

export class BehaviorTreeBuilder {
  private readonly conditions = new ConditionEvaluator();

  constructor(
    private readonly commandRuntime: CommandRuntime,
    private readonly options: { readonly executeCommands?: boolean } = {},
  ) {}

  build(graph: ModelGraph, route: ResolvedMotionRoute): BehaviorTree {
    const entry: MotionEntry | null = route.entry;
    const nodes: BehaviorNode[] = [
      new ConditionNode(`${route.key}:eligible`, context => {
        // A group-only reference (for example `head` or `body`) is a valid
        // weighted route. The legacy motion gateway selects its eligible
        // entry when the animation node dispatches the group.
        if (entry === null) return route.index === undefined && graph.motions.has(route.group);
        return this.conditions.evaluate(entry, context.state);
      }),
    ];
    const executeCommands = this.options.executeCommands !== false;
    if (executeCommands && entry?.command) {
      nodes.push(new CommandNode(`${route.key}:command`, entry.command, this.commandRuntime));
    }
    // The motion player also dispatches command-only entries. This keeps a
    // command route in the same behavior tree as a file-backed animation.
    // A group-only route is also a valid animation node; the dispatcher picks
    // its eligible weighted entry when the group is played.
    const isGroupRoute = entry === null && route.index === undefined && graph.motions.has(route.group);
    if (entry || isGroupRoute) nodes.push(new AnimationNode(`${route.key}:animation`, route));
    // PostCommand belongs to the animation completion callback. Running it in
    // this sequence would execute it as soon as dispatch succeeds, before the
    // motion has finished.
    if (nodes.length === 1) nodes.push(new ConditionNode(`${route.key}:exists`, () => false));
    return new BehaviorTree(new SequenceNode(`${route.key}:sequence`, nodes));
  }
}
