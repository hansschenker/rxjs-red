import type { TypeRef } from "./types.js";
export const primitive = (
  name: Extract<TypeRef, { kind: "primitive" }>["name"],
): TypeRef => ({ kind: "primitive", name });
export const UNKNOWN = primitive("unknown"),
  NUMBER = primitive("number"),
  STRING = primitive("string"),
  BOOLEAN = primitive("boolean");
export const recordType = (
  fields: Readonly<Record<string, TypeRef>>,
): TypeRef => ({ kind: "record", fields });
export function union(types: readonly TypeRef[]): TypeRef {
  const unique = [
    ...new Map(
      types
        .flatMap((t) => (t.kind === "union" ? t.members : [t]))
        .map((t) => [JSON.stringify(t), t]),
    ).values(),
  ];
  if (unique.some((t) => t.kind === "primitive" && t.name === "unknown"))
    return UNKNOWN;
  return unique.length === 1
    ? unique[0]!
    : unique.length === 0
      ? primitive("never")
      : { kind: "union", members: unique as [TypeRef, ...TypeRef[]] };
}
export function resolve(
  type: TypeRef,
  registry: Readonly<Record<string, TypeRef>>,
  seen: readonly string[] = [],
): TypeRef {
  if (
    type.kind !== "named" ||
    !Object.hasOwn(registry, type.ref) ||
    seen.includes(type.ref)
  )
    return type;
  return resolve(registry[type.ref]!, registry, [...seen, type.ref]);
}
export type Compatibility = "yes" | "no" | "runtime";
export function compatible(
  actual: TypeRef,
  expected: TypeRef,
  registry: Readonly<Record<string, TypeRef>>,
): Compatibility {
  actual = resolve(actual, registry);
  expected = resolve(expected, registry);
  if (expected.kind === "primitive" && expected.name === "unknown")
    return "yes";
  if (actual.kind === "primitive" && actual.name === "never") return "yes";
  if (actual.kind === "primitive" && actual.name === "unknown")
    return "runtime";
  if (expected.kind === "union") {
    if (actual.kind === "union")
      return alternatives(
        actual.members.map((a) => compatible(a, expected, registry)),
      );
    const results = expected.members.map((e) =>
      compatible(actual, e, registry),
    );
    return results.includes("yes")
      ? "yes"
      : results.includes("runtime")
        ? "runtime"
        : "no";
  }
  if (actual.kind === "union")
    return alternatives(
      actual.members.map((a) => compatible(a, expected, registry)),
    );
  if (actual.kind === "named" || expected.kind === "named")
    return actual.kind === "named" &&
      expected.kind === "named" &&
      actual.ref === expected.ref
      ? "yes"
      : "runtime";
  if (actual.kind === "tuple" && expected.kind === "array")
    return all(
      actual.items.map((a) => compatible(a, expected.items, registry)),
    );
  if (actual.kind !== expected.kind) return "no";
  if (actual.kind === "primitive" && expected.kind === "primitive")
    return actual.name === expected.name ? "yes" : "no";
  if (actual.kind === "array" && expected.kind === "array")
    return compatible(actual.items, expected.items, registry);
  if (actual.kind === "tuple" && expected.kind === "tuple")
    return actual.items.length === expected.items.length
      ? all(
          actual.items.map((a, i) =>
            compatible(a, expected.items[i]!, registry),
          ),
        )
      : "no";
  if (actual.kind === "record" && expected.kind === "record")
    return all(
      Object.entries(expected.fields).map(([k, v]) =>
        Object.hasOwn(actual.fields, k)
          ? compatible(actual.fields[k]!, v, registry)
          : "no",
      ),
    );
  if (actual.kind === "generic" && expected.kind === "generic")
    return actual.ref === expected.ref &&
      actual.arguments.length === expected.arguments.length
      ? all(
          actual.arguments.map((a, i) =>
            compatible(a, expected.arguments[i]!, registry),
          ),
        )
      : "no";
  if (actual.kind === "observable" && expected.kind === "observable")
    return compatible(actual.value, expected.value, registry);
  return "runtime";
}
const all = (values: readonly Compatibility[]): Compatibility =>
  values.includes("no") ? "no" : values.includes("runtime") ? "runtime" : "yes";
const alternatives = (values: readonly Compatibility[]): Compatibility =>
  values.every((v) => v === "yes")
    ? "yes"
    : values.every((v) => v === "no")
      ? "no"
      : "runtime";
export const clockType = (
  kind: "LogicalTime" | "Duration",
  clockId: string,
): TypeRef => ({
  kind: "generic",
  ref: `rsl.${kind}`,
  arguments: [{ kind: "named", ref: clockId }],
});
export const identityType = (kind: string): TypeRef => ({
  kind: "generic",
  ref: `rsl.${kind}`,
  arguments: [],
});
export const isTemporal = (
  t: TypeRef,
): t is Extract<TypeRef, { kind: "generic" }> & {
  readonly ref: "rsl.LogicalTime" | "rsl.Duration";
} =>
  t.kind === "generic" && ["rsl.LogicalTime", "rsl.Duration"].includes(t.ref);
