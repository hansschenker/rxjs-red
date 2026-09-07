import { isDeepStrictEqual } from "node:util";
import type { TypeRef } from "./types.js";
import type { EvaluationFrame, ReferenceContract } from "./runtime-types.js";

/** A host registry; it is never exposed as a JSONata binding. IDs use opaque strings. */
export function createReferenceRegistry(namespace: string) {
  if (!namespace)
    throw new TypeError("A unique registry namespace is required");
  let sequence = 0;
  const entries = new Map<
    unknown,
    { type: TypeRef; owner: string; active: () => boolean }
  >();
  const register = (
    value: unknown,
    type: TypeRef,
    owner: string,
    active: () => boolean,
  ): unknown => {
    if (entries.has(value)) throw new TypeError("Reference already registered");
    entries.set(value, { type: structuredClone(type), owner, active });
    return value;
  };
  const contract: ReferenceContract = Object.freeze({
    isReference: (value: unknown) => entries.has(value),
    accepts: (value: unknown, type: TypeRef, frame: EvaluationFrame) => {
      const entry = entries.get(value);
      return Boolean(
        entry &&
        isDeepStrictEqual(entry.type, type) &&
        (entry.owner === frame.subscription?.id ||
          entry.owner === frame.connectionId) &&
        entry.active(),
      );
    },
  });
  return Object.freeze({
    contract,
    register,
    allocate: (type: TypeRef, owner: string, active: () => boolean) =>
      register(`\u0000rsl:${namespace}:${++sequence}`, type, owner, active),
    revoke: (value: unknown) => {
      const entry = entries.get(value);
      if (entry) entries.set(value, { ...entry, active: () => false });
    },
  });
}
