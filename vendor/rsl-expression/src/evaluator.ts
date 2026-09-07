import jsonata from "jsonata";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import {
  validateExpression,
  validateCaptureGroup,
  validateTransitionGroup,
  STANDARD_FUNCTIONS,
} from "./validator.js";
import type { GroupInput } from "./validator.js";
import {
  clockType,
  identityType,
  isTemporal,
  primitive,
} from "./type-system.js";
import { isEvaluationFrame, ownValue, snapshot } from "./frame.js";
import {
  assertPortable,
  isThenable,
  matchesType,
  normalizeSequences,
} from "./runtime-values.js";
import type {
  Diagnostic,
  ExpressionUnit,
  JsonValue,
  TypeRef,
} from "./types.js";
import type {
  AdapterConfiguration,
  CompileOptions,
  CompiledExpression,
  CompiledGroup,
  EvaluationFailure,
  EvaluationFrame,
  RuntimeDiagnostic,
  ValueRecord,
} from "./runtime-types.js";

type Ast = {
  type: string;
  value?: unknown;
  position?: number;
  steps?: Ast[];
  [key: string]: unknown;
};
const require = createRequire(import.meta.url);
const engineVersion: string = (
  require("jsonata/package.json") as { version: string }
).version;
const forbidden = ["now", "millis", "random", "shuffle", "eval"];
export const codePointKeys = (value: object): string[] =>
  Object.keys(value).sort((a, b) => {
    const x = Array.from(a),
      y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
      if (d) return d;
    }
    return x.length - y.length;
  });
const pointer = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");
const freezeDeep = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
};
export function evaluationFailure(
  code: string,
  message: string,
  unit?: ExpressionUnit,
  frame?: EvaluationFrame,
  fieldPath?: string,
  cause?: unknown,
): EvaluationFailure {
  const notification = frame?.bindings.notification as ValueRecord | undefined;
  const original = cause as { code?: unknown; position?: unknown } | undefined;
  const diagnostic: RuntimeDiagnostic = Object.freeze({
    code,
    message,
    file: unit?.location.file ?? "<adapter>",
    fieldPath: fieldPath ?? unit?.location.fieldPath ?? "/",
    ...(typeof original?.code === "string" ? { causeCode: original.code } : {}),
    ...(typeof original?.position === "number"
      ? { offset: original.position + 2 }
      : {}),
    executionId: frame?.executionId,
    operatorId: frame?.operatorId,
    reaction: frame?.reaction,
    action: frame?.action,
    eventSource: notification?.source as string | undefined,
    eventKind: notification?.kind as string | undefined,
    logicalTime: frame?.time?.now,
  });
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { name: "RslEvaluationError", diagnostic },
  );
}
const hasFailure = (error: unknown): error is EvaluationFailure =>
  error instanceof Error && Object.hasOwn(error, "diagnostic");
const hasReferences = (type: TypeRef, unit: ExpressionUnit): boolean => {
  if (type.kind === "named") return hasReferences(unit.types[type.ref]!, unit);
  if (type.kind === "generic") return !isTemporal(type);
  if (type.kind === "observable") return true;
  if (type.kind === "record")
    return Object.values(type.fields).some((t) => hasReferences(t, unit));
  if (type.kind === "array") return hasReferences(type.items, unit);
  if (type.kind === "tuple")
    return type.items.some((t) => hasReferences(t, unit));
  if (type.kind === "union")
    return type.members.some((t) => hasReferences(t, unit));
  return false;
};
function selector(ast: Ast): readonly string[] | undefined {
  const steps =
    ast.type === "variable"
      ? [ast]
      : ast.type === "path"
        ? ast.steps
        : undefined;
  if (!steps?.length || steps[0]?.type !== "variable") return;
  if (
    Object.keys(ast).some(
      (k) => !["type", "steps", "value", "position"].includes(k),
    )
  )
    return;
  if (
    steps.some(
      (s, i) =>
        (i > 0 && s.type !== "name") ||
        Object.keys(s).some((k) => !["type", "value", "position"].includes(k)),
    )
  )
    return;
  return steps.map((s) => String(s.value));
}
interface Operand {
  readonly run: (frame: EvaluationFrame) => unknown;
  readonly allocation?: boolean;
}

export function createSynchronousAdapter(configuration: AdapterConfiguration) {
  if (engineVersion !== "1.8.7")
    throw evaluationFailure(
      "RSL_EXPR_ASYNC",
      `Adapter requires pinned JSONata 1.8.7; found ${engineVersion}`,
    );
  if (!configuration.helperRegistryVersion)
    throw evaluationFailure(
      "RSL_EXPR_BINDING",
      "A helper registry version is required",
    );
  const config: AdapterConfiguration = Object.freeze({
    ...configuration,
    helpers: Object.freeze(
      Object.fromEntries(
        Object.entries(configuration.helpers ?? {}).map(([k, v]) => [
          k,
          Object.freeze({
            call: v.call,
            contract: freezeDeep(structuredClone(v.contract)),
          }),
        ]),
      ),
    ),
    ...(configuration.references
      ? { references: Object.freeze({ ...configuration.references }) }
      : {}),
  });
  const maxSteps = config.maxEvaluationSteps ?? 100_000;
  const maxNodes = config.maxValueNodes ?? 100_000;
  if (![maxSteps, maxNodes].every((v) => Number.isSafeInteger(v) && v > 0))
    throw evaluationFailure(
      "RSL_EXPR_LIMIT",
      "Limits must be positive safe integers",
    );
  const isReference = config.references?.isReference ?? (() => false);
  const dateConversion = jsonata("$toMillis($timestamp,$picture)");

  function compile(
    input: unknown,
    options: CompileOptions = {},
  ): CompiledExpression {
    const validation = validateExpression(input);
    if (!validation.valid) {
      const first = validation.diagnostics[0]!;
      throw Object.assign(evaluationFailure(first.code, first.message), {
        diagnostics: validation.diagnostics,
        diagnostic: first,
      });
    }
    const unit = freezeDeep(structuredClone(input as ExpressionUnit));
    const directContract = options.directValue
      ? Object.freeze({ ...options.directValue })
      : undefined;
    if (directContract && !directContract.contractId)
      throw evaluationFailure(
        "RSL_EXPR_TYPE",
        "Direct forwarding requires a named host contract",
        unit,
      );
    for (const [name, contract] of Object.entries(unit.helpers)) {
      const entry = config.helpers?.[name];
      if (
        !entry ||
        !isDeepStrictEqual(entry.contract, contract) ||
        typeof entry.call !== "function"
      )
        throw evaluationFailure(
          "RSL_EXPR_BINDING",
          `Helper $${name} implementation/version/type contract does not match`,
          unit,
        );
      if (
        Object.prototype.toString.call(entry.call) === "[object AsyncFunction]"
      )
        throw evaluationFailure(
          "RSL_EXPR_ASYNC",
          `Helper $${name} is an async function`,
          unit,
        );
    }
    if (
      validation.runtimeChecks.some(
        (c) =>
          c.kind === "time-contract" &&
          /dimensional validity|numeric operand/.test(c.message),
      ) &&
      config.temporalExpression?.(unit) !== true
    )
      throw evaluationFailure(
        "RSL_EXPR_TIME",
        "Unresolved temporal arithmetic requires an explicit host dimensional contract",
        unit,
      );
    if (validation.requirements.capabilities.length)
      throw evaluationFailure(
        "RSL_EXPR_EFFECT",
        "Compile timer allocation through compileCapture so pure siblings precede allocation",
        unit,
      );

    const fail = (
      code: string,
      message: string,
      frame?: EvaluationFrame,
      path?: string,
      cause?: unknown,
    ): never => {
      throw evaluationFailure(code, message, unit, frame, path, cause);
    };
    const check = (
      value: unknown,
      type: TypeRef,
      frame: EvaluationFrame,
      path: string,
      portable: boolean,
    ): void => {
      try {
        if (!matchesType(value, type, unit.types, frame, config))
          fail(
            isTemporal(type)
              ? "RSL_EXPR_TIME"
              : hasReferences(type, unit)
                ? "RSL_EXPR_REFERENCE"
                : "RSL_EXPR_TYPE",
            "Value does not satisfy its declared type or ownership",
            frame,
            path,
          );
        if (portable)
          assertPortable(
            value,
            maxNodes,
            isReference,
            hasReferences(type, unit) && unit.slot !== "emitNext",
          );
      } catch (error) {
        if (hasFailure(error)) throw error;
        fail(
          isThenable(value) ? "RSL_EXPR_ASYNC" : "RSL_EXPR_TYPE",
          "Value is outside the admitted data contract",
          frame,
          path,
          error,
        );
      }
    };

    const assertFrame = (frame: EvaluationFrame): void => {
      if (!isEvaluationFrame(frame))
        fail(
          "RSL_EXPR_CONTEXT",
          "Use createEvaluationFrame to supply an isolated frame",
          frame,
        );
      const phase =
        unit.slot === "initial"
          ? "initial"
          : unit.slot === "transition"
            ? "transition"
            : "reaction";
      if (frame.phase !== phase)
        fail(
          "RSL_EXPR_CONTEXT",
          `Slot ${unit.slot} requires a ${phase} frame`,
          frame,
        );
      for (const [name, binding] of Object.entries(unit.context.bindings)) {
        if (!Object.hasOwn(frame.bindings, name))
          fail("RSL_EXPR_CONTEXT", `Missing named binding $${name}`, frame);
        if (binding.owner === "connection" && !frame.connectionId)
          fail(
            "RSL_EXPR_REFERENCE",
            "Named binding requires a shared connection owner",
            frame,
          );
      }
      if (phase === "initial") return;
      if (
        frame.time?.contextId !== unit.context.clock.id ||
        frame.time.unit !== unit.context.clock.unit
      )
        fail(
          "RSL_EXPR_TIME",
          "Frame clock identity/unit does not match the expression context",
          frame,
        );
      check(
        frame.time!.now,
        clockType("LogicalTime", unit.context.clock.id),
        frame,
        unit.location.fieldPath,
        false,
      );
      if (Boolean(frame.connectionId) !== unit.context.sharedConnection)
        fail(
          "RSL_EXPR_CONTEXT",
          "Shared connection scope does not match the declared context",
          frame,
        );
      const event = frame.bindings.notification as ValueRecord;
      const expected = unit.context.event!;
      if (event.source !== expected.source || event.kind !== expected.kind)
        fail(
          "RSL_EXPR_CONTEXT",
          "Notification does not match the compiled event family",
          frame,
        );
      if (
        event.contextId !== unit.context.clock.id ||
        typeof event.time !== "number" ||
        !Number.isFinite(event.time) ||
        event.time > frame.time!.now ||
        !Number.isSafeInteger(event.sequence) ||
        (event.sequence as number) < 0
      )
        fail(
          "RSL_EXPR_TIME",
          "Invalid notification clock, dispatch time or sequence",
          frame,
        );
      check(
        event.time,
        clockType("LogicalTime", unit.context.clock.id),
        frame,
        unit.location.fieldPath,
        false,
      );
      for (const key of ["value", "error"] as const)
        if (
          Object.hasOwn(event, key) !==
          Object.hasOwn(expected, key === "value" ? "valueType" : "errorType")
        )
          fail(
            "RSL_EXPR_CONTEXT",
            `Notification ${key} presence does not match its event kind`,
            frame,
          );
      if (
        expected.source === "input" &&
        (!Number.isSafeInteger(event.inputIndex) ||
          (event.inputIndex as number) < 0)
      )
        fail(
          "RSL_EXPR_CONTEXT",
          "Input event requires a nonnegative inputIndex",
          frame,
        );
      if (
        ["timer", "inner", "notifier"].includes(expected.source) &&
        !Object.hasOwn(event, "id")
      )
        fail("RSL_EXPR_CONTEXT", "Resource event requires an identity", frame);
      if (
        (expected.scheduled || expected.source === "timer") &&
        (typeof event.targetTime !== "number" ||
          !Number.isFinite(event.targetTime))
      )
        fail(
          "RSL_EXPR_TIME",
          "Scheduled event requires a finite targetTime",
          frame,
        );
    };

    function buildBindings(
      frame: EvaluationFrame,
      path: string,
    ): { bindings: Record<string, unknown>; views: WeakSet<object> } {
      const views = new WeakSet<object>();
      const view = (
        raw: ValueRecord,
        fields: Readonly<Record<string, TypeRef>>,
      ): ValueRecord => {
        const result: Record<string, unknown> = Object.create(null);
        for (const [key, type] of Object.entries(fields))
          Object.defineProperty(result, key, {
            enumerable: true,
            get: () => {
              const entry = ownValue(raw, key);
              if (!entry.present)
                return fail(
                  "RSL_EXPR_CONTEXT",
                  `Declared context member ${key} is unavailable`,
                  frame,
                  path,
                );
              check(entry.value, type, frame, path, true);
              return entry.value;
            },
          });
        views.add(result);
        return Object.freeze(result);
      };
      const bindings: Record<string, unknown> = Object.create(null);
      bindings.parameters = view(
        frame.bindings.parameters as ValueRecord,
        unit.context.parameters,
      );
      const rsl: Record<string, unknown> = { parameters: bindings.parameters };
      views.add(rsl);
      if (frame.phase !== "initial") {
        bindings.state = rsl.memory = view(
          frame.bindings.state as ValueRecord,
          unit.context.state,
        );
        bindings.local = rsl.locals = view(
          frame.bindings.local as ValueRecord,
          unit.context.locals,
        );
        if (frame.phase === "transition")
          bindings.previousState = rsl.previousMemory = bindings.state;
        const e = unit.context.event!;
        const fields: Record<string, TypeRef> = {
          source: primitive("string"),
          kind: primitive("string"),
          time: clockType("LogicalTime", unit.context.clock.id),
          sequence: primitive("number"),
          contextId: primitive("string"),
        };
        if (e.valueType) fields.value = e.valueType;
        if (e.errorType) fields.error = e.errorType;
        if (e.source === "input") fields.inputIndex = primitive("number");
        if (["inner", "timer", "notifier"].includes(e.source))
          fields.id = identityType(
            e.source === "timer" ? "TimerId" : "ResourceId",
          );
        if (e.scheduled || e.source === "timer")
          fields.targetTime = clockType("LogicalTime", unit.context.clock.id);
        bindings.notification = rsl.event = view(
          frame.bindings.notification as ValueRecord,
          fields,
        );
        for (const key of [
          "time",
          "execution",
          "operator",
          "subscription",
          "connection",
        ] as const) {
          const value = frame.bindings.rsl[key];
          if (value) {
            rsl[key] = value;
            views.add(value as object);
          }
        }
      }
      bindings.rsl = Object.freeze(rsl);
      for (const name of Object.keys(unit.context.bindings))
        bindings[name] = frame.bindings[name];
      return { bindings, views };
    }

    let completeSelector = false;
    const prepare = (
      value: JsonValue,
      mode: ExpressionUnit["mode"],
      path: string,
      top: boolean,
    ): Operand => {
      if (mode === "literal") return { run: () => structuredClone(value) };
      if (typeof value === "string" && value.startsWith("{%")) {
        const engine = jsonata(value.slice(2, -2));
        const ast = engine.ast() as unknown as Ast;
        const keys = selector(ast);
        if (top && keys) completeSelector = true;
        return {
          run: (frame) => {
            if (keys) {
              // Validate the declared source member as well as the receiving slot.
              let canonical = [...keys];
              if (canonical[0] === "rsl") {
                const aliases: Record<string, string> = {
                  parameters: "parameters",
                  memory: "state",
                  previousMemory: "previousState",
                  event: "notification",
                  locals: "local",
                };
                if (aliases[canonical[1]!])
                  canonical = [aliases[canonical[1]!]!, ...canonical.slice(2)];
              }
              const [root, member] = canonical;
              const maps: Record<string, Readonly<Record<string, TypeRef>>> = {
                parameters: unit.context.parameters,
                state: unit.context.state,
                previousState: unit.context.state,
                local: unit.context.locals,
              };
              const declared =
                root === "notification"
                  ? member === "value"
                    ? unit.context.event?.valueType
                    : member === "error"
                      ? unit.context.event?.errorType
                      : undefined
                  : (maps[root!]?.[member!] ??
                    unit.context.bindings[root!]?.type);
              if (declared) {
                const source =
                  maps[root!] || root === "notification"
                    ? ownValue(frame.bindings[root!], member!)
                    : ownValue(frame.bindings, root!);
                if (!source.present)
                  fail(
                    "RSL_EXPR_MISSING",
                    "Required source binding is absent",
                    frame,
                    path,
                  );
                check(source.value, declared, frame, path, false);
              }
              let selected: unknown = frame.bindings;
              for (const key of keys) {
                const field = ownValue(selected, key);
                if (!field.present)
                  return fail(
                    "RSL_EXPR_MISSING",
                    "Required direct selection is absent",
                    frame,
                    path,
                  );
                selected = field.value;
              }
              // A complete direct selection preserves arrays and opaque payload identity.
              if (top && directContract) {
                if (
                  directContract.accepts(selected, unit.expectedType) !== true
                )
                  fail(
                    "RSL_EXPR_TYPE",
                    "Direct payload contract rejected the value",
                    frame,
                    path,
                  );
              } else if (!(top && hasReferences(unit.expectedType, unit))) {
                if (selected === undefined)
                  fail(
                    "RSL_EXPR_MISSING",
                    "Required expression result is absent",
                    frame,
                    path,
                  );
                try {
                  assertPortable(
                    selected,
                    maxNodes,
                    isReference,
                    unit.slot !== "emitNext" &&
                      hasReferences(unit.expectedType, unit),
                  );
                } catch (error) {
                  fail(
                    "RSL_EXPR_TYPE",
                    "Direct value requires a compatible portable or explicit payload contract",
                    frame,
                    path,
                    error,
                  );
                }
              }
              return selected;
            }
            const { bindings, views } = buildBindings(frame, path);
            let steps = 0;
            bindings.__evaluate_entry = () => {
              if (++steps > maxSteps)
                fail(
                  "RSL_EXPR_LIMIT",
                  "Expression step limit exceeded",
                  frame,
                  path,
                );
            };
            bindings.__evaluate_exit = (
              node: Ast,
              _input: unknown,
              _environment: unknown,
              result: unknown,
            ) => {
              if (isThenable(result))
                fail(
                  "RSL_EXPR_ASYNC",
                  "Computed evaluation produced a thenable",
                  frame,
                  path,
                );
              if (
                node.type === "variable" &&
                Object.hasOwn(unit.context.bindings, String(node.value))
              ) {
                const contract = unit.context.bindings[String(node.value)]!;
                check(result, contract.type, frame, path, true);
              }
            };
            for (const name of forbidden)
              bindings[name] = () =>
                fail(
                  "RSL_EXPR_DIALECT",
                  `$${name} is excluded from this expression profile`,
                  frame,
                  path,
                );
            bindings.toMillis = function (
              timestamp: unknown,
              picture: unknown,
            ) {
              const explicitIso =
                typeof timestamp === "string" &&
                /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})$/.test(
                  timestamp,
                );
              if (
                typeof timestamp !== "string" ||
                (picture === undefined
                  ? !explicitIso
                  : typeof picture !== "string" ||
                    config.dateTimeArguments?.(timestamp, picture) !== true)
              )
                fail(
                  "RSL_EXPR_TIME",
                  "$toMillis requires a complete date/time/timezone or a checked custom picture contract",
                  frame,
                  path,
                );
              return dateConversion.evaluate(undefined, {
                timestamp,
                picture,
              }) as unknown;
            };
            for (const [name, contract] of Object.entries(unit.helpers)) {
              const call = (...args: unknown[]) => {
                if (args.length !== contract.parameters.length)
                  fail(
                    "RSL_EXPR_TYPE",
                    `Helper $${name} argument count mismatch`,
                    frame,
                    path,
                  );
                args = args.map((argument) => {
                  assertPortable(argument, maxNodes, isReference, true, true);
                  return normalizeSequences(argument);
                });
                args.forEach((argument, i) =>
                  check(argument, contract.parameters[i]!, frame, path, true),
                );
                const result = config.helpers![name]!.call(...args);
                if (isThenable(result))
                  fail(
                    "RSL_EXPR_ASYNC",
                    `Helper $${name} returned a thenable`,
                    frame,
                    path,
                  );
                check(result, contract.output, frame, path, true);
                return result;
              };
              // JSONata uses native arity for higher-order calls and parameter names for partial application.
              // Only generated parameter identifiers are used; no user source is evaluated as JavaScript.
              Object.defineProperty(call, "length", {
                value: contract.parameters.length,
              });
              Object.defineProperty(call, "toString", {
                value: () =>
                  `function(${contract.parameters.map((_, i) => `argument${i}`).join(",")}){}`,
              });
              bindings[name] = call;
            }
            const result: unknown = engine.evaluate(undefined, bindings);
            if (isThenable(result))
              fail(
                "RSL_EXPR_ASYNC",
                "Evaluator returned a thenable",
                frame,
                path,
              );
            if (result === undefined)
              fail(
                "RSL_EXPR_MISSING",
                "Required expression result is absent",
                frame,
                path,
              );
            if (result && typeof result === "object" && views.has(result))
              fail(
                "RSL_EXPR_CONTEXT",
                "A reserved context view cannot escape evaluation",
                frame,
                path,
              );
            try {
              assertPortable(
                result,
                maxNodes,
                isReference,
                hasReferences(unit.expectedType, unit) &&
                  unit.slot !== "emitNext",
                true,
              );
            } catch (error) {
              fail(
                "RSL_EXPR_TYPE",
                "Computed result is outside its portable/reference contract",
                frame,
                path,
                error,
              );
            }
            return normalizeSequences(result);
          },
        };
      }
      if (Array.isArray(value)) {
        const operands = value.map((v, i) =>
          prepare(v, "template", `${path}/${i}`, false),
        );
        return { run: (frame) => operands.map((o) => o.run(frame)) };
      }
      if (value !== null && typeof value === "object") {
        const operands = codePointKeys(value).map(
          (key) =>
            [
              key,
              prepare(
                (value as Record<string, JsonValue>)[key]!,
                "template",
                `${path}/${pointer(key)}`,
                false,
              ),
            ] as const,
        );
        return {
          run: (frame) =>
            Object.fromEntries(operands.map(([key, o]) => [key, o.run(frame)])),
        };
      }
      return { run: () => value };
    };
    const operand = prepare(
      unit.value,
      unit.mode,
      unit.location.fieldPath,
      true,
    );
    if (directContract && !completeSelector)
      fail(
        "RSL_EXPR_TYPE",
        "An explicit direct payload contract requires one complete binding selector",
      );
    return Object.freeze({
      unit,
      validation: freezeDeep(validation),
      evaluate: (frame: EvaluationFrame) => {
        try {
          assertFrame(frame);
          const value = operand.run(frame);
          check(
            value,
            unit.expectedType,
            frame,
            unit.location.fieldPath,
            !directContract &&
              !(completeSelector && hasReferences(unit.expectedType, unit)),
          );
          if (unit.slot === "emitNext" && isReference(value))
            fail(
              "RSL_EXPR_REFERENCE",
              "A runtime reference cannot become a business output",
              frame,
            );
          if (
            ["emitTiming", "scheduleTime"].includes(unit.slot) &&
            (typeof value !== "number" || !Number.isFinite(value))
          )
            fail(
              "RSL_EXPR_TIME",
              "Timing must be finite in the declared clock",
              frame,
            );
          if (["emitTiming", "scheduleTime"].includes(unit.slot))
            check(
              value,
              clockType("LogicalTime", unit.context.clock.id),
              frame,
              unit.location.fieldPath,
              false,
            );
          return value;
        } catch (error) {
          if (hasFailure(error)) throw error;
          return fail(
            "RSL_EXPR_EVALUATION",
            "Expression evaluation failed",
            frame,
            undefined,
            error,
          );
        }
      },
    });
  }

  function compileGroup(
    input: GroupInput,
    kind: "capture" | "transition",
    options: Readonly<Record<string, CompileOptions>> = {},
  ): CompiledGroup {
    const checked =
      kind === "capture"
        ? validateCaptureGroup(input)
        : validateTransitionGroup(input);
    if (!checked.valid) {
      const diagnostics = [
        ...checked.diagnostics,
        ...Object.values(checked.results).flatMap((r) => r.diagnostics),
      ];
      const first: Diagnostic = diagnostics[0]!;
      throw Object.assign(evaluationFailure(first.code, first.message), {
        diagnostics,
        diagnostic: first,
      });
    }
    const group = freezeDeep(structuredClone(input));
    const keys = codePointKeys(group.targets);
    const frameProbe = compile({
      ...group.base,
      slot: kind,
      mode: "literal",
      value: true,
      expectedType: primitive("boolean"),
    });
    let allocator: string | undefined;
    const expressions = new Map<string, CompiledExpression>();
    const units = new Map<string, ExpressionUnit>();
    for (const key of keys) {
      const target = group.targets[key]!;
      const unit: ExpressionUnit = {
        ...group.base,
        slot: kind,
        mode:
          typeof target.value === "string" && target.value.startsWith("{%")
            ? "expression"
            : "template",
        value: target.value,
        expectedType: target.type,
        location: {
          ...group.base.location,
          fieldPath: `${group.base.location.fieldPath}/${pointer(key)}`,
        },
      };
      units.set(key, unit);
      if (checked.results[key]!.requirements.capabilities.length)
        allocator = key;
      else expressions.set(key, compile(unit, options[key]));
    }
    const evaluate = (
      frame: EvaluationFrame,
      capability?: { readonly nextTimerId: () => unknown },
    ): ValueRecord => {
      frameProbe.evaluate(frame);
      if (frame.phase !== (kind === "transition" ? "transition" : "reaction"))
        throw evaluationFailure(
          "RSL_EXPR_CONTEXT",
          `Invalid ${kind} frame`,
          undefined,
          frame,
        );
      const result: Record<string, unknown> = Object.create(null);
      for (const key of keys)
        if (key !== allocator)
          result[key] = expressions.get(key)!.evaluate(frame);
      if (allocator) {
        const unit = units.get(allocator)!;
        if (!capability)
          throw evaluationFailure(
            "RSL_EXPR_EFFECT",
            "Capture requires the declared timer allocator",
            unit,
            frame,
          );
        if (frame.subscription?.closed)
          throw evaluationFailure(
            "RSL_EXPR_REFERENCE",
            "Cannot allocate for a closed owner",
            unit,
            frame,
          );
        try {
          const id = capability.nextTimerId();
          if (isThenable(id))
            throw evaluationFailure(
              "RSL_EXPR_ASYNC",
              "Timer allocator returned a thenable",
              unit,
              frame,
            );
          if (!matchesType(id, unit.expectedType, unit.types, frame, config))
            throw evaluationFailure(
              "RSL_EXPR_REFERENCE",
              "Timer identity has invalid type or ownership",
              unit,
              frame,
            );
          result[allocator] = id;
        } catch (error) {
          if (hasFailure(error)) throw error;
          throw evaluationFailure(
            "RSL_EXPR_EVALUATION",
            "Timer allocation failed",
            unit,
            frame,
            undefined,
            error,
          );
        }
      }
      return Object.freeze(result);
    };
    return Object.freeze({
      evaluate,
      apply: (
        frame: EvaluationFrame,
        capability?: { readonly nextTimerId: () => unknown },
      ) => {
        const updates = evaluate(frame, capability);
        return snapshot({
          ...(frame.bindings[
            kind === "transition" ? "state" : "local"
          ] as ValueRecord),
          ...updates,
        });
      },
    });
  }
  return Object.freeze({
    manifest: Object.freeze({
      adapter: "rsl.synchronous-evaluator/0.1",
      dialect: "rsl.jsonata.core-1",
      engine: "jsonata",
      engineVersion,
      helperRegistryVersion: config.helperRegistryVersion,
      evaluation: "synchronous",
      regexHost: `Node ${process.versions.node}; V8 ${process.versions.v8}`,
      maxEvaluationSteps: maxSteps,
      maxValueNodes: maxNodes,
      standardFunctions: STANDARD_FUNCTIONS,
    }),
    compile,
    compileCapture: (
      input: GroupInput,
      options?: Readonly<Record<string, CompileOptions>>,
    ) => compileGroup(input, "capture", options),
    compileTransition: (
      input: GroupInput,
      options?: Readonly<Record<string, CompileOptions>>,
    ) => compileGroup(input, "transition", options),
  });
}
