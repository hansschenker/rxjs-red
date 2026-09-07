import {
  createSynchronousAdapter,
  createEvaluationFrame,
  createLogicalClock,
} from "../dist/index.js";

const number = { kind: "primitive", name: "number" };
const expression = {
  profile: "rsl.expression-context/0.1",
  dialect: "rsl.jsonata.core-1",
  QueryLanguage: "JSONata",
  slot: "transition",
  mode: "expression",
  value: "{% $rsl.memory.count + 1 %}",
  expectedType: number,
  context: {
    parameters: {},
    state: { count: number },
    locals: {},
    bindings: {},
    clock: { id: "demo", unit: "frame" },
    sharedConnection: false,
    event: { source: "source", kind: "next", valueType: number },
  },
  types: {},
  helpers: {},
  location: { file: "demo", fieldPath: "/transition/count" },
};

// Compilation does not activate a source or evaluate the expression.
const adapter = createSynchronousAdapter({ helperRegistryVersion: "demo/1" });
const compiled = adapter.compile(expression);

// The execution host creates this frame at the declared transition step.
const frame = createEvaluationFrame({
  phase: "transition",
  parameters: {},
  state: { count: 2 },
  local: {},
  notification: {
    source: "source",
    kind: "next",
    value: 42,
    time: 10,
    sequence: 0,
    contextId: "demo",
  },
  clock: createLogicalClock("demo", "frame", () => 10),
  executionId: "execution-1",
  operatorId: "operator-1",
  subscription: { id: "subscription-1", closed: false },
});

console.log({
  sameStateView: frame.bindings.rsl.memory === frame.bindings.state,
  previousCount: frame.bindings.state.count,
  calculatedCount: compiled.evaluate(frame),
  time: frame.time.now,
});
