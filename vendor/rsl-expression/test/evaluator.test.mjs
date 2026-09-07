import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createSynchronousAdapter,
  createEvaluationFrame,
  createLogicalClock,
  createReferenceRegistry,
  createReactionScope,
  evaluateEmission,
} from "../dist/index.js";

const p = (name) => ({ kind: "primitive", name });
const N = p("number"),
  B = p("boolean"),
  S = p("string"),
  U = p("unknown");
const array = (items) => ({ kind: "array", items });
const record = (fields) => ({ kind: "record", fields });
const temporal = (ref = "LogicalTime", id = "virtual") => ({
  kind: "generic",
  ref: `rsl.${ref}`,
  arguments: [{ kind: "named", ref: id }],
});
const timerType = { kind: "generic", ref: "rsl.TimerId", arguments: [] };
const wrap = (body) => `{% ${body} %}`;
const helper = (parameters = [N], output = N) => ({
  parameters,
  output,
  purity: "pure",
  evaluation: "synchronous",
  version: "1",
});
function unit(body = "1", changes = {}) {
  return {
    profile: "rsl.expression-context/0.1",
    dialect: "rsl.jsonata.core-1",
    QueryLanguage: "JSONata",
    slot: "capture",
    mode: "expression",
    value: wrap(body),
    expectedType: U,
    context: {
      parameters: {
        n: N,
        items: array(record({ id: S, total: N })),
        prices: array(N),
      },
      state: { count: N, previous: N },
      locals: { candidate: U },
      bindings: {
        minimum: { type: N, owner: "operator", source: "parameter" },
      },
      clock: { id: "virtual", unit: "frame" },
      sharedConnection: false,
      event: { source: "source", kind: "next", valueType: U },
    },
    types: {},
    helpers: {},
    location: { file: "operator.yaml", fieldPath: "/reaction/action" },
    ...changes,
  };
}
const adapter = (config) =>
  createSynchronousAdapter({ helperRegistryVersion: "tests/1", ...config });
function frame(u = unit(), changes = {}) {
  const e = u.context.event;
  const notification = {
    source: e?.source,
    kind: e?.kind,
    contextId: "virtual",
    time: 10,
    sequence: 0,
    ...(e?.valueType ? { value: { code: "RSL-42", n: 3 } } : {}),
    ...(e?.errorType ? { error: "failure" } : {}),
    ...(e?.source === "input" ? { inputIndex: 1 } : {}),
    ...(e?.source === "timer" || e?.scheduled ? { targetTime: 9 } : {}),
    ...(["timer", "inner", "notifier"].includes(e?.source)
      ? { id: "resource" }
      : {}),
  };
  return createEvaluationFrame({
    phase:
      u.slot === "initial"
        ? "initial"
        : u.slot === "transition"
          ? "transition"
          : "reaction",
    parameters: {
      n: 2,
      prices: [1, 3, 5],
      items: [
        { id: "a", total: 1 },
        { id: "b", total: 3 },
      ],
    },
    state: { count: 2, previous: 1 },
    local: { candidate: 7 },
    bindings: { minimum: 1 },
    notification,
    clock: createLogicalClock("virtual", "frame", () => 10),
    executionId: "execution-a",
    operatorId: "operator-a",
    subscription: { id: "subscription-a", closed: false },
    ...changes,
  });
}
const evaluate = (body, changes = {}, f = {}, config = {}) => {
  const u = unit(body, changes);
  return adapter(config).compile(u).evaluate(frame(u, f));
};
function failure(run, code) {
  assert.throws(run, (error) => {
    assert.equal(error.diagnostic?.code, code, error.stack);
    return true;
  });
}
const cases = [
  ["arithmetic", "$parameters.n * 4 + 1", 9],
  ["named variable", "$minimum + 2", 3],
  ["lexical block", "($v := 4; $v * $v)", 16],
  ["closure", "($n:=3;$f:=function($x){$x+$n};$f(2))", 5],
  ["recursion", "($f:=function($n){$n=0?1:$n*$f($n-1)};$f(5))", 120],
  ["collection map", "$map($parameters.prices,function($v){$v*2})", [2, 6, 10]],
  [
    "collection filter",
    "$filter($parameters.prices,function($v){$v>1})",
    [3, 5],
  ],
  [
    "collection reduce",
    "$reduce($parameters.prices,function($a,$b){$a+$b},0)",
    9,
  ],
  ["nested focus", "$parameters.items[total>$minimum].id", "b"],
  ["nested dollar", "$parameters.prices[$>2]", [3, 5]],
  ["sort", "$parameters.items^(>total).id", ["b", "a"]],
  ["group", '$parameters.items{"sum":$sum(total)}', { sum: 4 }],
  ["range", "[1..3]", [1, 2, 3]],
  ["partial", '($head:=$substring(?,0,2);$head("abcd"))', "ab"],
  ["chain", "$notification.value.code ~> $lowercase()", "rsl-42"],
  ["transform", '$notification.value ~> |$|{"n":8}|', { code: "RSL-42", n: 8 }],
  [
    "regex extraction",
    "$match($notification.value.code,/[0-9]+/)[0].match",
    "42",
  ],
  [
    "regex replacement",
    '$replace($notification.value.code,/[0-9]+/,"X")',
    "RSL-X",
  ],
  ["regex permission", '$count($match("absent",/^RSL-/))>0', false],
  ["regex array", '[$match("a1b2",/[0-9]/).match]', ["1", "2"]],
  ["date conversion", '$toMillis("1970-01-01T00:00:01.000Z")', 1000],
  ["fixed formatting", "$fromMillis(0)", "1970-01-01T00:00:00.000Z"],
  ["unicode values", '$uppercase("grüezi")', "GRÜEZI"],
  ["inline marker literal", '"Hello {% text %}"', "Hello {% text %}"],
  ["returned wrapper", '"{% $state.count %}"', "{% $state.count %}"],
  ["state alias", "$rsl.memory.count + 1", 3],
  ["event alias", "$rsl.event.value.code", "RSL-42"],
  ["local alias", "$rsl.locals.candidate", 7],
  [
    "previous state",
    "$rsl.previousMemory.count + $previousState.count",
    4,
    { slot: "transition" },
  ],
  ["lookup alias", '$lookup($notification,"value").code', "RSL-42"],
  [
    "closure context",
    "($f:=function(){$notification};$f().value.code)",
    "RSL-42",
  ],
];
for (const [name, body, expected, changes] of cases)
  test(`evaluate: ${name}`, () => {
    // JSONata sequences may carry internal non-index metadata. The public value is JSON.
    assert.deepEqual(
      JSON.parse(JSON.stringify(evaluate(body, changes))),
      expected,
    );
  });

test("all context aliases have reference identity; snapshots preserve payload identity", () => {
  const f = frame();
  const b = f.bindings;
  assert.strictEqual(b.rsl.parameters, b.parameters);
  assert.strictEqual(b.rsl.memory, b.state);
  assert.strictEqual(b.rsl.event, b.notification);
  assert.strictEqual(b.rsl.locals, b.local);
  assert.ok(
    Object.isFrozen(b) && Object.isFrozen(b.rsl) && Object.isFrozen(b.state),
  );
  assert.equal(Object.isFrozen(b.notification.value), false);
  const t = frame(unit("1", { slot: "transition" }));
  assert.strictEqual(t.bindings.rsl.previousMemory, t.bindings.previousState);
  assert.strictEqual(t.bindings.previousState, t.bindings.state);
});
test("frame retains a fixed state envelope without cloning application values", () => {
  const source = { count: 2, previous: 1 };
  const packet = { x: 1 };
  const f = frame(unit(), {
    state: source,
    notification: {
      source: "source",
      kind: "next",
      value: packet,
      time: 10,
      sequence: 0,
      contextId: "virtual",
    },
  });
  source.count = 99;
  assert.equal(f.bindings.state.count, 2);
  assert.strictEqual(f.bindings.notification.value, packet);
});
test("direct array and object forwarding preserve identity", () => {
  for (const value of [[], [1], [[1], [2]], { x: 1 }]) {
    const u = unit("$rsl.event.value", { slot: "emitNext" });
    const f = frame(u, {
      notification: {
        source: "source",
        kind: "next",
        value,
        time: 10,
        sequence: 0,
        contextId: "virtual",
      },
    });
    assert.strictEqual(adapter().compile(u).evaluate(f), value);
  }
});
test("explicit direct payload contract preserves undefined, functions, cycles, instances and Promise data", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  let subscribed = 0;
  const values = [
    undefined,
    () => 1,
    cyclic,
    new Date(0),
    Promise.resolve(1),
    {
      subscribe() {
        subscribed++;
      },
    },
    Object.defineProperty({}, "then", {
      get() {
        throw new Error("must not read");
      },
    }),
  ];
  const u = unit("$notification.value", { slot: "emitNext" });
  const expression = adapter().compile(u, {
    directValue: { contractId: "host.any-payload/1", accepts: () => true },
  });
  for (const value of values)
    assert.strictEqual(
      expression.evaluate(
        frame(u, {
          notification: {
            source: "source",
            kind: "next",
            value,
            time: 10,
            sequence: 0,
            contextId: "virtual",
          },
        }),
      ),
      value,
    );
  assert.equal(subscribed, 0);
});
test("explicit undefined presence differs from missing event payload", () => {
  const u = unit("$notification.value");
  const expression = adapter().compile(u, {
    directValue: { contractId: "any", accepts: () => true },
  });
  failure(
    () =>
      expression.evaluate(
        frame(u, {
          notification: {
            source: "source",
            kind: "next",
            time: 10,
            sequence: 0,
            contextId: "virtual",
          },
        }),
      ),
    "RSL_EXPR_CONTEXT",
  );
});
test("direct contract cannot bless a computation", () =>
  failure(
    () =>
      adapter().compile(unit("$notification.value+0"), {
        directValue: { contractId: "any", accepts: () => true },
      }),
    "RSL_EXPR_TYPE",
  ));
test("input type is enforced even if the output declares unknown", () => {
  const u = unit("$notification.value");
  u.context.event.valueType = N;
  failure(() => adapter().compile(u).evaluate(frame(u)), "RSL_EXPR_TYPE");
});
test("ordinary computation cannot inspect a host getter", () => {
  let reads = 0;
  const value = Object.defineProperty({}, "n", {
    enumerable: true,
    get() {
      reads++;
      return 3;
    },
  });
  failure(
    () =>
      evaluate(
        "$notification.value.n+1",
        {},
        {
          notification: {
            source: "source",
            kind: "next",
            value,
            time: 10,
            sequence: 0,
            contextId: "virtual",
          },
        },
      ),
    "RSL_EXPR_TYPE",
  );
  assert.equal(reads, 0);
});
test("unread arbitrary payload does not interfere with operator memory calculation", () => {
  const value = {};
  value.self = value;
  assert.equal(
    evaluate(
      "$state.count+1",
      {},
      {
        notification: {
          source: "source",
          kind: "next",
          value,
          time: 10,
          sequence: 0,
          contextId: "virtual",
        },
      },
    ),
    3,
  );
});
test("computed string is not source-normalized", () =>
  assert.equal(
    evaluate(
      '$notification.value & "!"',
      {},
      {
        notification: {
          source: "source",
          kind: "next",
          value: "e\u0301",
          time: 10,
          sequence: 0,
          contextId: "virtual",
        },
      },
    ),
    "e\u0301!",
  ));
test("literal mode does not parse expression strings", () =>
  assert.equal(
    evaluate("unused", { mode: "literal", value: "{% $unbound %}" }),
    "{% $unbound %}",
  ));
test("template values evaluate once and retain literal keys", () =>
  assert.deepEqual(
    evaluate("unused", {
      mode: "template",
      value: {
        "k{% x %}": "{% $state.count %}",
        text: "x {% ignored %}",
        nested: ['{% "{% ignored again %}" %}'],
      },
    }),
    { "k{% x %}": 2, text: "x {% ignored %}", nested: ["{% ignored again %}"] },
  ));
test("template leaf absence stops at canonical first field", () => {
  try {
    evaluate("unused", {
      mode: "template",
      value: {
        z: '{% $error("later") %}',
        a: "{% $notification.value.missing %}",
      },
    });
    assert.fail();
  } catch (e) {
    assert.equal(e.diagnostic.code, "RSL_EXPR_MISSING");
    assert.equal(e.diagnostic.fieldPath, "/reaction/action/a");
  }
});
test("required result shapes and fields are checked", () => {
  failure(() => evaluate("$notification.value.missing"), "RSL_EXPR_MISSING");
  failure(
    () =>
      evaluate("$notification.value", {
        expectedType: record({ required: N }),
      }),
    "RSL_EXPR_TYPE",
  );
  failure(
    () => evaluate("$parameters.items[total>1].id", { expectedType: array(S) }),
    "RSL_EXPR_TYPE",
  );
  assert.deepEqual(
    evaluate("[$parameters.items[total>1].id]", { expectedType: array(S) }),
    ["b"],
  );
});
test("strict Boolean guard does not use truthiness", () =>
  failure(
    () => evaluate("$notification.value", { slot: "guard", expectedType: B }),
    "RSL_EXPR_TYPE",
  ));
test("nonfinite results fail on the same stack", () =>
  failure(() => evaluate("1/0"), "RSL_EXPR_TYPE"));
test("deliberate JSONata errors retain code, cause, location and execution metadata", () => {
  const expression = adapter().compile(unit('$error("intentional")')); // compilation must not run it
  try {
    expression.evaluate(frame());
    assert.fail();
  } catch (e) {
    assert.equal(e.diagnostic.code, "RSL_EXPR_EVALUATION");
    assert.equal(e.diagnostic.causeCode, "D3137");
    assert.equal(e.diagnostic.file, "operator.yaml");
    assert.equal(e.diagnostic.executionId, "execution-a");
    assert.equal(e.cause.message, "intentional");
    assert.ok(e.diagnostic.offset > 0);
  }
});
test("initial expressions require only parameters and immutable bindings", () => {
  const u = unit("$rsl.parameters.n+1", { slot: "initial" });
  delete u.context.event;
  assert.equal(
    adapter()
      .compile(u)
      .evaluate(
        createEvaluationFrame({
          phase: "initial",
          parameters: { n: 4 },
          bindings: { minimum: 1 },
        }),
      ),
    5,
  );
});
for (const kind of ["complete", "error", "unsubscribe"])
  test(`event availability: ${kind}`, () => {
    const u = unit("$rsl.event.value");
    u.context.event = {
      source: kind === "unsubscribe" ? "downstream" : "source",
      kind,
      ...(kind === "error" ? { errorType: U } : {}),
    };
    failure(() => adapter().compile(u), "RSL_EXPR_CONTEXT");
  });
test("runtime event family cannot bypass compile-time narrowing", () => {
  failure(
    () =>
      adapter()
        .compile(unit("$state.count"))
        .evaluate(
          frame(unit(), {
            notification: {
              source: "source",
              kind: "complete",
              time: 10,
              sequence: 0,
              contextId: "virtual",
            },
          }),
        ),
    "RSL_EXPR_CONTEXT",
  );
});
test("transition-only frame cannot be used as an ordinary reaction frame", () =>
  failure(
    () =>
      adapter()
        .compile(unit("$state.count"))
        .evaluate(frame(unit("1", { slot: "transition" }))),
    "RSL_EXPR_CONTEXT",
  ));
test("clock samples once per frame and distinguishes triggering dispatch time", () => {
  let reads = 0;
  const clock = createLogicalClock("virtual", "frame", () => 20 + reads++);
  const u = unit("[$rsl.time.now,$rsl.time.now,$notification.time]");
  const expression = adapter().compile(u);
  const f = frame(u, { clock });
  assert.deepEqual(expression.evaluate(f), [20, 20, 10]);
  assert.equal(reads, 1);
  assert.deepEqual(expression.evaluate(frame(u, { clock })), [21, 21, 10]);
  assert.equal(reads, 2);
});
test("clock rejects nonfinite and backwards samples", () => {
  let now = 1;
  const clock = createLogicalClock("virtual", "frame", () => now);
  clock.sample();
  now = 0;
  assert.throws(() => clock.sample(), /monotonic/);
  now = NaN;
  assert.throws(() => clock.sample(), /finite/);
});
test("different clock units and domains cannot be silently mixed", () => {
  failure(
    () =>
      adapter()
        .compile(unit("$rsl.time.now"))
        .evaluate(
          frame(unit(), {
            clock: createLogicalClock("virtual", "ms", () => 10),
          }),
        ),
    "RSL_EXPR_TIME",
  );
  const u = unit("$state.count");
  failure(
    () =>
      adapter()
        .compile(u)
        .evaluate(
          frame(u, {
            notification: {
              source: "source",
              kind: "next",
              value: 1,
              time: 10,
              sequence: 0,
              contextId: "other",
            },
          }),
        ),
    "RSL_EXPR_TIME",
  );
});
test("clock precision policy applies to typed time results", () =>
  failure(
    () =>
      evaluate(
        "$rsl.time.now",
        { expectedType: temporal() },
        {},
        { timeValue: (value) => value < 5 },
      ),
    "RSL_EXPR_TIME",
  ));
test("unresolved temporal arithmetic requires an explicit host contract", () => {
  failure(
    () =>
      adapter().compile(
        unit("$notification.time+1", {
          slot: "scheduleTime",
          expectedType: temporal(),
        }),
      ),
    "RSL_EXPR_TIME",
  );
  assert.equal(
    evaluate(
      "$notification.time+1",
      { slot: "scheduleTime", expectedType: temporal() },
      {},
      { temporalExpression: () => true },
    ),
    11,
  );
});
test("cached compiled expression isolates executions and source mutations", () => {
  const a = adapter(),
    u = unit("$state.count+$notification.value.n");
  const expression = a.compile(u);
  u.value = wrap("999");
  assert.equal(
    expression.evaluate(frame(unit(), { state: { count: 1, previous: 0 } })),
    4,
  );
  assert.equal(
    expression.evaluate(
      frame(unit(), {
        state: { count: 100, previous: 0 },
        executionId: "execution-b",
        subscription: { id: "subscription-b", closed: false },
      }),
    ),
    103,
  );
  assert.equal(
    expression.evaluate(frame(unit(), { state: { count: 1, previous: 0 } })),
    4,
  );
});
test("same compiled expression supports nested evaluation from a trusted helper without leaking bindings", () => {
  const contract = helper([], N);
  let nested = false;
  let expression;
  const a = adapter({
    helpers: {
      nested: {
        contract,
        call: () => {
          if (nested) return 0;
          nested = true;
          try {
            return expression.evaluate(
              frame(u, { state: { count: 10, previous: 0 } }),
            );
          } finally {
            nested = false;
          }
        },
      },
    },
  });
  const u = unit("$state.count+$nested()+$state.count", {
    helpers: { nested: contract },
    expectedType: N,
  });
  expression = a.compile(u);
  assert.equal(expression.evaluate(frame(u)), 24);
});
test("helper argument/result contracts, versions and synchronous declarations are enforced", () => {
  const contract = helper();
  const u = unit("$twice($notification.value)", {
    helpers: { twice: contract },
  });
  failure(() => adapter().compile(u), "RSL_EXPR_BINDING");
  failure(
    () =>
      adapter({
        helpers: {
          twice: {
            contract: { ...contract, version: "2" },
            call: (v) => v * 2,
          },
        },
      }).compile(u),
    "RSL_EXPR_BINDING",
  );
  failure(
    () =>
      adapter({
        helpers: { twice: { contract, call: async (v) => v * 2 } },
      }).compile(u),
    "RSL_EXPR_ASYNC",
  );
  let calls = 0;
  failure(
    () =>
      adapter({
        helpers: {
          twice: {
            contract,
            call: (v) => {
              calls++;
              return v * 2;
            },
          },
        },
      })
        .compile(u)
        .evaluate(frame(u)),
    "RSL_EXPR_TYPE",
  );
  assert.equal(calls, 0);
  failure(
    () =>
      evaluate(
        "$twice(2)",
        { helpers: { twice: contract } },
        {},
        { helpers: { twice: { contract, call: () => "wrong" } } },
      ),
    "RSL_EXPR_TYPE",
  );
});
for (const body of ["$bad(2)", "($bad(2);1)", "$bad(2)+1"])
  test(`thenable helper rejected before it can be hidden: ${body}`, () => {
    const contract = helper();
    let chained = 0;
    failure(
      () =>
        evaluate(
          body,
          { helpers: { bad: contract } },
          {},
          {
            helpers: {
              bad: {
                contract,
                call: () => ({
                  then() {
                    chained++;
                  },
                }),
              },
            },
          },
        ),
      "RSL_EXPR_ASYNC",
    );
    assert.equal(chained, 0);
  });
test("step limit terminates recursive expression evaluation", () =>
  failure(
    () =>
      evaluate(
        "($f:=function($n){$n=0?1:$n*$f($n-1)};$f(100))",
        {},
        {},
        { maxEvaluationSteps: 100 },
      ),
    "RSL_EXPR_LIMIT",
  ));
test("asynchronous engine package is rejected before activation", () => {
  const script = `const Module=require('node:module');const original=Module._load;Module._load=function(name,...args){return name==='jsonata/package.json'?{version:'2.2.2'}:original.call(this,name,...args)};import('./dist/index.js').then(({createSynchronousAdapter})=>{try{createSynchronousAdapter({helperRegistryVersion:'test'});process.exit(1)}catch(e){process.exit(e.diagnostic.code==='RSL_EXPR_ASYNC'?0:2)}});`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

const base = (u) => {
  const { value, expectedType, slot, mode, ...rest } = u;
  return rest;
};
test("helper higher-order arity and native partial application keep their contracts", () => {
  const indexed = helper([N, N], N),
    add = helper([N, N], N);
  assert.deepEqual(
    evaluate(
      "$map($parameters.prices,$indexed)",
      { helpers: { indexed } },
      {},
      { helpers: { indexed: { contract: indexed, call: (v, i) => v + i } } },
    ),
    [1, 4, 7],
  );
  assert.equal(
    evaluate(
      "($plus:=$add(?,2);$plus(3))",
      { helpers: { add } },
      {},
      { helpers: { add: { contract: add, call: (a, b) => a + b } } },
    ),
    5,
  );
});
for (const timestamp of ["2020", "2020-01-01", "2020-01-01T12:30:00"])
  test(`date conversion rejects ambiguous time: ${timestamp}`, () =>
    failure(() => evaluate(`$toMillis('${timestamp}')`), "RSL_EXPR_TIME"));
test("date conversion contract remains enforced through aliases and partial calls", () => {
  failure(
    () => evaluate('($convert:=$toMillis;$convert("2020"))'),
    "RSL_EXPR_TIME",
  );
  assert.equal(
    evaluate('($convert:=$toMillis(?,?);$convert("1970-01-01T00:00:01.000Z"))'),
    1000,
  );
  failure(() => evaluate('$toMillis("12","[H01]")'), "RSL_EXPR_TIME");
});
test("explicit custom date picture requires host validation", () => {
  assert.equal(
    evaluate(
      '$toMillis("1970-01-01T00:00:01+0000","[Y0001]-[M01]-[D01]T[H01]:[m01]:[s01][Z0000]")',
      {},
      {},
      { dateTimeArguments: () => true },
    ),
    1000,
  );
});
test("guard selection shares one clock observation", () => {
  let reads = 0;
  const clock = createLogicalClock("virtual", "frame", () => 10 + reads++);
  const scope = createReactionScope({
    parameters: {},
    initialState: { count: 0, previous: 0 },
    bindings: { minimum: 1 },
    clock,
    executionId: "e",
    operatorId: "o",
    subscriptionId: "subscription-a",
    isActive: () => true,
  });
  const u = unit("$rsl.time.now=10", { slot: "guard", expectedType: B });
  u.context.parameters = {};
  u.context.locals = {};
  const g = adapter().compile(u);
  const result = scope.run(
    {
      source: "source",
      kind: "next",
      value: 1,
      time: 10,
      sequence: 0,
      contextId: "virtual",
    },
    "select",
    (r) => r.guards([g, g]),
  );
  assert.deepEqual(result, [true, true]);
  assert.equal(reads, 1);
});
test("shared connection metadata appears only in the declared shared frame", () => {
  const u = unit("$rsl.connection.id", {
    expectedType: { kind: "generic", ref: "rsl.ConnectionId", arguments: [] },
  });
  u.context.sharedConnection = true;
  const expression = adapter().compile(u);
  assert.equal(
    expression.evaluate(frame(u, { connectionId: "shared-a" })),
    "shared-a",
  );
  failure(() => expression.evaluate(frame(u)), "RSL_EXPR_CONTEXT");
});
test("compiled literals are fresh across evaluations", () => {
  const u = unit("unused", { mode: "literal", value: { x: [1] } });
  const expression = adapter().compile(u);
  const one = expression.evaluate(frame(u));
  one.x.push(2);
  assert.deepEqual(expression.evaluate(frame(u)), { x: [1] });
});
test("transition siblings use previous state and commit atomically", () => {
  const a = adapter();
  const u = unit();
  const group = a.compileTransition({
    base: base(u),
    targets: {
      count: { type: N, value: wrap("$state.count+1") },
      previous: { type: N, value: wrap("$previousState.count") },
    },
  });
  const f = frame({ ...u, slot: "transition" });
  const next = group.apply(f);
  assert.deepEqual({ ...next }, { count: 3, previous: 2 });
  assert.equal(f.bindings.state.count, 2);
});
test("failed transition returns no partial assignments", () => {
  const u = unit();
  const a = adapter();
  const group = a.compileTransition({
    base: base(u),
    targets: {
      count: { type: N, value: wrap("$state.count+1") },
      previous: { type: N, value: wrap('$error("fail")') },
    },
  });
  let state = { count: 2, previous: 1 };
  failure(() => {
    state = group.apply(frame({ ...u, slot: "transition" }, { state }));
  }, "RSL_EXPR_EVALUATION");
  assert.deepEqual(state, { count: 2, previous: 1 });
});
test("capture siblings share old locals and publish together", () => {
  const u = unit();
  const a = adapter();
  const group = a.compileCapture({
    base: base(u),
    targets: {
      candidate: { type: U, value: wrap("2") },
      copy: { type: U, value: wrap("$local.candidate") },
    },
  });
  assert.deepEqual({ ...group.apply(frame(u)) }, { candidate: 2, copy: 7 });
});
test("allocator runs once after pure siblings and never schedules", () => {
  const refs = createReferenceRegistry("alloc");
  let calls = 0;
  const a = adapter({ references: refs.contract });
  const u = unit();
  const group = a.compileCapture({
    base: base(u),
    targets: {
      aTimer: { type: timerType, value: wrap("$runtime.nextTimerId()") },
      zCount: { type: N, value: wrap("$state.count+1") },
    },
  });
  const cap = {
    nextTimerId: () => {
      calls++;
      return refs.allocate(timerType, "subscription-a", () => true);
    },
  };
  const next = group.apply(frame(u), cap);
  assert.equal(calls, 1);
  assert.equal(next.zCount, 3);
  assert.equal(refs.contract.isReference(next.aTimer), true);
  const bad = a.compileCapture({
    base: base(u),
    targets: {
      aTimer: { type: timerType, value: wrap("$runtime.nextTimerId()") },
      zCount: { type: N, value: wrap('$error("fail")') },
    },
  });
  failure(() => bad.apply(frame(u), cap), "RSL_EXPR_EVALUATION");
  assert.equal(calls, 1);
  failure(
    () =>
      a.compile(unit("$runtime.nextTimerId()", { expectedType: timerType })),
    "RSL_EXPR_EFFECT",
  );
});
test("allocator-only capture still checks event and owner context", () => {
  const refs = createReferenceRegistry("only");
  const a = adapter({ references: refs.contract }),
    u = unit();
  let calls = 0;
  const group = a.compileCapture({
    base: base(u),
    targets: { id: { type: timerType, value: wrap("$runtime.nextTimerId()") } },
  });
  failure(
    () =>
      group.evaluate(
        frame(u, { subscription: { id: "subscription-a", closed: true } }),
        {
          nextTimerId: () => {
            calls++;
            return "bad";
          },
        },
      ),
    "RSL_EXPR_REFERENCE",
  );
  assert.equal(calls, 0);
});
test("typed resource references require current ownership and cannot escape business output", () => {
  const refs = createReferenceRegistry("ownership");
  const id = refs.allocate(timerType, "subscription-a", () => true);
  const a = adapter({ references: refs.contract });
  const u = unit("$local.timer", {
    slot: "resourceSelector",
    expectedType: timerType,
  });
  u.context.locals.timer = timerType;
  const e = a.compile(u);
  assert.strictEqual(
    e.evaluate(frame(u, { local: { candidate: 1, timer: id } })),
    id,
  );
  failure(
    () =>
      e.evaluate(
        frame(u, {
          local: { candidate: 1, timer: id },
          subscription: { id: "other", closed: false },
        }),
      ),
    "RSL_EXPR_REFERENCE",
  );
  refs.revoke(id);
  failure(
    () => e.evaluate(frame(u, { local: { candidate: 1, timer: id } })),
    "RSL_EXPR_REFERENCE",
  );
  const output = unit("$notification.value", { slot: "emitNext" });
  failure(
    () =>
      a
        .compile(output, {
          directValue: { contractId: "any", accepts: () => true },
        })
        .evaluate(
          frame(output, {
            notification: {
              source: "source",
              kind: "next",
              value: id,
              time: 10,
              sequence: 0,
              contextId: "virtual",
            },
          }),
        ),
    "RSL_EXPR_TYPE",
  );
});
test("same-time timer identities remain distinct and compare by identity", () => {
  const refs = createReferenceRegistry("equal-time");
  const x = refs.allocate(timerType, "subscription-a", () => true),
    y = refs.allocate(timerType, "subscription-a", () => true);
  const u = unit("$local.x = $local.y", { expectedType: B });
  u.context.locals = { x: timerType, y: timerType };
  const e = adapter({ references: refs.contract }).compile(u);
  assert.equal(e.evaluate(frame(u, { local: { x, y } })), false);
  assert.equal(e.evaluate(frame(u, { local: { x, y: x } })), true);
});
test("Observable references are selected without subscribing", () => {
  const refs = createReferenceRegistry("observable");
  let subscriptions = 0;
  const value = {
    subscribe() {
      subscriptions++;
    },
  };
  const type = { kind: "observable", value: N };
  refs.register(value, type, "subscription-a", () => true);
  const u = unit("$local.inner", {
    slot: "resourceSelector",
    expectedType: type,
  });
  u.context.locals.inner = type;
  assert.strictEqual(
    adapter({ references: refs.contract })
      .compile(u)
      .evaluate(frame(u, { local: { inner: value, candidate: 1 } })),
    value,
  );
  assert.equal(subscriptions, 0);
});

function emission(
  a,
  u = unit(),
  next = "$notification.value",
  when = "true",
  timing = "$rsl.time.now",
) {
  return {
    next: a.compile({ ...u, slot: "emitNext", value: wrap(next) }),
    emitWhen: a.compile({
      ...u,
      slot: "emitWhen",
      expectedType: B,
      value: wrap(when),
    }),
    timing: a.compile({
      ...u,
      slot: "emitTiming",
      expectedType: timing === "$rsl.time.now" ? temporal() : N,
      value: wrap(timing),
    }),
  };
}
test("emission validates next, permission and timing in order even when suppressed", () => {
  const order = [];
  const contract = helper([], N),
    bool = helper([], B);
  const helpers = { candidate: contract, permission: bool, at: contract };
  const a = adapter({
    helpers: {
      candidate: {
        contract,
        call: () => {
          order.push("next");
          return 5;
        },
      },
      permission: {
        contract: bool,
        call: () => {
          order.push("when");
          return false;
        },
      },
      at: {
        contract,
        call: () => {
          order.push("timing");
          return 10;
        },
      },
    },
  });
  const u = unit("1", { helpers });
  const operands = emission(a, u, "$candidate()", "$permission()", "$at()");
  let deliveries = 0;
  const result = evaluateEmission(operands, frame(u), {
    isActive: () => true,
    validateTiming: (t) => t === 10,
    deliver: () => deliveries++,
  });
  assert.deepEqual(order, ["next", "when", "timing"]);
  assert.equal(result.delivered, false);
  assert.equal(deliveries, 0);
});
test("false permission cannot hide invalid timing or candidate failure", () => {
  const a = adapter();
  failure(
    () =>
      evaluateEmission(emission(a, unit(), "1", "false", "11"), frame(), {
        isActive: () => true,
        validateTiming: (t) => t === 10,
        deliver: () => assert.fail(),
      }),
    "RSL_EXPR_TIME",
  );
  failure(
    () =>
      evaluateEmission(emission(a, unit(), '$error("bad")', "false"), frame(), {
        isActive: () => true,
        validateTiming: () => true,
        deliver: () => assert.fail(),
      }),
    "RSL_EXPR_EVALUATION",
  );
});
for (const candidate of [0, false, "", null, [], [1, 2]])
  test(`emission preserves one candidate: ${JSON.stringify(candidate)}`, () => {
    const a = adapter(),
      u = unit();
    const outputs = [];
    const f = frame(u, {
      notification: {
        source: "source",
        kind: "next",
        value: candidate,
        time: 10,
        sequence: 0,
        contextId: "virtual",
      },
    });
    evaluateEmission(emission(a, u), f, {
      isActive: () => true,
      validateTiming: (t) => t === 10,
      deliver: (value) => outputs.push(value),
    });
    assert.equal(outputs.length, 1);
    assert.strictEqual(outputs[0], candidate);
  });
test("live cancellation wins over an older open frame snapshot", () => {
  let active = true;
  const f = frame();
  active = false;
  const outputs = [];
  assert.equal(f.bindings.rsl.subscription.closed, false);
  evaluateEmission(emission(adapter()), f, {
    isActive: () => active,
    validateTiming: () => true,
    deliver: (v) => outputs.push(v),
  });
  assert.deepEqual(outputs, []);
});
test("reentrant reactions restore outer event/locals while observing committed nested state", () => {
  const a = adapter(),
    u = unit();
  u.context.locals = {};
  const capture = a.compileCapture({
    base: base(u),
    targets: { packet: { type: U, value: wrap("$notification.value") } },
  });
  const later = structuredClone(u);
  later.context.locals.packet = U;
  const increment = a.compileTransition({
    base: base(later),
    targets: { count: { type: N, value: wrap("$state.count+1") } },
  });
  const output = emission(a, later, "$local.packet");
  const scope = createReactionScope({
    parameters: { n: 2, prices: [], items: [] },
    initialState: { count: 0, previous: 0 },
    bindings: { minimum: 1 },
    clock: createLogicalClock("virtual", "frame", () => 10),
    executionId: "execution-a",
    operatorId: "operator-a",
    subscriptionId: "subscription-a",
    isActive: () => true,
  });
  const seen = [];
  const dispatch = (value) =>
    scope.run(
      {
        source: "source",
        kind: "next",
        value,
        time: 10,
        sequence: 0,
        contextId: "virtual",
      },
      "next",
      (access) => {
        access.capture(capture);
        access.transition(increment);
        evaluateEmission(output, access.frame(), {
          isActive: () => true,
          validateTiming: () => true,
          deliver: (packet) => {
            seen.push([packet, scope.state().count]);
            if (packet === "outer") dispatch("inner");
          },
        });
        const f = access.frame();
        seen.push([
          f.bindings.notification.value,
          f.bindings.local.packet,
          f.bindings.state.count,
        ]);
        access.transition(increment);
      },
    );
  dispatch("outer");
  assert.deepEqual(seen, [
    ["outer", 1],
    ["inner", 2],
    ["inner", "inner", 2],
    ["outer", "outer", 3],
  ]);
  assert.equal(scope.state().count, 4);
});
test("independent owners have independent memory; sharing occurs only by explicit scope reuse", () => {
  const make = () =>
    createReactionScope({
      parameters: {},
      initialState: { count: 0, previous: 0 },
      bindings: { minimum: 1 },
      clock: createLogicalClock("virtual", "frame", () => 10),
      executionId: "e",
      operatorId: "o",
      subscriptionId: "subscription-a",
      isActive: () => true,
    });
  const left = make(),
    right = make();
  const u = unit();
  u.context.parameters = {};
  u.context.locals = {};
  const group = adapter().compileTransition({
    base: base(u),
    targets: { count: { type: N, value: wrap("$state.count+1") } },
  });
  left.run(
    {
      source: "source",
      kind: "next",
      value: 1,
      time: 10,
      sequence: 0,
      contextId: "virtual",
    },
    "next",
    (r) => {
      r.transition(group);
    },
  );
  assert.equal(left.state().count, 1);
  assert.equal(right.state().count, 0);
});
test("failed later action retains an earlier committed transition", () => {
  const u = unit();
  u.context.locals = {};
  const a = adapter();
  const good = a.compileTransition({
    base: base(u),
    targets: { count: { type: N, value: wrap("$state.count+1") } },
  });
  const bad = a.compile(unit('$error("later")'));
  const scope = createReactionScope({
    parameters: { n: 2, prices: [], items: [] },
    initialState: { count: 0, previous: 0 },
    bindings: { minimum: 1 },
    clock: createLogicalClock("virtual", "frame", () => 10),
    executionId: "e",
    operatorId: "o",
    subscriptionId: "subscription-a",
    isActive: () => true,
  });
  failure(
    () =>
      scope.run(
        {
          source: "source",
          kind: "next",
          value: 1,
          time: 10,
          sequence: 0,
          contextId: "virtual",
        },
        "next",
        (r) => {
          r.transition(good);
          bad.evaluate(r.frame());
        },
      ),
    "RSL_EXPR_EVALUATION",
  );
  assert.equal(scope.state().count, 1);
});
test("reaction access expires after return and cannot introduce an async boundary", () => {
  const scope = createReactionScope({
    parameters: {},
    initialState: {},
    clock: createLogicalClock("v", "frame", () => 0),
    executionId: "e",
    operatorId: "o",
    subscriptionId: "s",
    isActive: () => true,
  });
  let saved;
  scope.run({}, "test", (r) => {
    saved = r;
  });
  failure(() => saved.frame(), "RSL_EXPR_CONTEXT");
  failure(
    () => scope.run({}, "test", () => Promise.resolve()),
    "RSL_EXPR_ASYNC",
  );
});
