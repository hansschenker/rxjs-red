import jsonata from "jsonata";
import { Ajv2020 } from "ajv/dist/2020.js";
import { RegExpParser } from "@eslint-community/regexpp";
import { expressionUnitSchema } from "./schema.js";
import {
  BOOLEAN,
  NUMBER,
  STRING,
  UNKNOWN,
  clockType,
  compatible,
  identityType,
  isTemporal,
  primitive,
  recordType,
  resolve,
  union,
} from "./type-system.js";
import type {
  Diagnostic,
  ExpressionContext,
  ExpressionUnit,
  JsonValue,
  RuntimeCheck,
  TypeRef,
  ValidationResult,
} from "./types.js";

export const STANDARD_FUNCTIONS = Object.freeze(
  "sum count max min average string substring substringBefore substringAfter lowercase uppercase length trim pad match contains replace split join formatNumber formatBase formatInteger parseInteger number floor ceil round abs sqrt power boolean not map zip filter single reduce sift keys lookup append exists spread merge reverse each error assert type sort distinct base64encode base64decode encodeUrlComponent encodeUrl decodeUrlComponent decodeUrl toMillis fromMillis clone"
    .split(" ")
    .sort(),
);
const excluded = new Set(["now", "millis", "random", "shuffle", "eval"]);
const roots = new Set([
  "parameters",
  "state",
  "previousState",
  "notification",
  "local",
  "runtime",
  "rsl",
  "states",
]);
const structural = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
}).compile<ExpressionUnit>(expressionUnitSchema);
const identifier = /^\p{ID_Start}\p{ID_Continue}*$/u;
const sortKeys = (object: object) =>
  Object.keys(object).sort((a, b) => {
    const x = Array.from(a),
      y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
      if (d) return d;
    }
    return x.length - y.length;
  });
const pointer = (key: string) =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");
interface Ast {
  type: string;
  value?: unknown;
  position?: number;
  [key: string]: unknown;
}
const node = (value: unknown): Ast => value as Ast;
const nodes = (value: unknown): Ast[] =>
  Array.isArray(value) ? (value as Ast[]) : [];
interface Callable {
  kind: "standard" | "helper" | "lambda" | "regex" | "transform";
  name?: string;
  output: TypeRef;
  result?: Fact;
  parameters?: readonly TypeRef[];
  partial?: { target: Fact; args: (Fact | null)[] };
}
interface Fact {
  type: TypeRef;
  missing?: boolean;
  callable?: Callable;
  fields?: Record<string, Fact>;
  items?: Fact[];
  view?: boolean;
  origin?: string;
  literal?: unknown;
}
type Environment = Map<string, Fact>;
const fact = (type: TypeRef, extras: Omit<Fact, "type"> = {}): Fact => ({
  type,
  ...extras,
});
const unknown = (): Fact => fact(UNKNOWN, { missing: true });
const containsView = (f: Fact): boolean =>
  Boolean(f.view) ||
  Object.values(f.fields ?? {}).some(containsView) ||
  (f.items ?? []).some(containsView);

/** Checks JSON data without invoking getters, toJSON, helpers, or expressions. */
export function inspectJson(
  value: unknown,
  path = "",
  ancestors = new Set<object>(),
  depth = 0,
): string | undefined {
  if (depth > 96) return `${path}: input exceeds maximum depth 96`;
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string")
    return value === value.normalize("NFC")
      ? undefined
      : `${path}: source strings must be NFC`;
  if (typeof value === "number")
    return Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
      ? undefined
      : `${path}: non-finite or unsafe integer`;
  if (typeof value !== "object") return `${path}: not JSON data`;
  if (ancestors.has(value)) return `${path}: cyclic input`;
  if (
    !Array.isArray(value) &&
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return `${path}: non-plain input object`;
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return `${path}: symbol key`;
    if (Array.isArray(value) && key === "length") continue;
    if (
      Array.isArray(value) &&
      (!/^\d+$/.test(key) || Number(key) >= value.length)
    )
      return `${path}: non-index array property`;
    if (key !== key.normalize("NFC")) return `${path}: non-NFC key`;
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in d)) return `${path}/${key}: accessors are not admitted`;
    const error = inspectJson(
      d.value,
      `${path}/${pointer(key)}`,
      ancestors,
      depth + 1,
    );
    if (error) return error;
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length)
    return `${path}: sparse array`;
  ancestors.delete(value);
}

export function validateExpression(input: unknown): ValidationResult {
  const diagnostics: Diagnostic[] = [],
    runtimeChecks: RuntimeCheck[] = [];
  const functions = new Set<string>(),
    features = new Set<string>(),
    bindings = new Set<string>(),
    capabilities = new Set<string>();
  let unit: ExpressionUnit,
    fieldPath = "",
    expression = "";
  const finish = (): ValidationResult => ({
    valid: diagnostics.length === 0,
    status: diagnostics.length
      ? "invalid"
      : runtimeChecks.length
        ? "valid-with-runtime-checks"
        : "valid",
    diagnostics,
    runtimeChecks: [
      ...new Map(runtimeChecks.map((c) => [JSON.stringify(c), c])).values(),
    ],
    requirements: {
      dialect: "rsl.jsonata.core-1",
      synchronousEvaluation: true,
      functions: [...functions].sort(),
      features: [...features].sort(),
      bindings: [...bindings].sort(),
      capabilities: [...capabilities].sort(),
    },
  });
  const add = (
    code: string,
    message: string,
    ast?: Ast,
    causeCode?: string,
  ) => {
    const offset =
      ast?.position === undefined
        ? undefined
        : Math.min(expression.length, 2 + ast.position);
    const prefix = offset === undefined ? "" : expression.slice(0, offset);
    diagnostics.push({
      code,
      message,
      file: unit?.location.file ?? "<input>",
      fieldPath: fieldPath || unit?.location.fieldPath || "/",
      ...(offset === undefined
        ? {}
        : {
            offset,
            line: prefix.split("\n").length,
            column: Array.from(prefix.split("\n").at(-1) ?? "").length + 1,
          }),
      ...(causeCode ? { causeCode } : {}),
    });
  };
  const check = (kind: RuntimeCheck["kind"], message: string) =>
    runtimeChecks.push({ kind, fieldPath, message });
  const jsonError = inspectJson(input);
  if (jsonError) {
    add("RSL_SCHEMA_JSON", jsonError);
    return finish();
  }
  if (!structural(input)) {
    for (const e of structural.errors ?? [])
      add(
        "RSL_SCHEMA_STRUCTURE",
        `${e.instancePath || "/"} ${e.message ?? e.keyword}`,
      );
    return finish();
  }
  unit = input;
  fieldPath = unit.location.fieldPath;
  const reserved = (name: string) =>
    roots.has(name) ||
    STANDARD_FUNCTIONS.includes(name) ||
    excluded.has(name) ||
    Object.hasOwn(unit.helpers, name);
  const validateName = (name: string, ast?: Ast) => {
    if (
      !identifier.test(name) ||
      Array.from(name).length > 80 ||
      reserved(name)
    )
      add("RSL_EXPR_BINDING", `Invalid or reserved binding $${name}`, ast);
  };
  for (const name of sortKeys(unit.context.bindings)) {
    validateName(name);
    if (
      unit.context.bindings[name]!.owner === "connection" &&
      !unit.context.sharedConnection
    )
      add(
        "RSL_EXPR_CONTEXT",
        `$${name} needs an explicit shared connection owner`,
      );
  }
  for (const name of sortKeys(unit.helpers))
    if (
      !identifier.test(name) ||
      roots.has(name) ||
      STANDARD_FUNCTIONS.includes(name) ||
      excluded.has(name) ||
      Object.hasOwn(unit.context.bindings, name)
    )
      add(
        "RSL_EXPR_BINDING",
        `Invalid, reserved, or conflicting helper $${name}`,
      );
  const e = unit.context.event;
  if (unit.slot !== "initial" && !e)
    add("RSL_EXPR_CONTEXT", "A reaction slot requires an event descriptor");
  if (e) {
    const permitted =
      e.source === "timer"
        ? e.kind === "next"
        : e.source === "downstream"
          ? e.kind === "unsubscribe"
          : ["next", "error", "complete"].includes(e.kind);
    if (!permitted)
      add("RSL_EXPR_CONTEXT", `Invalid event ${e.source}.${e.kind}`);
    const payload =
      e.kind === "next" && !["timer", "downstream"].includes(e.source);
    if (payload !== Object.hasOwn(e, "valueType"))
      add(
        "RSL_EXPR_CONTEXT",
        payload
          ? "Payload next event requires valueType"
          : "This event cannot declare a next payload",
      );
    if ((e.kind === "error") !== Object.hasOwn(e, "errorType"))
      add(
        "RSL_EXPR_CONTEXT",
        e.kind === "error"
          ? "Error event requires errorType"
          : "Only error events declare errorType",
      );
  }
  if (
    ["guard", "emitWhen"].includes(unit.slot) &&
    JSON.stringify(unit.expectedType) !== JSON.stringify(BOOLEAN)
  )
    add("RSL_EXPR_TYPE", "Permission slots must declare primitive boolean");
  let typeVisits = 0;
  const inspectType = (
    t: TypeRef,
    seen: string[] = [],
    dimension = false,
  ): void => {
    if (++typeVisits > 10000) {
      if (typeVisits === 10001)
        add("RSL_EXPR_LIMIT", "Type expansion exceeds 10,000 visits");
      return;
    }
    if (t.kind === "named") {
      if (dimension) return;
      if (seen.includes(t.ref)) {
        add(
          "RSL_EXPR_REFERENCE",
          `Cyclic named type ${[...seen, t.ref].join(" -> ")}`,
        );
        return;
      }
      if (!Object.hasOwn(unit.types, t.ref)) {
        add("RSL_EXPR_REFERENCE", `Unresolved type ${t.ref}`);
        return;
      }
      inspectType(unit.types[t.ref]!, [...seen, t.ref]);
    } else if (t.kind === "record")
      Object.values(t.fields).forEach((v) => inspectType(v, seen));
    else if (t.kind === "array") inspectType(t.items, seen);
    else if (t.kind === "tuple") t.items.forEach((v) => inspectType(v, seen));
    else if (t.kind === "union") t.members.forEach((v) => inspectType(v, seen));
    else if (t.kind === "observable") inspectType(t.value, seen);
    else if (t.kind === "generic") {
      if (
        ["rsl.LogicalTime", "rsl.Duration"].includes(t.ref) &&
        !(t.arguments.length === 1 && t.arguments[0]?.kind === "named")
      )
        add(
          "RSL_EXPR_TIME",
          `${t.ref} requires one clock-dimension named argument`,
        );
      t.arguments.forEach((v) => inspectType(v, seen, isTemporal(t)));
    }
  };
  [
    unit.expectedType,
    ...Object.values(unit.types),
    ...Object.values(unit.context.parameters),
    ...Object.values(unit.context.state),
    ...Object.values(unit.context.locals),
    ...Object.values(unit.context.bindings).map((b) => b.type),
    ...(e?.valueType ? [e.valueType] : []),
    ...(e?.errorType ? [e.errorType] : []),
    ...Object.values(unit.helpers).flatMap((h) => [...h.parameters, h.output]),
  ].forEach((t) => inspectType(t));
  if (diagnostics.length) return finish();

  const temporal = clockType("LogicalTime", unit.context.clock.id);
  const view = (fields: Record<string, Fact>, origin: string): Fact =>
    fact(
      recordType(
        Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.type])),
      ),
      { fields, view: true, origin },
    );
  const declared = (
    fields: Readonly<Record<string, TypeRef>>,
    origin: string,
  ): Fact =>
    view(
      Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [
          k,
          fact(v, { origin: `${origin}.${k}` }),
        ]),
      ),
      origin,
    );
  const env: Environment = new Map();
  env.set("parameters", declared(unit.context.parameters, "parameters"));
  const rsl: Record<string, Fact> = { parameters: env.get("parameters")! };
  if (unit.slot !== "initial") {
    env.set("state", declared(unit.context.state, "state"));
    env.set("local", declared(unit.context.locals, "local"));
    rsl.memory = env.get("state")!;
    rsl.locals = env.get("local")!;
    if (unit.slot === "transition") {
      env.set("previousState", env.get("state")!);
      rsl.previousMemory = env.get("state")!;
    }
    const eventFields: Record<string, Fact> = {
      source: fact(STRING),
      kind: fact(STRING),
      time: fact(temporal),
      sequence: fact(NUMBER),
      contextId: fact(STRING),
    };
    if (e?.valueType)
      eventFields.value = fact(e.valueType, { origin: "notification.value" });
    if (e?.errorType)
      eventFields.error = fact(e.errorType, { origin: "notification.error" });
    if (e?.source === "input") eventFields.inputIndex = fact(NUMBER);
    if (e && ["timer", "inner", "notifier"].includes(e.source))
      eventFields.id = fact(
        identityType(e.source === "timer" ? "TimerId" : "ResourceId"),
      );
    if (e?.scheduled || e?.source === "timer")
      eventFields.targetTime = fact(temporal);
    env.set("notification", view(eventFields, "notification"));
    rsl.event = env.get("notification")!;
    rsl.time = view(
      { contextId: fact(STRING), unit: fact(STRING), now: fact(temporal) },
      "rsl.time",
    );
    rsl.execution = view(
      { id: fact(identityType("ExecutionId")) },
      "rsl.execution",
    );
    rsl.operator = view(
      { id: fact(identityType("OperatorId")) },
      "rsl.operator",
    );
    rsl.subscription = view(
      {
        id: fact(identityType("SubscriptionId")),
        closed: fact(BOOLEAN),
        parentId: fact(identityType("SubscriptionId"), { missing: true }),
      },
      "rsl.subscription",
    );
    if (unit.context.sharedConnection)
      rsl.connection = view(
        { id: fact(identityType("ConnectionId")) },
        "rsl.connection",
      );
  }
  env.set("rsl", view(rsl, "rsl"));
  for (const [name, binding] of Object.entries(unit.context.bindings))
    env.set(name, fact(binding.type));
  const resultTypes: Record<string, TypeRef> = {};
  for (const name of "sum count max min average length number floor ceil round abs sqrt power parseInteger toMillis".split(
    " ",
  ))
    resultTypes[name] = NUMBER;
  for (const name of "string substring substringBefore substringAfter lowercase uppercase trim pad join formatNumber formatBase formatInteger replace base64encode base64decode encodeUrlComponent encodeUrl decodeUrlComponent decodeUrl fromMillis".split(
    " ",
  ))
    resultTypes[name] = STRING;
  for (const name of ["boolean", "not", "exists", "contains"])
    resultTypes[name] = BOOLEAN;
  resultTypes.error = primitive("never");
  resultTypes.assert = primitive("void");
  resultTypes.type = STRING;
  for (const name of STANDARD_FUNCTIONS)
    env.set(
      name,
      fact(UNKNOWN, {
        callable: {
          kind: "standard",
          name,
          output: resultTypes[name] ?? UNKNOWN,
        },
      }),
    );
  for (const [name, h] of Object.entries(unit.helpers))
    env.set(
      name,
      fact(UNKNOWN, {
        callable: {
          kind: "helper",
          name,
          output: h.output,
          parameters: h.parameters,
        },
      }),
    );
  let visited = 0;
  const element = (f: Fact): Fact => {
    const t = resolve(f.type, unit.types);
    return t.kind === "array"
      ? fact(t.items, { missing: f.missing })
      : t.kind === "tuple"
        ? fact(union(t.items), { missing: true })
        : f;
  };
  const property = (base: Fact, key: string, ast: Ast): Fact => {
    if (base.fields && Object.hasOwn(base.fields, key))
      return base.fields[key]!;
    if (base.view) {
      add(
        "RSL_EXPR_CONTEXT",
        `Unavailable context member ${base.origin}.${key}`,
        ast,
      );
      return unknown();
    }
    const t = resolve(base.type, unit.types);
    if (t.kind === "generic" || t.kind === "observable") {
      add(
        "RSL_EXPR_REFERENCE",
        "Opaque values cannot be inspected as JSON records",
        ast,
      );
      return unknown();
    }
    if (t.kind === "array" || t.kind === "tuple") {
      const item = property(element(base), key, ast);
      return fact(union([item.type, { kind: "array", items: item.type }]), {
        missing: true,
      });
    }
    if (t.kind === "record" && Object.hasOwn(t.fields, key))
      return fact(t.fields[key]!, { missing: base.missing });
    return unknown();
  };
  const ensure = (actual: Fact, expected: TypeRef, ast?: Ast) => {
    if (actual.type.kind === "primitive" && actual.type.name === "void") {
      add(
        "RSL_EXPR_MISSING",
        "This expression has no value in a required slot",
        ast,
      );
      return;
    }
    if (actual.callable) {
      add(
        "RSL_EXPR_TYPE",
        "Callable values cannot leave ordinary value slots",
        ast,
      );
      return;
    }
    const hasCallable = (f: Fact): boolean =>
      Boolean(f.callable) ||
      Object.values(f.fields ?? {}).some(hasCallable) ||
      (f.items ?? []).some(hasCallable);
    if (hasCallable(actual))
      add(
        "RSL_EXPR_TYPE",
        "Callable values cannot be embedded in JSON output",
        ast,
      );
    const match = compatible(actual.type, expected, unit.types);
    if (match === "no")
      add(
        "RSL_EXPR_TYPE",
        `Expression type ${JSON.stringify(actual.type)} does not match ${JSON.stringify(expected)}`,
        ast,
      );
    else if (match === "runtime")
      check("result-type", `Check result against ${JSON.stringify(expected)}`);
    if (actual.missing)
      check(
        "presence",
        "A required result must exist; absence never suppresses a notification",
      );
  };
  const callable = (procedure: Fact, args: Fact[], ast: Ast): Fact => {
    const c = procedure.callable;
    if (!c) {
      add(
        "RSL_EXPR_EFFECT",
        "Callable provenance is not a known pure helper, standard function, or lexical function",
        ast,
      );
      return unknown();
    }
    if (c.partial) {
      let index = 0;
      const applied = c.partial.args.map(
        (a) => a ?? args[index++] ?? unknown(),
      );
      return callable(
        c.partial.target,
        [...applied, ...args.slice(index)],
        ast,
      );
    }
    if (c.kind === "lambda" && args.some(containsView))
      add(
        "RSL_EXPR_CONTEXT",
        "Pass a declared member rather than a complete reserved view to a lexical function; context-parameter specialization is not implemented",
        ast,
      );
    if (c.name) functions.add(c.name);
    if (c.kind === "helper") {
      if (args.length !== c.parameters!.length)
        add(
          "RSL_EXPR_TYPE",
          `$${c.name} expects ${c.parameters!.length} arguments`,
          ast,
        );
      args.forEach((a, i) => {
        if (c.parameters![i]) ensure(a, c.parameters![i]!, ast);
      });
      check(
        "function-contract",
        `Verify registered helper $${c.name} purity, synchronous return, arguments, result, and version`,
      );
    }
    if (c.kind === "standard") {
      const hof: Record<string, number[]> = {
        map: [1],
        filter: [1],
        single: [1],
        reduce: [1],
        each: [1],
        sift: [1],
        sort: [1],
      };
      for (const i of hof[c.name!] ?? [])
        if (args[i] && !args[i]!.callable)
          add(
            "RSL_EXPR_EFFECT",
            `$${c.name} requires a provably pure callable argument`,
            ast,
          );
      if (c.name === "lookup") {
        const base = args[0] ?? unknown(),
          key = args[1];
        if (typeof key?.literal === "string")
          return property(base, key.literal, ast);
        if (containsView(base))
          add(
            "RSL_EXPR_CONTEXT",
            "Dynamic lookup of a reserved context view needs a literal member name",
            ast,
          );
        return unknown();
      }
      if (args.some(containsView) && !["exists", "type"].includes(c.name!))
        add(
          "RSL_EXPR_CONTEXT",
          `Pass a declared context member to $${c.name}; this validator does not admit transforming a complete reserved view`,
          ast,
        );
      if (["match", "contains", "split", "replace"].includes(c.name!)) {
        const pattern = args[1];
        if (pattern && !pattern.callable) {
          if (c.name === "match")
            add(
              "RSL_EXPR_EFFECT",
              "$match requires a provably pure matcher",
              ast,
            );
          else if (compatible(pattern.type, STRING, unit.types) === "no")
            add(
              "RSL_EXPR_TYPE",
              "Pattern must be a string or known pure matcher",
              ast,
            );
          else
            check(
              "function-contract",
              "A data-supplied pattern must be a string, never an untrusted callable",
            );
        }
        const replacement = args[2];
        if (c.name === "replace" && replacement && !replacement.callable)
          check(
            "function-contract",
            "A data-supplied replacement must be a string, never an untrusted callable",
          );
      }
      if (c.name === "toMillis")
        check(
          "time-contract",
          "Verify complete date/time/timezone arguments; no ambient date defaults",
        );
      check(
        "function-contract",
        `Validate native JSONata $${c.name} argument/result contract without changing its semantics`,
      );
    }
    return (
      c.result ??
      fact(c.output, {
        missing: !["exists", "count", "boolean", "error"].includes(
          c.name ?? "",
        ),
      })
    );
  };
  const walk = (
    ast: Ast,
    scope: Environment,
    current?: Fact,
    depth = 0,
  ): Fact => {
    if (!ast || typeof ast.type !== "string") {
      add("RSL_EXPR_DIALECT", "Unrecognized parser structure");
      return unknown();
    }
    if (++visited > 10000 || depth > 128) {
      add("RSL_EXPR_LIMIT", "AST exceeds 10,000 nodes or depth 128", ast);
      return unknown();
    }
    features.add(ast.type);
    if (["binary", "unary"].includes(ast.type))
      features.add(`${ast.type}:${String(ast.value)}`);
    for (const decoration of [
      "predicate",
      "stages",
      "group",
      "focus",
      "index",
      "keepArray",
      "keepSingletonArray",
    ])
      if (Object.hasOwn(ast, decoration))
        features.add(`decoration:${decoration}`);
    const child = (v: unknown, s = scope, c = current) =>
      walk(node(v), s, c, depth + 1);
    let out: Fact;
    switch (ast.type) {
      case "number":
        out = fact(NUMBER, { literal: ast.value });
        break;
      case "string":
        out = fact(STRING, { literal: ast.value });
        break;
      case "value":
        out = fact(ast.value === null ? primitive("null") : BOOLEAN, {
          literal: ast.value,
        });
        break;
      case "variable": {
        const name = String(ast.value);
        if (name === "$") {
          add(
            "RSL_EXPR_CONTEXT",
            "Root $$ is unavailable in this hosting profile",
            ast,
          );
          out = unknown();
        } else if (name === "") {
          if (!current)
            add(
              "RSL_EXPR_CONTEXT",
              "Root $ requires an explicit nested context",
              ast,
            );
          out = current ?? unknown();
        } else if (name === "runtime") {
          add(
            "RSL_EXPR_EFFECT",
            "$runtime is available only as a complete declared capability call in its action slot",
            ast,
          );
          out = unknown();
        } else if (name === "states") {
          add(
            "RSL_EXPR_CONTEXT",
            "$states belongs to an inherited ASL scope, not this RSL reaction unit",
            ast,
          );
          out = unknown();
        } else if (excluded.has(name)) {
          add(
            "RSL_EXPR_DIALECT",
            `$${name} is excluded from deterministic core-1`,
            ast,
          );
          out = unknown();
        } else if (!scope.has(name)) {
          add(
            roots.has(name) ? "RSL_EXPR_CONTEXT" : "RSL_EXPR_BINDING",
            `Unavailable binding $${name}`,
            ast,
          );
          out = unknown();
        } else {
          out = scope.get(name)!;
          if (out.callable?.name) functions.add(out.callable.name);
          if (roots.has(name) || Object.hasOwn(unit.context.bindings, name))
            bindings.add(name);
        }
        break;
      }
      case "name":
        if (!current) {
          add(
            "RSL_EXPR_CONTEXT",
            "Unqualified root paths are unavailable",
            ast,
          );
          out = unknown();
        } else out = property(current, String(ast.value), ast);
        break;
      case "path": {
        const local = new Map(scope);
        let focus = current;
        const steps = nodes(ast.steps);
        out = unknown();
        for (const step of steps) {
          out = walk(step, local, focus, depth + 1);
          focus = element(out);
        }
        break;
      }
      case "block": {
        const local = new Map(scope);
        out = unknown();
        for (const exp of nodes(ast.expressions)) out = child(exp, local);
        break;
      }
      case "bind": {
        const name = String(node(ast.lhs).value);
        validateName(name, node(ast.lhs));
        if (node(ast.rhs).type === "lambda")
          scope.set(
            name,
            fact(UNKNOWN, { callable: { kind: "lambda", output: UNKNOWN } }),
          );
        out = child(ast.rhs);
        scope.set(name, out);
        break;
      }
      case "lambda": {
        const local = new Map(scope);
        const seen = new Set<string>();
        for (const arg of nodes(ast.arguments)) {
          const name = String(arg.value);
          validateName(name, arg);
          if (seen.has(name))
            add("RSL_EXPR_BINDING", `Duplicate lambda argument $${name}`, arg);
          seen.add(name);
          local.set(name, unknown());
        }
        const result = child(ast.body, local);
        out = fact(UNKNOWN, {
          callable: { kind: "lambda", output: result.type, result },
        });
        break;
      }
      case "function":
      case "partial": {
        const procedure = child(ast.procedure);
        const args = nodes(ast.arguments).map((a) =>
          a.type === "operator" && a.value === "?" ? unknown() : child(a),
        );
        if (ast.type === "partial") {
          if (!procedure.callable)
            add(
              "RSL_EXPR_EFFECT",
              "Partial application requires a known pure function",
              ast,
            );
          out = procedure.callable
            ? fact(UNKNOWN, {
                callable: {
                  kind: "lambda",
                  output: procedure.callable.output,
                  partial: {
                    target: procedure,
                    args: nodes(ast.arguments).map((a, i) =>
                      a.type === "operator" && a.value === "?"
                        ? null
                        : args[i]!,
                    ),
                  },
                },
              })
            : unknown();
        } else out = callable(procedure, args, ast);
        break;
      }
      case "apply": {
        const left = child(ast.lhs),
          right = node(ast.rhs);
        if (right.type === "function")
          out = callable(
            child(right.procedure),
            [left, ...nodes(right.arguments).map((a) => child(a))],
            ast,
          );
        else {
          const fn = child(right);
          out = callable(fn, [left], ast);
        }
        break;
      }
      case "binary": {
        const a = child(ast.lhs),
          b = child(ast.rhs),
          op = String(ast.value);
        const at = resolve(a.type, unit.types),
          bt = resolve(b.type, unit.types);
        if (isTemporal(at) || isTemporal(bt)) {
          if (
            isTemporal(at) &&
            isTemporal(bt) &&
            JSON.stringify(at.arguments) !== JSON.stringify(bt.arguments)
          )
            add(
              "RSL_EXPR_TIME",
              "Cannot combine values from different clock domains",
              ast,
            );
          if (["+", "-"].includes(op)) {
            if (isTemporal(at) && isTemporal(bt)) {
              if (
                op === "+" &&
                at.ref === "rsl.LogicalTime" &&
                bt.ref === "rsl.LogicalTime"
              )
                add(
                  "RSL_EXPR_TIME",
                  "Adding two absolute logical times is invalid",
                  ast,
                );
              if (
                op === "-" &&
                at.ref === "rsl.Duration" &&
                bt.ref === "rsl.LogicalTime"
              )
                add(
                  "RSL_EXPR_TIME",
                  "Cannot subtract an absolute time from a duration",
                  ast,
                );
              out = fact(
                op === "-" && at.ref === bt.ref
                  ? clockType("Duration", unit.context.clock.id)
                  : at.ref === "rsl.LogicalTime"
                    ? at
                    : bt,
              );
              break;
            }
            check(
              "time-contract",
              "Verify numeric operand uses the declared clock unit",
            );
            out = fact(isTemporal(at) ? at : bt);
            break;
          }
          if (!["=", "!=", "<", "<=", ">", ">="].includes(op))
            check(
              "time-contract",
              `Verify dimensional validity of temporal ${op}`,
            );
        }
        if (["=", "!=", "<", "<=", ">", ">=", "and", "or", "in"].includes(op))
          out = fact(BOOLEAN);
        else if (op === "&") out = fact(STRING);
        else if (op === "..") out = fact({ kind: "array", items: NUMBER });
        else if (["+", "-", "*", "/", "%"].includes(op)) {
          for (const f of [a, b])
            if (compatible(f.type, NUMBER, unit.types) === "no")
              add(
                "RSL_EXPR_TYPE",
                `Numeric operator ${op} has a nonnumeric operand`,
                ast,
              );
          out = fact(NUMBER, { missing: a.missing || b.missing });
        } else {
          add("RSL_EXPR_DIALECT", `Unsupported operator ${op}`, ast);
          out = unknown();
        }
        break;
      }
      case "unary": {
        if (ast.value === "-") {
          const x = child(ast.expression);
          if (compatible(x.type, NUMBER, unit.types) === "no")
            add("RSL_EXPR_TYPE", "Unary minus needs a number", ast);
          out = fact(NUMBER, { missing: x.missing });
        } else if (ast.value === "[") {
          const expressions = nodes(ast.expressions),
            values = expressions.map((v) => child(v));
          if (values.some(containsView))
            add(
              "RSL_EXPR_TYPE",
              "Do not place reserved context views in literal arrays",
              ast,
            );
          const flattenType = (t: TypeRef): TypeRef => {
            t = resolve(t, unit.types);
            return t.kind === "array"
              ? t.items
              : t.kind === "tuple"
                ? union(t.items)
                : t.kind === "union"
                  ? union(t.members.map(flattenType))
                  : t;
          };
          out = fact(
            {
              kind: "array",
              items: union(
                values.map((v, i) =>
                  expressions[i]?.type === "unary" &&
                  expressions[i]?.value === "["
                    ? v.type
                    : flattenType(v.type),
                ),
              ),
            },
            { items: values },
          );
        } else if (ast.value === "{") {
          const fields: Record<string, Fact> = Object.create(null);
          let dynamic = false;
          for (const pair of ast.lhs as unknown[][]) {
            const k = child(pair[0]),
              v = child(pair[1]);
            if (typeof k.literal === "string") fields[k.literal] = v;
            else dynamic = true;
          }
          out = dynamic
            ? unknown()
            : fact(
                recordType(
                  Object.fromEntries(
                    Object.entries(fields).map(([k, v]) => [k, v.type]),
                  ),
                ),
                { fields },
              );
        } else {
          add("RSL_EXPR_DIALECT", "Unsupported unary form", ast);
          out = unknown();
        }
        break;
      }
      case "condition": {
        child(ast.condition);
        const yes = child(ast.then, new Map(scope)),
          no = ast.else ? child(ast.else, new Map(scope)) : unknown();
        if (yes.callable || no.callable) {
          if (yes.callable && no.callable) {
            const result = fact(
              union([yes.callable.output, no.callable.output]),
              {
                missing: true,
                ...(yes.callable.result?.view || no.callable.result?.view
                  ? { view: true, origin: "conditional callable result" }
                  : {}),
              },
            );
            out = fact(UNKNOWN, {
              callable: { kind: "lambda", output: result.type, result },
            });
          } else out = unknown();
        } else
          out = fact(union([yes.type, no.type]), {
            missing: yes.missing || no.missing,
            ...(yes.view || no.view
              ? { view: true, origin: "conditional context" }
              : {}),
          });
        break;
      }
      case "regex": {
        const regex = ast.value as RegExp;
        try {
          new RegExpParser({ ecmaVersion: 2018 }).parsePattern(
            regex.source,
            0,
            regex.source.length,
            false,
          );
          if (/[^gim]/.test(regex.flags)) throw new Error("Flags outside i/m");
        } catch (error) {
          add(
            "RSL_EXPR_DIALECT",
            `Regex outside ECMAScript 2018: ${String(error)}`,
            ast,
          );
        }
        out = fact(UNKNOWN, { callable: { kind: "regex", output: UNKNOWN } });
        break;
      }
      case "transform": {
        const focus = unknown();
        child(ast.pattern, new Map(scope), focus);
        child(ast.update, new Map(scope), focus);
        if (ast.delete) child(ast.delete, new Map(scope), focus);
        out = fact(UNKNOWN, {
          callable: { kind: "transform", output: UNKNOWN },
        });
        break;
      }
      case "sort": {
        for (const term of (ast.terms ?? []) as { expression: unknown }[])
          child(term.expression, scope, current ?? unknown());
        out = current ?? unknown();
        break;
      }
      case "wildcard":
      case "descendant":
      case "parent": {
        if (!current || current.view)
          add(
            "RSL_EXPR_CONTEXT",
            "Implicit/dynamic traversal of a reserved root is not admitted; select its declared payload first",
            ast,
          );
        out = unknown();
        break;
      }
      default:
        add("RSL_EXPR_DIALECT", `Unrecognized AST node ${ast.type}`, ast);
        out = unknown();
    }
    const decoratedScope = scope;
    for (const key of ["focus", "index"])
      if (typeof ast[key] === "string") {
        const name = ast[key] as string;
        validateName(name, ast);
        decoratedScope.set(name, key === "index" ? fact(NUMBER) : element(out));
      }
    for (const filter of [...nodes(ast.predicate), ...nodes(ast.stages)]) {
      if (filter.type === "index") {
        const name = String(filter.value);
        validateName(name, filter);
        decoratedScope.set(name, fact(NUMBER));
      } else if (filter.type === "filter") {
        child(filter.expr, decoratedScope, element(out));
        out = { ...out, missing: true };
      } else
        add(
          "RSL_EXPR_DIALECT",
          `Unrecognized path stage ${filter.type}`,
          filter,
        );
    }
    if (ast.group) {
      const group = ast.group as { lhs: unknown[][] };
      for (const pair of group.lhs) {
        child(pair[0], decoratedScope, element(out));
        child(pair[1], decoratedScope, element(out));
      }
      out = unknown();
    }
    if (ast.keepArray || ast.keepSingletonArray)
      out = fact({ kind: "array", items: element(out).type });
    return out;
  };
  const allocation = (ast: Ast): boolean => {
    if (ast.type !== "path") return false;
    const steps = nodes(ast.steps);
    const a = steps[0],
      b = steps[1];
    const procedure = nodes(node(b?.procedure ?? {}).steps);
    return (
      steps.length === 2 &&
      a?.type === "variable" &&
      a.value === "runtime" &&
      b?.type === "function" &&
      nodes(b.arguments).length === 0 &&
      procedure.length === 1 &&
      procedure[0]?.type === "name" &&
      procedure[0].value === "nextTimerId" &&
      [ast, a, b, procedure[0]].every(
        (n) =>
          ![
            "predicate",
            "stages",
            "group",
            "focus",
            "index",
            "keepArray",
            "keepSingletonArray",
          ].some((k) => Object.hasOwn(n, k)),
      )
    );
  };
  const literal = (value: JsonValue): Fact => {
    if (value === null) return fact(primitive("null"), { literal: null });
    if (typeof value === "string") return fact(STRING, { literal: value });
    if (typeof value === "number") return fact(NUMBER, { literal: value });
    if (typeof value === "boolean") return fact(BOOLEAN, { literal: value });
    if (Array.isArray(value))
      return fact({ kind: "tuple", items: value.map((v) => literal(v).type) });
    const fields = Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, literal(v)]),
    );
    return fact(
      recordType(
        Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.type])),
      ),
      { fields },
    );
  };
  const expressionFact = (source: string): Fact => {
    expression = source;
    if (
      !source.startsWith("{%") ||
      !source.endsWith("%}") ||
      !source.slice(2, -2).trim()
    ) {
      add(
        "RSL_EXPR_WRAPPER",
        "Expected a nonempty whole-string {% ... %} expression",
      );
      return unknown();
    }
    if (source.length > 65536) {
      add("RSL_EXPR_LIMIT", "Expression exceeds 65,536 UTF-16 code units");
      return unknown();
    }
    let ast: Ast;
    try {
      ast = jsonata(source.slice(2, -2)).ast() as unknown as Ast;
    } catch (error) {
      const err = error as {
        message?: string;
        code?: string;
        position?: number;
      };
      add(
        "RSL_EXPR_SYNTAX",
        err.message ?? String(error),
        { type: "error", position: err.position },
        err.code,
      );
      return unknown();
    }
    if (allocation(ast)) {
      if (unit.slot !== "capture")
        add(
          "RSL_EXPR_EFFECT",
          "nextTimerId allocation is allowed only as a complete capture operand",
          ast,
        );
      capabilities.add("runtime.nextTimerId");
      return fact(identityType("TimerId"));
    }
    check(
      "evaluation",
      "Execute synchronously at the declared action; preserve evaluation failures and ordering",
    );
    return walk(ast, new Map(env));
  };
  const template = (value: JsonValue, path: string): Fact => {
    fieldPath = path;
    if (typeof value === "string" && value.startsWith("{%")) {
      const result = expressionFact(value);
      if (result.missing)
        check(
          "presence",
          "Every expression-bearing template leaf requires a present result",
        );
      return result;
    }
    if (Array.isArray(value))
      return fact({
        kind: "tuple",
        items: value.map((v, i) => template(v, `${path}/${i}`).type),
      });
    if (value !== null && typeof value === "object") {
      const fields: Record<string, Fact> = Object.create(null);
      for (const k of sortKeys(value))
        fields[k] = template(
          (value as Record<string, JsonValue>)[k]!,
          `${path}/${pointer(k)}`,
        );
      return fact(
        recordType(
          Object.fromEntries(
            Object.entries(fields).map(([k, v]) => [k, v.type]),
          ),
        ),
        { fields },
      );
    }
    return literal(value);
  };
  const output =
    unit.mode === "literal"
      ? literal(unit.value)
      : unit.mode === "expression"
        ? expressionFact(unit.value as string)
        : template(unit.value, unit.location.fieldPath);
  fieldPath = unit.location.fieldPath;
  if (capabilities.size && unit.mode !== "expression")
    add(
      "RSL_EXPR_EFFECT",
      "Allocator must occupy the complete capture expression, not a template child",
    );
  if (["emitTiming", "scheduleTime"].includes(unit.slot)) {
    const t = resolve(output.type, unit.types);
    if (!isTemporal(t) && compatible(t, NUMBER, unit.types) === "no")
      add(
        "RSL_EXPR_TIME",
        "A time operand must be numeric in its declared clock domain",
      );
    const declared = resolve(unit.expectedType, unit.types);
    if (
      !(isTemporal(declared) && declared.ref === "rsl.LogicalTime") &&
      !(declared.kind === "primitive" && declared.name === "number")
    )
      add("RSL_EXPR_TYPE", "Time slots must declare number or rsl.LogicalTime");
    if (isTemporal(t) && t.ref === "rsl.Duration")
      add(
        "RSL_EXPR_TIME",
        "An absolute timing slot cannot receive a duration alone",
      );
    if (
      isTemporal(t) &&
      t.ref === "rsl.LogicalTime" &&
      JSON.stringify(t.arguments) !==
        JSON.stringify(
          (temporal as Extract<TypeRef, { kind: "generic" }>).arguments,
        )
    )
      add("RSL_EXPR_TIME", "Timing result belongs to a different clock domain");
    if (t.kind === "primitive" && t.name === "number")
      check(
        "time-contract",
        "Interpret and validate literal numeric time in the explicitly declared clock domain",
      );
    check(
      "time-contract",
      "Validate finite time, unit, ownership, and schedule/delivery consistency; expressions do not schedule",
    );
  }
  ensure(output, unit.expectedType);
  if (features.size || capabilities.size) {
    check(
      "result-type",
      `Enforce the declared action result type ${JSON.stringify(unit.expectedType)} at runtime, including required nested fields`,
    );
    check(
      "presence",
      "Require a present action result; preserve typed direct-forwarding presence separately where declared",
    );
  }
  if (unit.slot === "emitNext") {
    const resource = (f: Fact): boolean =>
      (f.type.kind === "generic" &&
        f.type.ref.startsWith("rsl.") &&
        !isTemporal(f.type)) ||
      Object.values(f.fields ?? {}).some(resource) ||
      (f.items ?? []).some(resource);
    if (resource(output))
      add(
        "RSL_EXPR_REFERENCE",
        "Runtime resource references cannot escape through business next output",
      );
  }
  if (
    unit.slot === "resourceSelector" ||
    output.type.kind === "observable" ||
    (output.type.kind === "generic" && !isTemporal(output.type))
  )
    check(
      "reference-contract",
      "Resolve the typed reference and enforce active ownership at the action boundary",
    );
  return finish();
}

export interface GroupInput {
  readonly base: Omit<
    ExpressionUnit,
    "value" | "expectedType" | "slot" | "mode"
  >;
  readonly targets: Readonly<
    Record<string, { readonly type: TypeRef; readonly value: JsonValue }>
  >;
}
/** A capture's siblings share the supplied pre-action local environment. */
export function validateCaptureGroup(input: GroupInput): {
  valid: boolean;
  results: Readonly<Record<string, ValidationResult>>;
  nextContext?: ExpressionContext;
  diagnostics: readonly Diagnostic[];
} {
  const results: Record<string, ValidationResult> = Object.create(null);
  let allocations = 0;
  const diagnostics: Diagnostic[] = [];
  for (const key of sortKeys(input.targets)) {
    const t = input.targets[key]!;
    const result = validateExpression({
      ...input.base,
      slot: "capture",
      mode: "template",
      value: t.value,
      expectedType: t.type,
      location: {
        ...input.base.location,
        fieldPath: `${input.base.location.fieldPath}/${pointer(key)}`,
      },
      ...(typeof t.value === "string" && t.value.startsWith("{%")
        ? { mode: "expression" }
        : {}),
    });
    results[key] = result;
    allocations += result.requirements.capabilities.length;
    if (!identifier.test(key))
      diagnostics.push({
        code: "RSL_EXPR_BINDING",
        message: `Invalid capture target ${key}`,
        ...input.base.location,
      });
    const previous = input.base.context.locals[key];
    if (previous && JSON.stringify(previous) !== JSON.stringify(t.type))
      diagnostics.push({
        code: "RSL_EXPR_TYPE",
        message: `Capture cannot change the declared type of ${key}`,
        ...input.base.location,
      });
  }
  if (allocations > 1)
    diagnostics.push({
      code: "RSL_EXPR_EFFECT",
      message: "At most one allocator is admitted per capture action",
      ...input.base.location,
    });
  const valid =
    diagnostics.length === 0 && Object.values(results).every((r) => r.valid);
  return {
    valid,
    results,
    diagnostics,
    ...(valid
      ? {
          nextContext: {
            ...input.base.context,
            locals: {
              ...input.base.context.locals,
              ...Object.fromEntries(
                Object.entries(input.targets).map(([k, v]) => [k, v.type]),
              ),
            },
          },
        }
      : {}),
  };
}

export function validateTransitionGroup(input: GroupInput): {
  valid: boolean;
  results: Readonly<Record<string, ValidationResult>>;
  diagnostics: readonly Diagnostic[];
} {
  const results: Record<string, ValidationResult> = Object.create(null);
  const diagnostics: Diagnostic[] = [];
  for (const key of sortKeys(input.targets)) {
    const target = input.targets[key]!,
      declared = input.base.context.state[key];
    if (!declared || JSON.stringify(declared) !== JSON.stringify(target.type))
      diagnostics.push({
        code: "RSL_EXPR_TYPE",
        message: `Transition must target the declared type of state.${key}`,
        ...input.base.location,
      });
    results[key] = validateExpression({
      ...input.base,
      slot: "transition",
      mode: "template",
      value: target.value,
      expectedType: declared ?? target.type,
      location: {
        ...input.base.location,
        fieldPath: `${input.base.location.fieldPath}/${pointer(key)}`,
      },
    });
  }
  return {
    valid:
      diagnostics.length === 0 && Object.values(results).every((r) => r.valid),
    results,
    diagnostics,
  };
}
