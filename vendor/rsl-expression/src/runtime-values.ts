import { isTemporal, resolve } from "./type-system.js";
import { ownValue } from "./frame.js";
import type { TypeRef } from "./types.js";
import type { AdapterConfiguration, EvaluationFrame } from "./runtime-types.js";

export const isThenable = (value: unknown): boolean => {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return false;
  // Inspect descriptors so rejecting a thenable does not invoke its getter.
  for (
    let object: object | null = value;
    object;
    object = Object.getPrototypeOf(object)
  ) {
    const d = Object.getOwnPropertyDescriptor(object, "then");
    if (d) return !("value" in d) || typeof d.value === "function";
  }
  return false;
};

/** Runtime data is never passed through NFC/source normalization. */
export function assertPortable(
  value: unknown,
  maximum: number,
  isReference: (value: unknown) => boolean,
  allowReferences = false,
  allowSequenceMetadata = false,
): void {
  let visits = 0;
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    if (++visits > maximum || depth > 96)
      throw new RangeError("Value traversal limit exceeded");
    if (isReference(current)) {
      if (!allowReferences)
        throw new TypeError(
          "Runtime references cannot escape into portable values",
        );
      if (typeof current !== "string")
        throw new TypeError(
          "General JSONata reference computation requires an opaque string identity",
        );
      return;
    }
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "string"
    )
      return;
    if (typeof current === "number" && Number.isFinite(current)) return;
    if (current === null || typeof current !== "object")
      throw new TypeError("Expected a present finite JSON value");
    if (isThenable(current))
      throw new TypeError(
        "Thenable is outside the portable computed-value contract",
      );
    if (ancestors.has(current))
      throw new TypeError("Cyclic value is outside the portable data domain");
    if (
      !Array.isArray(current) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(current))
    )
      throw new TypeError(
        "Non-plain object is outside the portable data domain",
      );
    ancestors.add(current);
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        const field = ownValue(current, String(i));
        if (!field.present)
          throw new TypeError(
            "Sparse arrays are outside the portable data domain",
          );
        visit(field.value, depth + 1);
      }
      // JSONata adds non-index sequence metadata; it is not application data.
      for (const key of Reflect.ownKeys(current)) {
        if (
          key === "length" ||
          (allowSequenceMetadata &&
            ["sequence", "keepSingleton", "cons", "outerWrapper"].includes(
              String(key),
            ))
        )
          continue;
        if (
          typeof key !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= current.length
        )
          throw new TypeError("Non-index array member");
      }
    } else {
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string")
          throw new TypeError(
            "Symbol keys are outside the portable data domain",
          );
        visit(ownValue(current, key).value, depth + 1);
      }
    }
    ancestors.delete(current);
  };
  visit(value, 0);
}

/** Remove engine sequence annotations without serializing or cloning unchanged payloads. */
export function normalizeSequences(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value.map(normalizeSequences);
    const annotated = [
      "sequence",
      "keepSingleton",
      "cons",
      "outerWrapper",
    ].some((key) => Object.hasOwn(value, key));
    return annotated || items.some((item, i) => item !== value[i])
      ? items
      : value;
  }
  const entries = Object.entries(value);
  const normalized = entries.map(
    ([key, item]) => [key, normalizeSequences(item)] as const,
  );
  return normalized.some(([, item], i) => item !== entries[i]![1])
    ? Object.fromEntries(normalized)
    : value;
}

export function matchesType(
  value: unknown,
  type: TypeRef,
  types: Readonly<Record<string, TypeRef>>,
  frame: EvaluationFrame,
  config: AdapterConfiguration,
  depth = 0,
): boolean {
  if (depth > 96) return false;
  type = resolve(type, types);
  const match = (v: unknown, t: TypeRef) =>
    matchesType(v, t, types, frame, config, depth + 1);
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "unknown":
          return config.references?.isReference(value) !== true;
        case "never":
          return false;
        case "void":
          return value === undefined;
        case "null":
          return value === null;
        case "number":
          return typeof value === "number" && Number.isFinite(value);
        default:
          return typeof value === type.name;
      }
    case "record":
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.entries(type.fields).every(([key, t]) => {
          const field = ownValue(value, key);
          return field.present && match(field.value, t);
        })
      );
    case "array":
      return (
        Array.isArray(value) &&
        Array.from({ length: value.length }, (_, i) =>
          ownValue(value, String(i)),
        ).every((f) => f.present && match(f.value, type.items))
      );
    case "tuple":
      return (
        Array.isArray(value) &&
        value.length === type.items.length &&
        type.items.every((t, i) => {
          const f = ownValue(value, String(i));
          return f.present && match(f.value, t);
        })
      );
    case "union":
      return type.members.some((t) => match(value, t));
    case "generic":
      if (isTemporal(type))
        return (
          typeof value === "number" &&
          Number.isFinite(value) &&
          (type.ref !== "rsl.Duration" || value >= 0) &&
          (!frame.time ||
            (type.arguments[0]?.kind === "named" &&
              type.arguments[0].ref === frame.time.contextId)) &&
          (config.timeValue?.(value, type, frame) ?? true)
        );
      // Metadata identities have an exact declared owner in this frame.
      if (type.ref === "rsl.ExecutionId")
        return value === frame.executionId && typeof value === "string";
      if (type.ref === "rsl.OperatorId")
        return value === frame.operatorId && typeof value === "string";
      if (type.ref === "rsl.SubscriptionId")
        return (
          typeof value === "string" &&
          (value === frame.subscription?.id ||
            value === frame.subscription?.parentId)
        );
      if (type.ref === "rsl.ConnectionId")
        return typeof value === "string" && value === frame.connectionId;
      return config.references?.accepts(value, type, frame) === true;
    case "observable":
      return config.references?.accepts(value, type, frame) === true;
    case "named":
      return false;
  }
}
