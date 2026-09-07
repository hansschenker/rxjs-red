import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  validateExpression,
  validateCaptureGroup,
  validateTransitionGroup,
  parseExpressionDocument,
  expressionUnitSchema,
  STANDARD_FUNCTIONS,
} from "../dist/index.js";

const p = (name) => ({ kind: "primitive", name });
const N = p("number"),
  B = p("boolean"),
  S = p("string"),
  U = p("unknown");
const array = (items) => ({ kind: "array", items });
const record = (fields) => ({ kind: "record", fields });
const time = (kind = "LogicalTime", id = "virtual") => ({
  kind: "generic",
  ref: `rsl.${kind}`,
  arguments: [{ kind: "named", ref: id }],
});
const timer = { kind: "generic", ref: "rsl.TimerId", arguments: [] };
const wrap = (body) => `{% ${body} %}`;
function unit(body = "1", changes = {}) {
  const result = {
    profile: "rsl.expression-context/0.1",
    dialect: "rsl.jsonata.core-1",
    QueryLanguage: "JSONata",
    slot: "capture",
    mode: "expression",
    value: wrap(body),
    expectedType: U,
    context: {
      parameters: {
        increment: N,
        minimum: N,
        prices: array(N),
        items: array(record({ total: N, id: S })),
        dueTime: time("Duration"),
        otherTime: time("LogicalTime", "other"),
      },
      state: { count: N, ready: B },
      locals: { candidate: N },
      bindings: {
        minimum: { type: N, owner: "operator", source: "parameters.minimum" },
      },
      clock: { id: "virtual", unit: "frame" },
      sharedConnection: false,
      event: {
        source: "source",
        kind: "next",
        valueType: record({ code: S, n: N }),
      },
    },
    types: {},
    helpers: {
      domain_double: {
        parameters: [N],
        output: N,
        purity: "pure",
        evaluation: "synchronous",
        version: "1.0.0",
      },
    },
    location: { file: "fixture.yaml", fieldPath: "/reactions/next/steps/0" },
    ...changes,
  };
  return result;
}
const validate = (body, changes = {}) =>
  validateExpression(unit(body, changes));
function accepted(body, changes = {}) {
  const r = validate(body, changes);
  assert.equal(r.valid, true, JSON.stringify(r.diagnostics));
  return r;
}
function rejected(body, code, modify = () => {}, changes = {}) {
  const u = unit(body, changes);
  modify(u);
  const r = validateExpression(u);
  assert.equal(r.valid, false, body);
  assert.ok(
    r.diagnostics.some((d) => d.code === code),
    JSON.stringify(r.diagnostics),
  );
  return r;
}

const positives = [
  ["named bound field", "$parameters.minimum+1"],
  ["explicit named value", "$minimum+1"],
  ["canonical event", "$notification.value.code"],
  ["event alias", "$rsl.event.value.code"],
  ["state alias", "$rsl.memory.count"],
  ["local alias", "$rsl.locals.candidate"],
  [
    "regex permission",
    "$count($match($notification.value.code,/^RSL-[0-9]+$/))>0",
  ],
  ["regex extraction", "$match($notification.value.code,/[0-9]+/)[0].match"],
  [
    "regex literal containing reserved text",
    "$contains('$runtime.nextTimerId()', /runtime/)",
  ],
  ["text containing a forbidden function", "'$eval($states.input)'"],
  [
    "lexical binding",
    "($subtotal := $sum($parameters.prices); $subtotal * 1.2)",
  ],
  ["nested predicate", "$parameters.items[total > $minimum].id"],
  ["nested current value", "$parameters.prices[$ > 2]"],
  ["higher-order collection", "$map($parameters.prices,function($v,$i){$v*2})"],
  ["registered pure helper", "$domain_double($notification.value.n)"],
  ["pure function alias", "($f:=$domain_double;$f(2))"],
  ["standard function alias", "($f:=$string;$f(2))"],
  ["lexical closure", "($n:=3;$f:=function($v){$v+$n};$f(2))"],
  [
    "recursive pure lexical function",
    "($f:=function($n){$n=0?1:$n*$f($n-1)};$f(3))",
  ],
  ["function chaining", "$notification.value.code ~> $uppercase()"],
  ["partial application", "($head:=$substring(?,0,2);$head('abcd'))"],
  ["array construction", "[1,2,3]"],
  [
    "object construction",
    "{'packet':$notification.value,'count':$state.count}",
  ],
  ["range construction", "[1..3]"],
  ["collection grouping", "$parameters.items{'total':$sum(total)}"],
  ["sort keys", "$parameters.items^(>total,<id)"],
  [
    "focus and index bindings",
    "$parameters.items@$v[$v.total>0]#$i.{'v':$v.id,'i':$i}",
  ],
  ["object transform", "$notification.value ~> |$|{'n':2}|"],
  ["JSONata internal Boolean conversion", "'nonempty' ? 1 : 0"],
  ["fixed date conversion", "$toMillis('1970-01-01T00:00:01.000Z')"],
  [
    "explicit failure remains unevaluated",
    "$error('must not execute during validation')",
  ],
  ["literal lookup of context member", "$lookup($notification,'value').code"],
  ["captured alias of context", "($event:=$notification;$event.value.code)"],
  [
    "function returning context",
    "($f:=function(){$notification};$f().value.code)",
  ],
  ["distinct now and event timestamps", "$rsl.time.now - $notification.time"],
  ["duration plus time", "$notification.time+$parameters.dueTime"],
  ["time comparison", "$rsl.time.now >= $notification.time"],
  [
    "single-array shape expression",
    "[$map($parameters.prices,function($v){$v*2})]",
  ],
];
for (const [name, body] of positives)
  test(`valid: ${name}`, () => accepted(body));

const negatives = [
  ["undeclared variable", "$notDeclared", "RSL_EXPR_BINDING"],
  ["no promoted parameter", "$increment", "RSL_EXPR_BINDING"],
  ["implicit root", "value.code", "RSL_EXPR_CONTEXT"],
  ["implicit dollar", "$", "RSL_EXPR_CONTEXT"],
  ["root document", "$$.value", "RSL_EXPR_CONTEXT"],
  ["ASL scope leak", "$states.input", "RSL_EXPR_CONTEXT"],
  ["previous state lifetime", "$previousState.count", "RSL_EXPR_CONTEXT"],
  ["shared metadata absent", "$rsl.connection.id", "RSL_EXPR_CONTEXT"],
  ["misspelled state", "$state.cout", "RSL_EXPR_CONTEXT"],
  ["unavailable local", "$local.future", "RSL_EXPR_CONTEXT"],
  ["bare runtime capability", "$runtime", "RSL_EXPR_EFFECT"],
  ["nested allocator", "$runtime.nextTimerId()+1", "RSL_EXPR_EFFECT"],
  ["allocator alias", "($f:=$runtime.nextTimerId;$f())", "RSL_EXPR_EFFECT"],
  [
    "dynamic runtime access",
    "$lookup($runtime,'nextTimerId')()",
    "RSL_EXPR_EFFECT",
  ],
  ["ambient now", "$now()", "RSL_EXPR_DIALECT"],
  ["ambient millis", "$millis()", "RSL_EXPR_DIALECT"],
  ["ambient random", "$random()", "RSL_EXPR_DIALECT"],
  ["ambient shuffle", "$shuffle([1,2])", "RSL_EXPR_DIALECT"],
  ["dynamic expression evaluation", "$eval('1+1')", "RSL_EXPR_DIALECT"],
  ["indirect excluded function", "($f:=$random;$f())", "RSL_EXPR_DIALECT"],
  ["context shadow", "($state:=1;$state)", "RSL_EXPR_BINDING"],
  ["builtin shadow", "($map:=1;$map)", "RSL_EXPR_BINDING"],
  [
    "lambda context shadow",
    "$map([1],function($notification){1})",
    "RSL_EXPR_BINDING",
  ],
  [
    "focus context shadow",
    "$parameters.items@$state.total",
    "RSL_EXPR_BINDING",
  ],
  [
    "index context shadow",
    "$parameters.items#$state.total",
    "RSL_EXPR_BINDING",
  ],
  [
    "undeclared inside predicate",
    "$parameters.items[total > $missing]",
    "RSL_EXPR_BINDING",
  ],
  [
    "undeclared inside grouping",
    "$parameters.items{'x':$missing}",
    "RSL_EXPR_BINDING",
  ],
  [
    "undeclared inside sort",
    "$parameters.items^($missing)",
    "RSL_EXPR_BINDING",
  ],
  [
    "undeclared inside transform",
    "$notification.value ~> |$|{'n':$missing}|",
    "RSL_EXPR_BINDING",
  ],
  ["lexical block escape", "($x:=1);$x", "RSL_EXPR_SYNTAX"],
  ["untrusted callback", "$map([1],$notification.value)", "RSL_EXPR_EFFECT"],
  ["untrusted matcher", "$match('abc',$notification.value)", "RSL_EXPR_EFFECT"],
  ["callable output", "function($v){$v}", "RSL_EXPR_TYPE"],
  ["nested callable output", "{'a':{'b':function($v){$v}}}", "RSL_EXPR_TYPE"],
  ["array callable output", "[{'f':function($v){$v}}]", "RSL_EXPR_TYPE"],
  ["primitive numeric mismatch", "'a'+1", "RSL_EXPR_TYPE"],
  ["helper argument mismatch", "$domain_double('a')", "RSL_EXPR_TYPE"],
  ["helper arity mismatch", "$domain_double(1,2)", "RSL_EXPR_TYPE"],
  ["clock mixing", "$notification.time+$parameters.otherTime", "RSL_EXPR_TIME"],
  ["two absolute times", "$notification.time+$rsl.time.now", "RSL_EXPR_TIME"],
  [
    "duration minus instant",
    "$parameters.dueTime-$notification.time",
    "RSL_EXPR_TIME",
  ],
  ["newer dialect syntax", "$missing ?? 1", "RSL_EXPR_SYNTAX"],
  [
    "dynamic context key",
    "$lookup($notification,$notification.value.code)",
    "RSL_EXPR_CONTEXT",
  ],
  ["context transformation bypass", "$merge([$notification])", "RSL_EXPR_TYPE"],
  [
    "nested context dynamic bypass",
    "$lookup({'n':$notification},$notification.value.code).value",
    "RSL_EXPR_CONTEXT",
  ],
];
for (const [name, body, code] of negatives)
  test(`invalid: ${name}`, () => rejected(body, code));

test("guard type cannot be weakened by request metadata", () =>
  rejected("1", "RSL_EXPR_TYPE", () => {}, { slot: "guard", expectedType: U }));
test("strict Boolean rejects number", () =>
  rejected("1", "RSL_EXPR_TYPE", () => {}, { slot: "guard", expectedType: B }));
test("Boolean guard accepted", () =>
  accepted("$state.ready", { slot: "guard", expectedType: B }));
test("unknown matcher result requires a runtime Boolean check", () => {
  const r = accepted("$match($notification.value.code,/RSL/)", {
    slot: "guard",
    expectedType: B,
  });
  assert.ok(r.runtimeChecks.some((c) => c.kind === "result-type"));
});
test("initialization allows parameters only", () =>
  accepted("$parameters.increment", { slot: "initial" }));
test("initialization rejects retained state", () =>
  rejected("$state.count", "RSL_EXPR_CONTEXT", () => {}, { slot: "initial" }));
test("initialization rejects event alias", () =>
  rejected("$rsl.event.value", "RSL_EXPR_CONTEXT", () => {}, {
    slot: "initial",
  }));
test("transition exposes previous state", () =>
  accepted("$previousState.count+1", { slot: "transition" }));
test("transition exposes previous memory alias", () =>
  accepted("$rsl.previousMemory.count+1", { slot: "transition" }));
test("shared connection metadata is explicit", () => {
  const u = unit("$rsl.connection.id");
  u.context.sharedConnection = true;
  assert.equal(validateExpression(u).valid, true);
});
test("completion payload access rejected", () =>
  rejected(
    "$notification.value",
    "RSL_EXPR_CONTEXT",
    (u) => (u.context.event = { source: "source", kind: "complete" }),
  ));
test("completion alias access rejected", () =>
  rejected(
    "$rsl.event.value",
    "RSL_EXPR_CONTEXT",
    (u) => (u.context.event = { source: "source", kind: "complete" }),
  ));
test("completion lookup alias rejected", () =>
  rejected(
    "($f:=$lookup;$f($notification,'value'))",
    "RSL_EXPR_CONTEXT",
    (u) => (u.context.event = { source: "source", kind: "complete" }),
  ));
test("completion context-returning closure rejected", () =>
  rejected(
    "($f:=function(){$notification};$f().value)",
    "RSL_EXPR_CONTEXT",
    (u) => (u.context.event = { source: "source", kind: "complete" }),
  ));
test("completion explicit alias rejected", () =>
  rejected(
    "($e:=$notification;$e.value)",
    "RSL_EXPR_CONTEXT",
    (u) => (u.context.event = { source: "source", kind: "complete" }),
  ));
test("error payload is distinct", () => {
  const u = unit("$notification.error");
  u.context.event = { source: "source", kind: "error", errorType: U };
  assert.equal(validateExpression(u).valid, true);
});
test("timer has identity and target time", () => {
  const u = unit("$notification.time >= $notification.targetTime");
  u.context.event = { source: "timer", kind: "next" };
  assert.equal(validateExpression(u).valid, true);
});
test("timer has no business payload", () =>
  rejected(
    "$notification.value",
    "RSL_EXPR_CONTEXT",
    (u) => (u.context.event = { source: "timer", kind: "next" }),
  ));
test("unsubscribe is not completion", () => {
  const u = unit("$rsl.subscription.closed");
  u.context.event = { source: "downstream", kind: "unsubscribe" };
  assert.equal(validateExpression(u).valid, true);
});
test("invalid event combination rejected", () =>
  rejected(
    "1",
    "RSL_EXPR_CONTEXT",
    (u) => (u.context.event = { source: "timer", kind: "complete" }),
  ));
test("completion cannot declare next type", () =>
  rejected(
    "1",
    "RSL_EXPR_CONTEXT",
    (u) =>
      (u.context.event = { source: "source", kind: "complete", valueType: N }),
  ));
test("reaction requires event descriptor", () =>
  rejected("1", "RSL_EXPR_CONTEXT", (u) => delete u.context.event));
test("plain text wrapper marker is literal", () =>
  accepted("unused", {
    mode: "template",
    value: "Hello {% $unbound %}",
    expectedType: S,
  }));
test("literal mode never parses wrappers", () => {
  const r = accepted("unused", {
    mode: "literal",
    value: "{% $unbound %}",
    expectedType: S,
  });
  assert.deepEqual(r.requirements.bindings, []);
  assert.deepEqual(r.runtimeChecks, []);
});
test("result string is not rescanned", () =>
  accepted("'{% $unbound %}'", { expectedType: S }));
test("no leading-space expression recognition", () =>
  accepted("unused", {
    mode: "template",
    value: " {% $unbound %}",
    expectedType: S,
  }));
test("broken wrapper rejected", () =>
  rejected("unused", "RSL_EXPR_WRAPPER", () => {}, { value: "{% 1" }));
test("empty wrapper rejected", () =>
  rejected("unused", "RSL_EXPR_WRAPPER", () => {}, { value: "{% %}" }));
test("template keys never parsed", () =>
  accepted("unused", {
    mode: "template",
    value: { "{% $unknown %}": "literal" },
  }));
test("nested template expression checked", () =>
  rejected("unused", "RSL_EXPR_BINDING", () => {}, {
    mode: "template",
    value: { a: [wrap("$unknown")] },
  }));
test("diagnostic identifies nested template field", () => {
  const r = rejected("unused", "RSL_EXPR_BINDING", () => {}, {
    mode: "template",
    value: { "a/b": [wrap("$unknown")] },
  });
  assert.ok(r.diagnostics.some((d) => d.fieldPath.endsWith("/a~1b/0")));
});
test("literal null is a value", () =>
  accepted("unused", {
    mode: "literal",
    value: null,
    expectedType: p("null"),
  }));
test("literal false is a value", () =>
  accepted("unused", { mode: "literal", value: false, expectedType: B }));
test("known array-shape mismatch rejected", () =>
  rejected("unused", "RSL_EXPR_TYPE", () => {}, {
    mode: "literal",
    value: [1, "a"],
    expectedType: array(N),
  }));
test("unknown payload member leaves runtime presence check", () => {
  const r = accepted("$notification.value.optional");
  assert.ok(r.runtimeChecks.some((c) => c.kind === "presence"));
});
test("known void function has missing result", () =>
  rejected("$assert(true)", "RSL_EXPR_MISSING"));
test("allocator admitted only in direct capture", () => {
  const r = accepted("$runtime.nextTimerId()", { expectedType: timer });
  assert.deepEqual(r.requirements.capabilities, ["runtime.nextTimerId"]);
});
test("allocator forbidden in guard", () =>
  rejected("$runtime.nextTimerId()", "RSL_EXPR_EFFECT", () => {}, {
    slot: "guard",
    expectedType: B,
  }));
test("allocator forbidden in template child", () =>
  rejected("unused", "RSL_EXPR_EFFECT", () => {}, {
    mode: "template",
    value: { id: wrap("$runtime.nextTimerId()") },
  }));
test("allocator decoration cannot bypass restriction", () =>
  rejected("$runtime.nextTimerId()[0]", "RSL_EXPR_EFFECT"));
test("schema rejects async helper contract", () =>
  rejected(
    "1",
    "RSL_SCHEMA_STRUCTURE",
    (u) => (u.helpers.domain_double.evaluation = "asynchronous"),
  ));
test("schema rejects effectful helper contract", () =>
  rejected(
    "1",
    "RSL_SCHEMA_STRUCTURE",
    (u) => (u.helpers.domain_double.purity = "effectful"),
  ));
test("schema rejects unrecognized fields", () =>
  rejected("1", "RSL_SCHEMA_STRUCTURE", (u) => (u.unexpected = true)));
test("schema rejects wrong profile", () =>
  rejected(
    "1",
    "RSL_SCHEMA_STRUCTURE",
    (u) => (u.dialect = "rsl.jsonata.sync.v1"),
  ));
test("schema rejects empty type union", () =>
  rejected(
    "1",
    "RSL_SCHEMA_STRUCTURE",
    (u) => (u.expectedType = { kind: "union", members: [] }),
  ));
test("schema rejects unresolved named types", () =>
  rejected(
    "1",
    "RSL_EXPR_REFERENCE",
    (u) => (u.expectedType = { kind: "named", ref: "Missing" }),
  ));
test("schema rejects cyclic aliases", () =>
  rejected("1", "RSL_EXPR_REFERENCE", (u) => {
    u.types = {
      A: { kind: "named", ref: "B" },
      B: { kind: "named", ref: "A" },
    };
  }));
test("named type resolution", () => {
  const u = unit("1", { expectedType: { kind: "named", ref: "Number" } });
  u.types.Number = N;
  assert.equal(validateExpression(u).valid, true);
});
test("binding helper collision", () =>
  rejected(
    "1",
    "RSL_EXPR_BINDING",
    (u) =>
      (u.context.bindings.domain_double = {
        type: N,
        owner: "operator",
        source: "config",
      }),
  ));
test("unshared connection binding rejected", () =>
  rejected(
    "1",
    "RSL_EXPR_CONTEXT",
    (u) =>
      (u.context.bindings.cache = {
        type: N,
        owner: "connection",
        source: "config",
      }),
  ));
test("validation is deterministic and does not mutate input", () => {
  const u = unit("$domain_double(2)");
  const before = structuredClone(u);
  assert.deepEqual(validateExpression(u), validateExpression(u));
  assert.deepEqual(u, before);
});
test("compiled requirements include partial function dependency", () => {
  const r = accepted("($f:=$substring(?,0,2);$f('abcd'))");
  assert.ok(r.requirements.functions.includes("substring"));
});
test("validation never runs user expression", () => {
  const r = accepted("$error('a validator must not evaluate me')");
  assert.ok(r.requirements.functions.includes("error"));
});
test("programmatic getters are never invoked", () => {
  let calls = 0;
  const u = unit();
  Object.defineProperty(u, "trap", {
    enumerable: true,
    get() {
      calls++;
      throw Error("ran");
    },
  });
  const r = validateExpression(u);
  assert.equal(r.valid, false);
  assert.equal(calls, 0);
});
test("programmatic cyclic data rejected", () => {
  const u = unit();
  u.loop = u;
  assert.equal(validateExpression(u).valid, false);
});
test("programmatic undefined rejected", () => {
  const u = unit();
  u.value = undefined;
  assert.equal(validateExpression(u).valid, false);
});
test("programmatic unsafe integer rejected", () => {
  const u = unit();
  u.value = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(validateExpression(u).valid, false);
});
test("oversized expression diagnosed", () =>
  rejected("x".repeat(66000), "RSL_EXPR_LIMIT"));
test("source offset retained for binding diagnostic", () => {
  const r = rejected("$nope", "RSL_EXPR_BINDING");
  assert.equal(r.diagnostics[0].file, "fixture.yaml");
  assert.equal(typeof r.diagnostics[0].offset, "number");
  assert.equal(r.diagnostics[0].line, 1);
});

function groupBase() {
  const { value, expectedType, slot, mode, ...base } = unit();
  return base;
}
test("capture siblings cannot see new binding", () => {
  const base = groupBase();
  const result = validateCaptureGroup({
    base,
    targets: {
      newValue: { type: N, value: wrap("1") },
      dependent: { type: N, value: wrap("$local.newValue") },
    },
  });
  assert.equal(result.valid, false);
  assert.equal(result.nextContext, undefined);
});
test("next capture sees previously produced binding", () => {
  const first = validateCaptureGroup({
    base: groupBase(),
    targets: { newValue: { type: N, value: wrap("1") } },
  });
  assert.equal(first.valid, true);
  const second = validateCaptureGroup({
    base: { ...groupBase(), context: first.nextContext },
    targets: { dependent: { type: N, value: wrap("$local.newValue") } },
  });
  assert.equal(second.valid, true);
});
test("failed capture group does not advance context", () => {
  const r = validateCaptureGroup({
    base: groupBase(),
    targets: {
      a: { type: N, value: wrap("1") },
      b: { type: N, value: wrap("$nope") },
    },
  });
  assert.equal(r.nextContext, undefined);
});
test("canonical capture combines one allocator and time", () => {
  const r = validateCaptureGroup({
    base: groupBase(),
    targets: {
      newTimerId: { type: timer, value: wrap("$runtime.nextTimerId()") },
      newTimerTarget: {
        type: time(),
        value: wrap("$notification.time+$parameters.dueTime"),
      },
    },
  });
  assert.equal(r.valid, true, JSON.stringify(r));
});
test("two allocators in one capture rejected", () => {
  const r = validateCaptureGroup({
    base: groupBase(),
    targets: {
      a: { type: timer, value: wrap("$runtime.nextTimerId()") },
      b: { type: timer, value: wrap("$runtime.nextTimerId()") },
    },
  });
  assert.equal(r.valid, false);
  assert.ok(r.diagnostics.some((d) => d.code === "RSL_EXPR_EFFECT"));
});
test("capture local type cannot change", () => {
  const r = validateCaptureGroup({
    base: groupBase(),
    targets: { candidate: { type: S, value: "string" } },
  });
  assert.equal(r.valid, false);
});
test("transition only targets declared state", () => {
  const r = validateTransitionGroup({
    base: groupBase(),
    targets: { missing: { type: N, value: 1 } },
  });
  assert.equal(r.valid, false);
});
test("transition aliases use same context", () => {
  const r = validateTransitionGroup({
    base: groupBase(),
    targets: {
      count: { type: N, value: wrap("$previousState.count+1") },
      ready: { type: B, value: wrap("$state.ready") },
    },
  });
  assert.equal(r.valid, true, JSON.stringify(r));
});

test("schema is 2020-12 and independently serializable", () => {
  assert.equal(
    expressionUnitSchema.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(expressionUnitSchema)),
    expressionUnitSchema,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync("schema/expression-unit.schema.json", "utf8")),
    expressionUnitSchema,
  );
});
test("all 60 standard functions are inventoried, including digit-containing names", () => {
  assert.equal(STANDARD_FUNCTIONS.length, 60);
  assert.equal(new Set(STANDARD_FUNCTIONS).size, 60);
  assert.ok(!STANDARD_FUNCTIONS.includes("random"));
  const source = fs.readFileSync(new URL(import.meta.resolve("jsonata")), "utf8");
  const actual = [...source.matchAll(/staticFrame.bind\('([A-Za-z0-9]+)'/g)]
    .map((m) => m[1])
    .filter((n) => !["random", "shuffle", "eval"].includes(n))
    .sort();
  assert.deepEqual(STANDARD_FUNCTIONS, actual);
});
test("base64 names are ordinary supported functions", () => {
  accepted("$base64encode('a')", { expectedType: S });
  accepted("$base64decode('YQ==')", { expectedType: S });
});
test("partial lookup retains context provenance", () =>
  rejected(
    "($get:=$lookup(?,'value');$get($notification))",
    "RSL_EXPR_CONTEXT",
    (u) => (u.context.event = { source: "source", kind: "complete" }),
  ));
test("unspecialized context parameter fails closed", () =>
  rejected(
    "(function($e){$lookup($e,'value')})($notification)",
    "RSL_EXPR_CONTEXT",
    (u) => (u.context.event = { source: "source", kind: "complete" }),
  ));
test("conditional context-returning functions fail closed", () =>
  rejected(
    "($f:=$state.ready?function(){$notification}:function(){$notification};$f().value)",
    "RSL_EXPR_CONTEXT",
    (u) => (u.context.event = { source: "source", kind: "complete" }),
  ));
test("time result cannot be Boolean", () =>
  rejected("true", "RSL_EXPR_TIME", () => {}, {
    slot: "emitTiming",
    expectedType: N,
  }));
test("time slot cannot weaken declared type to unknown", () =>
  rejected("10", "RSL_EXPR_TYPE", () => {}, { slot: "emitTiming" }));
test("same-domain emission timing accepted", () =>
  accepted("$notification.time", { slot: "emitTiming", expectedType: time() }));
test("absolute time cannot be a duration alone", () =>
  rejected("$parameters.dueTime", "RSL_EXPR_TIME", () => {}, {
    slot: "emitTiming",
    expectedType: time(),
  }));
test("business output cannot carry a runtime subscription reference", () =>
  rejected("$rsl.subscription.id", "RSL_EXPR_REFERENCE", () => {}, {
    slot: "emitNext",
  }));
test("array constructor flattens an array-valued expression", () =>
  accepted("[$parameters.prices]", { expectedType: array(N) }));
test("array constructor flattens range sequence", () =>
  accepted("[1..3]", { expectedType: array(N) }));
test("explicit nested array constructors retain nesting", () =>
  accepted("[[1,2],[3]]", { expectedType: array(array(N)) }));
test("nested optional template result requires presence check", () => {
  const r = accepted("unused", {
    mode: "template",
    value: { a: wrap("$notification.value.optional") },
  });
  assert.ok(
    r.runtimeChecks.some(
      (c) => c.kind === "presence" && c.fieldPath.endsWith("/a"),
    ),
  );
});
test("JSON source accepts normalized validation unit", () => {
  const parsed = parseExpressionDocument(
    JSON.stringify(unit()),
    "unit.json",
    "json",
  );
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(validateExpression(parsed.document).valid, true);
});
for (const [name, text, format] of [
  ["duplicate JSON key", '{"a":1,"a":2}', "json"],
  ["BOM", "\uFEFFa: b\n", "yaml"],
  ["CRLF", "a: b\r\n", "yaml"],
  ["multiple documents", "a: b\n---\na: c\n", "yaml"],
  ["anchor", "a: &id 1\nb: *id\n", "yaml"],
  ["tag", "a: !!str 1\n", "yaml"],
  ["flow mapping", "a: {b: 1}\n", "yaml"],
  ["single quote", "a: 'text'\n", "yaml"],
  ["folded scalar", "a: >\n  text\n", "yaml"],
  ["implicit null", "a:\n", "yaml"],
  ["non-string key", "1: text\n", "yaml"],
  ["YAML escape", 'a: "\\x41"\n', "yaml"],
  ["hex number", "a: 0xFF\n", "yaml"],
  ["non-NFC source", 'a: "e\u0301"\n', "yaml"],
  ["unsafe number", "a: 9007199254740992\n", "yaml"],
])
  test(`source rejects ${name}`, () =>
    assert.ok(
      parseExpressionDocument(text, "unit", format).diagnostics.length > 0,
    ));
test("source accepts supported block YAML", () => {
  const r = parseExpressionDocument(
    'value: "{% $state.count + 1 %}"\n',
    "unit.yaml",
  );
  assert.deepEqual(r.diagnostics, []);
});
test("source accepts explicit JSON string newline escapes", () => {
  const r = parseExpressionDocument('value: "line1\\nline2"\n', "unit.yaml");
  assert.deepEqual(r.diagnostics, []);
});

test("CLI reports valid unit and exits zero", () => {
  fs.mkdirSync("test/tmp", { recursive: true });
  fs.writeFileSync("test/tmp/valid.json", JSON.stringify(unit()));
  const r = spawnSync(
    process.execPath,
    ["dist/cli.js", "test/tmp/valid.json"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).valid, true);
});
test("CLI reports invalid unit and exits one", () => {
  fs.mkdirSync("test/tmp", { recursive: true });
  fs.writeFileSync("test/tmp/invalid.json", JSON.stringify(unit("$nope")));
  const r = spawnSync(
    process.execPath,
    ["dist/cli.js", "test/tmp/invalid.json"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).valid, false);
});
test("CLI IO failure exits two", () => {
  const r = spawnSync(
    process.execPath,
    ["dist/cli.js", "test/tmp/does-not-exist.json"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 2);
});
