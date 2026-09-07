import {
  Observable, Subscriber, Subscription, asyncScheduler, combineLatest, defer, from, interval,
  map, filter, scan, take, delay, debounceTime, switchMap, shareReplay, timer,
  type SchedulerLike,
} from 'rxjs';
import {
  createSynchronousAdapter, createEvaluationFrame, createLogicalClock,
  type TypeRef, type CompiledExpression, type EvaluationFrame,
} from '@rxjs-rsl/synchronous-evaluator-adapter';
import { invariant, validateGraph, type Graph, type GraphNode } from './model.js';

const NUMBER: TypeRef = { kind: 'primitive', name: 'number' };
const BOOLEAN: TypeRef = { kind: 'primitive', name: 'boolean' };
const UNKNOWN: TypeRef = { kind: 'primitive', name: 'unknown' };
const valueType = (name: unknown): TypeRef => {
  invariant(['number', 'string', 'boolean', 'json'].includes(String(name)), 'Value type must be number, string, boolean, or json');
  return name === 'json' ? UNKNOWN : { kind: 'primitive', name: name as 'number' | 'string' | 'boolean' };
};
function checkValue(value: unknown, type: TypeRef): void {
  if (type.kind === 'primitive' && type.name !== 'unknown') invariant(typeof value === type.name, 'Value does not match declared ' + type.name + ' type');
}
function numeric(node: GraphNode, key: string, minimum = 0, integer = false): number {
  const value = node.parameters[key];
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= 2_147_483_647 && (!integer || Number.isInteger(value)), node.id + ': invalid ' + key);
  return value;
}
export type CompiledGraph = Readonly<{ graph: Graph; types: ReadonlyMap<string, TypeRef>; expressions: ReadonlyMap<string, CompiledExpression> }>;

/** Compilation validates descriptions and expressions. It never subscribes. */
export function compileGraph(input: unknown): CompiledGraph {
  const graph = validateGraph(input);
  const adapter = createSynchronousAdapter({ helperRegistryVersion: 'rxjs-red/0.1' });
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const types = new Map<string, TypeRef>();
  const expressions = new Map<string, CompiledExpression>();
  function compileNode(node: GraphNode): TypeRef {
    if (types.has(node.id)) return types.get(node.id)!;
    const inputs = node.inputs.map(p => compileNode(nodes.get(p.from)!));
    let output: TypeRef = inputs[0] ?? UNKNOWN;
    if (node.operation === 'values') {
      output = valueType(node.parameters.valueType);
      invariant(Array.isArray(node.parameters.values) && node.parameters.values.length <= 10000, node.id + ': values must be an array of at most 10000 packages');
      for (const value of node.parameters.values) checkValue(value, output);
      numeric(node, 'periodMs');
    } else if (node.operation === 'interval') {
      output = NUMBER; numeric(node, 'periodMs', 1);
      if (node.parameters.count !== null) numeric(node, 'count', 0, true);
    } else if (node.operation === 'combineLatest') {
      output = { kind: 'tuple', items: inputs };
    } else if (node.operation === 'take') numeric(node, 'count', 0, true);
    else if (node.operation === 'delay' || node.operation === 'debounceTime') numeric(node, 'durationMs');
    if (['map', 'scan', 'switchMap'].includes(node.operation)) output = valueType(node.parameters.valueType);
    if (node.operation === 'scan') {
      invariant('seed' in node.parameters, node.id + ': scan seed is required');
      checkValue(node.parameters.seed, output);
    }
    if (node.operation === 'switchMap') {
      invariant(node.parameters.worker === 'delayedValue', 'This prototype supports the named delayedValue Worker');
      numeric(node, 'durationMs');
    }
    if (['map', 'filter', 'scan', 'switchMap'].includes(node.operation)) {
      invariant(typeof node.parameters.expression === 'string', node.id + ': expression required');
      const state = node.operation === 'scan' ? { index: NUMBER, total: output } : { index: NUMBER };
      expressions.set(node.id, adapter.compile({
        profile: 'rsl.expression-context/0.1', dialect: 'rsl.jsonata.core-1', QueryLanguage: 'JSONata',
        slot: node.operation === 'filter' ? 'guard' : node.operation === 'scan' ? 'transition' : 'emitNext',
        mode: 'expression', value: node.parameters.expression,
        expectedType: node.operation === 'filter' ? BOOLEAN : output,
        context: { parameters: {}, state, locals: {}, bindings: {}, clock: graph.clock, sharedConnection: false,
          event: { source: 'input', kind: 'next', valueType: inputs[0]! } },
        types: {}, helpers: {}, location: { file: graph.id, fieldPath: '/nodes/' + node.id + '/parameters/expression' },
      }));
    }
    types.set(node.id, output); return output;
  }
  for (const node of graph.nodes) compileNode(node);
  return { graph, types, expressions };
}

export type TraceEvent = Readonly<{
  sequence: number; executionId: string; nodeId: string; subscriptionId: string;
  time: number; kind: string; value?: unknown; error?: unknown; context?: unknown;
}>;
export type ExecutionStatus = 'running' | 'completed' | 'errored' | 'cancelled';
export type ExecutionOptions = {
  id: string;
  scheduler?: SchedulerLike;
  trace?: (event: TraceEvent) => void;
  next?: (sinkId: string, value: unknown) => void;
  status?: (status: ExecutionStatus) => void;
  /** Trusted host/test source factories; never exposed through HTTP or JSONata. */
  sources?: Readonly<Record<string, () => Observable<unknown>>>;
};
export type Execution = { id: string; readonly status: ExecutionStatus; cancel: () => void };
export function errorView(error: unknown): unknown {
  const cause = error instanceof Error && error.cause && typeof error.cause === 'object' ? error.cause as { code?: unknown; message?: unknown } : undefined;
  return error instanceof Error ? { name: error.name, message: error.message,
    ...(cause ? { cause: { code: typeof cause.code === 'string' ? cause.code : undefined, message: typeof cause.message === 'string' ? cause.message : undefined } } : {}),
    ...('diagnostic' in error ? { diagnostic: error.diagnostic } : {}) } : { message: String(error) };
}

/** Named Observable-producing Worker. The scheduler supplies time; unsubscribe cancels its timer. */
export function delayedValue(value: unknown, durationMs: number, scheduler: SchedulerLike): Observable<unknown> {
  return timer(durationMs, scheduler).pipe(map(() => value));
}

/** One call starts one workflow execution. Every sink is a separate subscription. */
export function startExecution(compiled: CompiledGraph, options: ExecutionOptions): Execution {
  const { graph, expressions } = compiled;
  const scheduler = options.scheduler ?? asyncScheduler;
  const epoch = scheduler.now();
  const clock = createLogicalClock(graph.clock.id, graph.clock.unit, () => scheduler.now() - epoch);
  const root = new Subscription();
  let status: ExecutionStatus = 'running';
  let sequence = 0; let subscriptionSequence = 0;
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const streams = new Map<string, Observable<unknown>>();
  const sinks = graph.nodes.filter(n => n.role === 'Sink');
  let remaining = sinks.length;
  const publish = (nodeId: string, subscriptionId: string, kind: string, details: Partial<TraceEvent> = {}) => {
    options.trace?.({ sequence: sequence++, executionId: options.id, nodeId, subscriptionId, time: clock.sample(), kind, ...details });
  };
  const finish = (next: ExecutionStatus) => {
    if (status !== 'running') return;
    status = next;
    root.unsubscribe();
    options.status?.(status);
  };
  type Scope = { id: string; index: number; total?: unknown };
  const evaluate = (node: GraphNode, scope: Scope, value: unknown): unknown => {
    const state = node.operation === 'scan' ? { index: scope.index, total: scope.total } : { index: scope.index };
    const frame: EvaluationFrame = createEvaluationFrame({
      phase: node.operation === 'scan' ? 'transition' : 'reaction', parameters: {}, state, local: {},
      notification: { source: 'input', inputIndex: 0, kind: 'next', value, time: clock.sample(), sequence, contextId: graph.clock.id },
      clock, executionId: options.id, operatorId: node.id, subscription: { id: scope.id, closed: root.closed },
      reaction: 'input.next', action: node.operation,
    });
    publish(node.id, scope.id, 'reaction', { value, context: frame.bindings.rsl });
    const result = expressions.get(node.id)!.evaluate(frame);
    if (node.operation === 'scan') {
      publish(node.id, scope.id, 'state', { context: { before: { total: scope.total }, after: { total: result } } });
      scope.total = result;
    }
    scope.index++;
    return result;
  };
  function instrument(nodeId: string, create: (scope: Scope) => Observable<unknown>, innerStream = false): Observable<unknown> {
    return new Observable(destination => {
      const id = options.id + '/s' + subscriptionSequence++;
      const scope: Scope = { id, index: 0 };
      let terminal = false;
      const prefix = innerStream ? 'inner.' : '';
      publish(nodeId, id, prefix + 'subscribe');
      destination.add(() => {
        if (!terminal) publish(nodeId, id, prefix + 'unsubscribe');
        publish(nodeId, id, prefix + 'finalize');
      });
      // Link teardown BEFORE source.subscribe: take(1) also stops a synchronous source.
      const subscriber = new Subscriber<unknown>({
        next(value) { publish(nodeId, id, prefix + 'next', { value }); destination.next(value); },
        error(error: unknown) { terminal = true; publish(nodeId, id, prefix + 'error', { error: errorView(error) }); destination.error(error); },
        complete() { terminal = true; publish(nodeId, id, prefix + 'complete'); destination.complete(); },
      });
      destination.add(subscriber);
      try { create(scope).subscribe(subscriber); } catch (error) { subscriber.error(error); }
    });
  }
  function build(id: string): Observable<unknown> {
    if (streams.has(id)) return streams.get(id)!;
    const node = nodes.get(id)!;
    const inputs = node.inputs.map(p => build(p.from));
    const input = inputs[0]!;
    let stream: Observable<unknown>;
    if (node.operation === 'shareReplay') {
      // The replay hub is allocated once per graph execution; it connects lazily.
      const connection = instrument(node.id, () => input);
      stream = connection.pipe(shareReplay({ bufferSize: 1, refCount: true }));
    } else {
      stream = instrument(node.id, scope => {
        switch (node.operation) {
          case 'values': {
            if (options.sources?.[id]) return defer(options.sources[id]!);
            const values = structuredClone(node.parameters.values) as unknown[];
            return values.length === 0 || node.parameters.periodMs === 0 ? from(values) :
              timer(0, Number(node.parameters.periodMs), scheduler).pipe(take(values.length), map(index => values[index]));
          }
          case 'interval': {
            if (options.sources?.[id]) return defer(options.sources[id]!);
            const source = interval(Number(node.parameters.periodMs), scheduler);
            return node.parameters.count === null ? source : source.pipe(take(Number(node.parameters.count)));
          }
          case 'map': return input.pipe(map(value => evaluate(node, scope, value)));
          case 'filter': return input.pipe(filter(value => evaluate(node, scope, value) as boolean));
          case 'scan':
            scope.total = structuredClone(node.parameters.seed);
            return input.pipe(scan((_total, value) => evaluate(node, scope, value), scope.total));
          case 'take': return input.pipe(take(Number(node.parameters.count)));
          case 'delay': return input.pipe(delay(Number(node.parameters.durationMs), scheduler));
          case 'debounceTime': return input.pipe(debounceTime(Number(node.parameters.durationMs), scheduler));
          case 'switchMap': return input.pipe(switchMap(value => {
            const projected = evaluate(node, scope, value);
            return instrument(node.id, () => delayedValue(projected, Number(node.parameters.durationMs), scheduler), true);
          }));
          case 'combineLatest': return combineLatest(inputs);
          case 'sink': return input;
          default: throw new Error('Unsupported activation: ' + node.operation);
        }
      });
    }
    streams.set(id, stream); return stream;
  }
  const subscribers = sinks.map(node => {
    const subscriber = new Subscriber<unknown>({
      next: value => options.next?.(node.id, value),
      error: () => finish('errored'),
      complete: () => { remaining--; if (remaining === 0) finish('completed'); },
    });
    root.add(subscriber);
    return { node, subscriber };
  });
  options.status?.('running');
  for (const { node, subscriber } of subscribers) {
    if (root.closed) break;
    build(node.id).subscribe(subscriber);
  }
  return { id: options.id, get status() { return status; }, cancel() { finish('cancelled'); } };
}
