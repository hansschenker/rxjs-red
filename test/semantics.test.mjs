import test from 'node:test';
import assert from 'node:assert/strict';
import { Observable, from, map, filter, scan, switchMap, timer, delay, debounceTime, take, combineLatest } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { compileGraph, startExecution } from '../dist/compiler.js';

const node = (id, operation, parameters = {}, upstream) => ({ id, role: ['values', 'interval'].includes(operation) ? 'Source' : operation === 'sink' ? 'Sink' : 'Pipeline', operation, parameters, inputs: upstream ? [{ name: 'input', from: upstream }] : [] });
const source = (values = [1, 2, 3, 4, 5], periodMs = 0, valueType = 'number') => node('source', 'values', { values, periodMs, valueType });
const graph = nodes => ({ profile: 'rxjs-red.graph/0.1', id: 'test-flow', name: 'Test', clock: { id: 'rsl-clock', unit: 'ms' }, nodes });
function pipeline(operations, values, periodMs = 0) {
  const nodes = [source(values, periodMs)];
  for (let i = 0; i < operations.length; i++) nodes.push(node('op' + i, operations[i][0], operations[i][1], nodes.at(-1).id));
  nodes.push(node('sink', 'sink', {}, nodes.at(-1).id));
  return graph(nodes);
}
function record(compiled, scheduler, options = {}) {
  const output = []; const trace = [];
  const execution = startExecution(compiled, { id: 'test-run', scheduler, next: (sink, value) => output.push({ sink, value, time: scheduler.now() }), trace: e => trace.push(e), ...options });
  return { output, trace, execution };
}
const virtual = () => new TestScheduler(assert.deepEqual);

test('compilation is lazy; map/filter results and terminal protocol match RxJS', () => {
  let subscribed = 0;
  const compiled = compileGraph(pipeline([['map', { expression: '{% $rsl.event.value * 2 %}', valueType: 'number' }], ['filter', { expression: '{% $notification.value > 6 %}' }]]));
  assert.equal(subscribed, 0);
  const actual = record(compiled, virtual(), { sources: { source: () => { subscribed++; return from([1, 2, 3, 4, 5]); } } });
  const expected = []; from([1, 2, 3, 4, 5]).pipe(map(v => v * 2), filter(v => v > 6)).subscribe(v => expected.push(v));
  assert.deepEqual(actual.output.map(e => e.value), expected);
  assert.equal(subscribed, 1); assert.equal(actual.execution.status, 'completed');
  assert.equal(actual.trace.filter(e => e.nodeId === 'sink' && e.kind === 'complete').length, 1);
});

test('scan remembers per subscription and exposes before/after state', () => {
  const compiled = compileGraph(pipeline([['scan', { expression: '{% $state.total + $notification.value %}', seed: 0, valueType: 'number' }]]));
  const first = record(compiled, virtual()); const second = record(compiled, virtual(), { id: 'second' });
  assert.deepEqual(first.output.map(e => e.value), [1, 3, 6, 10, 15]);
  assert.deepEqual(second.output.map(e => e.value), [1, 3, 6, 10, 15]);
  assert.deepEqual(first.trace.find(e => e.kind === 'state').context, { before: { total: 0 }, after: { total: 1 } });
  const reaction = first.trace.find(e => e.kind === 'reaction');
  assert.equal(reaction.context.memory.index, 0); assert.equal(reaction.context.event.inputIndex, 0);
});

test('take propagates cancellation synchronously into the producer', () => {
  const compiled = compileGraph(pipeline([['take', { count: 1 }]]));
  let produced = 0; let cleaned = 0;
  const actual = record(compiled, virtual(), { sources: { source: () => new Observable(s => {
    for (let i = 0; i < 100 && !s.closed; i++) { produced++; s.next(i); }
    return () => cleaned++;
  }) } });
  assert.equal(produced, 1); assert.equal(cleaned, 1);
  assert.equal(actual.execution.status, 'completed');
  assert.ok(actual.trace.some(e => e.nodeId === 'source' && e.kind === 'unsubscribe'));
  assert.ok(!actual.trace.some(e => e.nodeId === 'source' && e.kind === 'complete'));
});

test('take(0) completes without source subscription', () => {
  let subscriptions = 0;
  const actual = record(compileGraph(pipeline([['take', { count: 0 }]])), virtual(), { sources: { source: () => { subscriptions++; return from([1]); } } });
  assert.equal(subscriptions, 0); assert.equal(actual.execution.status, 'completed');
});

test('switchMap cancels obsolete workers and waits for the last inner after source completion', () => {
  const scheduler = virtual();
  const compiled = compileGraph(pipeline([['switchMap', { worker: 'delayedValue', expression: '{% $notification.value * 10 %}', durationMs: 15, valueType: 'number' }]], [1, 2, 3], 10));
  const actual = record(compiled, scheduler);
  scheduler.flush();
  assert.deepEqual(actual.output.map(e => [e.time, e.value]), [[35, 30]]);
  assert.equal(actual.trace.filter(e => e.kind === 'inner.unsubscribe').length, 2);
  assert.equal(actual.trace.filter(e => e.kind === 'inner.complete').length, 1);
  assert.equal(actual.execution.status, 'completed');
});

test('cancellation tears down an active inner and never completes the sink', () => {
  const scheduler = virtual();
  const actual = record(compileGraph(pipeline([['switchMap', { worker: 'delayedValue', expression: '{% $notification.value %}', durationMs: 100, valueType: 'number' }]], [1])), scheduler);
  scheduler.schedule(() => actual.execution.cancel(), 20); scheduler.flush();
  assert.equal(actual.execution.status, 'cancelled'); assert.deepEqual(actual.output, []);
  assert.ok(actual.trace.some(e => e.kind === 'inner.unsubscribe'));
  assert.ok(!actual.trace.some(e => e.nodeId === 'sink' && e.kind === 'complete'));
});

test('debounceTime completion flush and pending-value error behavior match RxJS', () => {
  const scheduler = virtual();
  scheduler.run(({ cold }) => {
    const compiled = compileGraph(pipeline([['debounceTime', { durationMs: 10 }]]));
    const actual = record(compiled, scheduler, { sources: { source: () => cold('a-b-|', { a: 1, b: 2 }) } });
    const expected = []; cold('a-b-|', { a: 1, b: 2 }).pipe(debounceTime(10, scheduler)).subscribe(value => expected.push({ sink: 'sink', value, time: scheduler.now() }));
    scheduler.flush(); assert.deepEqual(actual.output, expected); assert.deepEqual(actual.output.map(e => [e.time, e.value]), [[4, 2]]);
  });
  const other = virtual();
  other.run(({ cold }) => {
    const actual = record(compileGraph(pipeline([['debounceTime', { durationMs: 10 }]])), other, { sources: { source: () => cold('a-#', { a: 1 }) } });
    other.flush(); assert.deepEqual(actual.output, []); assert.equal(actual.execution.status, 'errored');
  });
});

test('delay propagates errors immediately and cancels queued values', () => {
  const scheduler = virtual();
  scheduler.run(({ cold }) => {
    const actual = record(compileGraph(pipeline([['delay', { durationMs: 10 }]])), scheduler, { sources: { source: () => cold('a-#', { a: 1 }) } });
    scheduler.flush(); assert.deepEqual(actual.output, []); assert.equal(actual.execution.status, 'errored');
    assert.equal(actual.trace.find(e => e.nodeId === 'sink' && e.kind === 'error').time, 2);
  });
  const other = virtual();
  const actual = record(compileGraph(pipeline([['delay', { durationMs: 100 }]], [1, 2])), other);
  other.schedule(() => actual.execution.cancel(), 10); other.flush(); assert.deepEqual(actual.output, []);
});

test('multiple named inputs preserve ordered tuple coordination and completion', () => {
  const scheduler = virtual();
  const nodes = [node('a', 'values', { values: [1, 2], periodMs: 10, valueType: 'number' }), node('b', 'values', { values: ['x', 'y'], periodMs: 15, valueType: 'string' }), { ...node('join', 'combineLatest'), inputs: [{ name: 'a', from: 'a' }, { name: 'b', from: 'b' }] }, node('sink', 'sink', {}, 'join')];
  const actual = record(compileGraph(graph(nodes)), scheduler); scheduler.flush();
  assert.deepEqual(actual.output.map(e => [e.time, e.value]), [[0, [1, 'x']], [10, [2, 'x']], [15, [2, 'y']]]);
  assert.equal(actual.execution.status, 'completed');
});

test('two sinks are cold by default; explicit shareReplay creates one upstream subscription', () => {
  for (const shared of [false, true]) {
    const scheduler = virtual(); let subscriptions = 0;
    const nodes = [source()];
    if (shared) nodes.push(node('hub', 'shareReplay', {}, 'source'));
    nodes.push(node('a', 'sink', {}, shared ? 'hub' : 'source'), node('b', 'sink', {}, shared ? 'hub' : 'source'));
    const actual = record(compileGraph(graph(nodes)), scheduler, { sources: { source: () => { subscriptions++; return timer(10, scheduler).pipe(map(() => 7)); } } });
    scheduler.flush(); assert.equal(subscriptions, shared ? 1 : 2);
    assert.deepEqual(actual.output.map(e => e.value), [7, 7]);
  }
});

test('shared source cleanup happens when the workflow is cancelled', () => {
  let cleanup = 0;
  const nodes = [source(), node('hub', 'shareReplay', {}, 'source'), node('a', 'sink', {}, 'hub'), node('b', 'sink', {}, 'hub')];
  const actual = record(compileGraph(graph(nodes)), virtual(), { sources: { source: () => new Observable(() => () => cleanup++) } });
  actual.execution.cancel(); actual.execution.cancel(); assert.equal(cleanup, 1);
});

test('expression failure terminates; cancelled execution does not report completion', () => {
  const actual = record(compileGraph(pipeline([['map', { expression: '{% $error("domain failure") %}', valueType: 'number' }]])), virtual());
  assert.equal(actual.execution.status, 'errored'); assert.deepEqual(actual.output, []);
  assert.ok(actual.trace.some(e => e.kind === 'error' && JSON.stringify(e.error).includes('domain failure')));
});

test('a direct selector keeps each array package intact', () => {
  const input = graph([node('source', 'values', { values: [[], [1], [[2, 3]]], periodMs: 0, valueType: 'json' }), node('map', 'map', { expression: '{% $rsl.event.value %}', valueType: 'json' }, 'source'), node('sink', 'sink', {}, 'map')]);
  const actual = record(compileGraph(input), virtual());
  assert.deepEqual(actual.output.map(e => e.value), [[], [1], [[2, 3]]]);
});

test('invalid graph edges, cycles, types, and noncanonical expressions are rejected', () => {
  const cyclic = pipeline([['take', { count: 1 }]]); cyclic.nodes[1].inputs[0].from = 'op0';
  assert.throws(() => compileGraph(cyclic), /Cycles/);
  assert.throws(() => compileGraph(pipeline([['map', { expression: '{% $now() %}', valueType: 'number' }]])), /./);
  assert.throws(() => compileGraph(pipeline([['map', { expression: '$notification.value', valueType: 'number' }]])), /./);
  assert.throws(() => compileGraph(pipeline([], ['bad'])), /declared number/);
  assert.throws(() => compileGraph(pipeline([['take', { count: -1 }]])), /invalid count/);
});
