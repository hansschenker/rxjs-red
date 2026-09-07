import test from "node:test";
import assert from "node:assert/strict";
import { defer, of, map, filter, take, finalize, Subject } from "rxjs";
import { TestScheduler } from "rxjs/testing";
import {
  createSynchronousAdapter,
  createEvaluationFrame,
  createLogicalClock,
} from "../dist/index.js";

const number = { kind: "primitive", name: "number" },
  boolean = { kind: "primitive", name: "boolean" };
const unit = (source, slot, expectedType) => ({
  profile: "rsl.expression-context/0.1",
  dialect: "rsl.jsonata.core-1",
  QueryLanguage: "JSONata",
  slot,
  mode: "expression",
  value: `{% ${source} %}`,
  expectedType,
  context: {
    parameters: {},
    state: {},
    locals: {},
    bindings: {},
    clock: { id: "scheduler", unit: "frame" },
    sharedConnection: false,
    event: { source: "source", kind: "next", valueType: number },
  },
  types: {},
  helpers: {},
  location: { file: "rxjs-integration", fieldPath: "/expression" },
});
const adapter = createSynchronousAdapter({
  helperRegistryVersion: "integration/1",
});
const makeFrame = (clock, value, id = "s") =>
  createEvaluationFrame({
    phase: "reaction",
    parameters: {},
    state: {},
    local: {},
    notification: {
      source: "source",
      kind: "next",
      value,
      time: clock.sample(),
      sequence: 0,
      contextId: "scheduler",
    },
    clock,
    executionId: id,
    operatorId: "op",
    subscription: { id, closed: false },
  });

test("RxJS 7.8.2: subscription stays lazy; calculations and completion stay synchronous", () => {
  const project = adapter.compile(
    unit("$notification.value*2", "emitNext", number),
  );
  const predicate = adapter.compile(
    unit("$notification.value>4", "guard", boolean),
  );
  const clock = createLogicalClock("scheduler", "frame", () => 0);
  let starts = 0;
  const values = [],
    trace = [];
  function transform(value) {
    return project.evaluate(makeFrame(clock, value));
  }
  function select(value) {
    return predicate.evaluate(makeFrame(clock, value));
  }
  const workflow = defer(() => {
    starts++;
    return of(1, 2, 3, 4);
  }).pipe(map(transform), filter(select));
  assert.equal(starts, 0);
  workflow.subscribe({
    next: (value) => {
      values.push(value);
      trace.push("next");
    },
    complete: () => trace.push("complete"),
  });
  trace.push("after subscribe");
  assert.deepEqual(values, [6, 8]);
  assert.deepEqual(trace, ["next", "next", "complete", "after subscribe"]);
  assert.equal(starts, 1);
  workflow.subscribe();
  assert.equal(starts, 2);
});
test("RxJS 7.8.2: take cancellation stops further evaluator calls", () => {
  const project = adapter.compile(
    unit("$notification.value*2", "emitNext", number),
  );
  const clock = createLogicalClock("scheduler", "frame", () => 0);
  let calls = 0,
    teardowns = 0;
  const values = [];
  function transform(value) {
    calls++;
    return project.evaluate(makeFrame(clock, value));
  }
  of(1, 2, 3)
    .pipe(
      map(transform),
      take(1),
      finalize(() => teardowns++),
    )
    .subscribe((value) => values.push(value));
  assert.deepEqual(values, [2]);
  assert.equal(calls, 1);
  assert.equal(teardowns, 1);
});
test("RxJS 7.8.2: evaluation failure arrives synchronously and tears down once", () => {
  const project = adapter.compile(
    unit(
      '$notification.value=2?$error("stop"):$notification.value',
      "emitNext",
      number,
    ),
  );
  const clock = createLogicalClock("scheduler", "frame", () => 0);
  const trace = [];
  let finalized = 0;
  function transform(value) {
    return project.evaluate(makeFrame(clock, value));
  }
  of(1, 2, 3)
    .pipe(
      map(transform),
      finalize(() => finalized++),
    )
    .subscribe({
      next: (v) => trace.push(v),
      error: (e) => trace.push(e.diagnostic.code),
    });
  trace.push("returned");
  assert.deepEqual(trace, [1, "RSL_EXPR_EVALUATION", "returned"]);
  assert.equal(finalized, 1);
});
test("RxJS 7.8.2: cached expressions keep frames isolated through Subject reentrancy", () => {
  const source = new Subject();
  const clock = createLogicalClock("scheduler", "frame", () => 0);
  const project = adapter.compile(
    unit("$notification.value*2", "emitNext", number),
  );
  const trace = [];
  function transform(value) {
    return project.evaluate(makeFrame(clock, value));
  }
  const subscription = source.pipe(map(transform)).subscribe((value) => {
    trace.push(value);
    if (value === 2) source.next(2);
    trace.push(`after ${value}`);
  });
  source.next(1);
  subscription.unsubscribe();
  source.next(9);
  assert.deepEqual(trace, [2, 4, "after 4", "after 2"]);
});
test("RxJS 7.8.2: virtual-time adapter preserves marble notification times", () => {
  const scheduler = new TestScheduler((actual, expected) =>
    assert.deepEqual(actual, expected),
  );
  const project = adapter.compile(
    unit("$notification.value*2", "emitNext", number),
  );
  scheduler.run(({ cold, expectObservable }) => {
    const clock = createLogicalClock("scheduler", "frame", () =>
      scheduler.now(),
    );
    function transform(value) {
      return project.evaluate(makeFrame(clock, value));
    }
    expectObservable(cold("-a--b|", { a: 2, b: 3 }).pipe(map(transform))).toBe(
      "-x--y|",
      { x: 4, y: 6 },
    );
  });
});
