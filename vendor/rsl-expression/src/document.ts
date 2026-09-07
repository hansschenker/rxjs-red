import { parseAllDocuments, isMap, isSeq, isScalar, isAlias } from "yaml";
import { inspectJson } from "./validator.js";
import type { Diagnostic } from "./types.js";

/** Deterministic source boundary. Runtime payloads never pass through this parser. */
export function parseExpressionDocument(
  source: string,
  file = "<input>",
  format: "yaml" | "json" = "yaml",
): { document?: unknown; diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const error = (message: string, offset = 0) => {
    const prefix = source.slice(0, offset);
    diagnostics.push({
      code: "RSL_SCHEMA_SOURCE",
      message,
      file,
      fieldPath: "/",
      offset,
      line: prefix.split("\n").length,
      column: Array.from(prefix.split("\n").at(-1) ?? "").length + 1,
    });
  };
  if (source.length > 1_000_000) {
    error("Source exceeds 1,000,000 UTF-16 code units");
    return { diagnostics };
  }
  if (source.startsWith("\uFEFF") || source.includes("\r"))
    error("Use UTF-8 without BOM and LF line endings");
  if (/^(?:%|---(?:\s|$)|\.\.\.(?:\s|$))/m.test(source))
    error("Directives and document markers are not admitted");
  if (format === "json") {
    try {
      JSON.parse(source);
    } catch {
      error("Invalid JSON syntax");
    }
  }
  if (diagnostics.length) return { diagnostics };
  const docs = parseAllDocuments(source, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    keepSourceTokens: true,
    strict: true,
  });
  if (docs.length !== 1) {
    error("Exactly one document is required");
    return { diagnostics };
  }
  const doc = docs[0]!;
  for (const issue of [...doc.errors, ...doc.warnings])
    error(issue.message, issue.pos[0]);
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 96) {
      error("Source exceeds maximum depth 96");
      return;
    }
    if (value === null || typeof value !== "object") return;
    const n = value as {
      anchor?: string;
      tag?: string;
      range?: number[];
      flow?: boolean;
      srcToken?: { source?: string; type?: string };
    };
    const at = n.range?.[0] ?? 0;
    if (isAlias(value) || n.anchor || n.tag) {
      error("Aliases, anchors, and explicit tags are not admitted", at);
      return;
    }
    if (isMap(value)) {
      if (format === "yaml" && value.flow)
        error("Use a block mapping in deterministic YAML", at);
      for (const pair of value.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string")
          error("Mapping keys must be strings", at);
        visit(pair.key, depth + 1);
        visit(pair.value, depth + 1);
      }
    } else if (isSeq(value)) value.items.forEach((v) => visit(v, depth + 1));
    else if (isScalar(value)) {
      const token = n.srcToken?.source ?? "";
      if (value.type === "QUOTE_DOUBLE") {
        try {
          JSON.parse(token);
        } catch {
          error(
            "Double-quoted scalars must use JSON string escaping on one physical line",
            at,
          );
        }
      } else if (value.type === "PLAIN") {
        if (
          typeof value.value === "string" &&
          !/^[A-Za-z_][A-Za-z0-9_.:/-]*$/.test(token)
        )
          error("Quote this string using JSON double-quote syntax", at);
        if (
          typeof value.value === "number" &&
          !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)
        )
          error("Use a JSON-compatible decimal number", at);
        if (value.value === null && token !== "null")
          error("Null must be explicit: null", at);
        if (
          typeof value.value === "boolean" &&
          !["true", "false"].includes(token)
        )
          error("Use lowercase Boolean literals", at);
      } else error("Single quotes and block scalars are not admitted", at);
    }
  };
  visit(doc.contents);
  if (diagnostics.length) return { diagnostics };
  const document: unknown = doc.toJS({ mapAsMap: false, maxAliasCount: 0 });
  const issue = inspectJson(document);
  if (issue) {
    error(issue);
    return { diagnostics };
  }
  return { document, diagnostics };
}
