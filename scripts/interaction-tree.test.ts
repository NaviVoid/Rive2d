import { ModelRuntime } from '../src/interaction/modelRuntime';
import { JsonModelGraphBuilder } from '../src/interaction/modelGraph';
import { ConditionEvaluator } from '../src/interaction/conditions';
import { ModelStateStore } from '../src/interaction/stateStore';
import type { JsonRecord, RuntimeLogger } from '../src/interaction/contracts';

const logger: RuntimeLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
}

function deepEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

const rawJson = {
  FileReferences: {
    Motions: {
      head: [{ File: 'head.json', Name: 'touch_head', VarFloats: [{ Name: 'idle', Type: 1, Code: 'equal 0' }] }],
      special: [{ File: 'special.json', Name: 'touch_special', VarFloats: [{ Name: 'idle', Type: 1, Code: 'equal 0' }] }],
      body: [{ File: 'body.json', Name: 'touch_body', VarFloats: [{ Name: 'idle', Type: 1, Code: 'equal 0' }] }],
      touch_idle: [{ File: 'idle1.json', Name: 'touch_idle1', VarFloats: [{ Name: 'idle', Type: 1, Code: 'not_equal -1' }] }],
    },
  },
  HitAreas: [
    { Id: 'Head', Name: 'TouchHead', Motion: 'head' },
    { Id: 'Special', Name: 'TouchSpecial', Motion: 'special' },
    { Id: 'Body', Name: 'TouchBody', Motion: 'body' },
    { Id: 'Idle', Name: 'TouchIdle1', Motion: 'touch_idle:touch_idle1' },
  ],
} satisfies JsonRecord;

const graph = new JsonModelGraphBuilder().build(rawJson);

equal(graph.resolve('head')?.entry, null, 'group references keep selection deferred');
equal(graph.resolve('head')?.index, undefined, 'group references have no fixed index');
equal(graph.resolve('touch_idle:touch_idle1')?.index, 0, 'named references resolve to an index');

const evaluator = new ConditionEvaluator();
const state = new ModelStateStore();
const head = graph.findMotion('head', 0)?.entry;
assert(head, 'head motion entry exists');
equal(evaluator.evaluate(head, state), true, 'missing model variables use the runtime default of zero');
state.setVariable('idle', 1);
equal(evaluator.evaluate(head, state), false, 'head motion is gated by idle equal 0');

const dispatched: string[] = [];
const runtime = new ModelRuntime({
  id: 'test-model',
  rawJson,
  logger,
  executeCommands: false,
  resolveHitRoute: name => ({
    TouchHead: 'head',
    TouchSpecial: 'special',
    TouchBody: 'body',
    TouchIdle1: 'touch_idle:0',
  }[name]),
  dispatchMotion: async route => {
    dispatched.push(`${route.group}:${route.index ?? 'group'}`);
    return true;
  },
});

async function main(): Promise<void> {
  equal(runtime.handleHit('tap', ['TouchHead']), true, 'TouchHead hit is accepted');
  equal(runtime.handleHit('tap', ['TouchSpecial']), true, 'TouchSpecial hit is accepted');
  equal(runtime.handleHit('tap', ['TouchBody']), true, 'TouchBody hit is accepted');
  await new Promise(resolve => setTimeout(resolve, 0));
  deepEqual(dispatched, ['head:group', 'special:group', 'body:group'], 'group routes are dispatched');

  console.log('interaction tree checks passed');
}

void main();
