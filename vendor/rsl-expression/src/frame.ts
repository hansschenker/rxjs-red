import type {
  EvaluationBindings,
  EvaluationFrame,
  FrameInput,
  LogicalClock,
  ValueRecord,
} from "./runtime-types.js";

export function ownValue(
  record: unknown,
  key: string,
): { present: boolean; value: unknown } {
  if (
    record === null ||
    (typeof record !== "object" && typeof record !== "function")
  )
    return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false, value: undefined };
  if (!("value" in descriptor))
    throw new TypeError(
      `Accessor property ${key} is outside the value contract`,
    );
  return { present: true, value: descriptor.value };
}

/** Copies the host-owned envelope, never the application values inside it. */
export function snapshot(record: ValueRecord): ValueRecord {
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(record))
    result[key] = ownValue(record, key).value;
  return Object.freeze(result);
}

/** One clock facade should be reused for the lifetime of its declared clock domain. */
export function createLogicalClock(
  id: string,
  unit: string,
  read: () => number,
): LogicalClock {
  if (!id || !unit) throw new TypeError("Clock identity and unit are required");
  let previous = -Infinity;
  return Object.freeze({
    id,
    unit,
    sample: () => {
      const value = read();
      if (!Number.isFinite(value) || value < previous)
        throw new RangeError("Clock samples must be finite and monotonic");
      previous = value;
      return value;
    },
  });
}

const frames = new WeakSet<object>();
export function isEvaluationFrame(frame: EvaluationFrame): boolean {
  return frames.has(frame);
}

export function createEvaluationFrame(input: FrameInput): EvaluationFrame {
  const parameters = snapshot(input.parameters);
  const bindings: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(snapshot(input.bindings ?? {})))
    bindings[key] = value;
  const rsl: Record<string, unknown> = Object.create(null);
  bindings.parameters = rsl.parameters = parameters;
  let time: EvaluationFrame["time"];
  let subscription: FrameInput["subscription"];
  if (input.phase !== "initial") {
    if (
      !input.state ||
      !input.local ||
      !input.notification ||
      !input.clock ||
      !input.executionId ||
      !input.operatorId ||
      !input.subscription
    )
      throw new TypeError(
        "A reaction frame requires state, locals, event, clock and ownership metadata",
      );
    if (
      typeof input.subscription.closed !== "boolean" ||
      !input.subscription.id
    )
      throw new TypeError("Invalid subscription metadata");
    for (const id of [
      input.executionId,
      input.operatorId,
      input.subscription.id,
      input.subscription.parentId,
      input.connectionId,
    ])
      if (id !== undefined && (typeof id !== "string" || !id))
        throw new TypeError("Metadata identities must be nonempty strings");
    bindings.state = rsl.memory = snapshot(input.state);
    bindings.local = rsl.locals = snapshot(input.local);
    bindings.notification = rsl.event = snapshot(input.notification);
    if (input.phase === "transition")
      bindings.previousState = rsl.previousMemory = bindings.state;
    time = Object.freeze({
      contextId: input.clock.id,
      unit: input.clock.unit,
      now: input.clock.sample(),
    });
    subscription = Object.freeze({
      id: input.subscription.id,
      closed: input.subscription.closed,
      ...(input.subscription.parentId === undefined
        ? {}
        : { parentId: input.subscription.parentId }),
    });
    rsl.time = time;
    rsl.execution = Object.freeze({ id: input.executionId });
    rsl.operator = Object.freeze({ id: input.operatorId });
    rsl.subscription = subscription;
    if (input.connectionId !== undefined)
      rsl.connection = Object.freeze({ id: input.connectionId });
  }
  bindings.rsl = Object.freeze(rsl);
  const frame: EvaluationFrame = Object.freeze({
    phase: input.phase,
    bindings: Object.freeze(bindings) as unknown as EvaluationBindings,
    time,
    subscription,
    executionId: input.executionId,
    operatorId: input.operatorId,
    connectionId: input.connectionId,
    reaction: input.reaction,
    action: input.action,
  });
  frames.add(frame);
  return frame;
}
