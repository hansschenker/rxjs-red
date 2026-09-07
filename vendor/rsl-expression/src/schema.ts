const ref = { $ref: "#/$defs/typeRef" };
const map = (value: object) => ({
  type: "object",
  additionalProperties: value,
});
const record = (
  properties: Record<string, object>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string", minLength: 1 };
const array = (items: object) => ({ type: "array", items });
const tag = (kind: string) => ({ const: kind });
export const expressionUnitSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:rsl:schema:expression-unit:0.1",
  title: "RSL Expression Validation Unit v0.1",
  ...record({
    profile: { const: "rsl.expression-context/0.1" },
    dialect: { const: "rsl.jsonata.core-1" },
    QueryLanguage: { const: "JSONata" },
    slot: {
      enum: [
        "initial",
        "guard",
        "capture",
        "transition",
        "invokeArgument",
        "emitNext",
        "emitWhen",
        "emitTiming",
        "scheduleTime",
        "resourceSelector",
      ],
    },
    mode: { enum: ["literal", "expression", "template"] },
    value: { $ref: "#/$defs/jsonValue" },
    expectedType: ref,
    context: record(
      {
        parameters: map(ref),
        state: map(ref),
        locals: map(ref),
        bindings: map(
          record({
            type: ref,
            owner: { enum: ["execution", "operator", "connection"] },
            source: text,
          }),
        ),
        clock: record({ id: text, unit: text }),
        sharedConnection: { type: "boolean" },
        event: record(
          {
            source: {
              enum: [
                "source",
                "input",
                "inner",
                "timer",
                "notifier",
                "downstream",
              ],
            },
            kind: { enum: ["next", "error", "complete", "unsubscribe"] },
            valueType: ref,
            errorType: ref,
            scheduled: { type: "boolean" },
          },
          ["source", "kind"],
        ),
      },
      [
        "parameters",
        "state",
        "locals",
        "bindings",
        "clock",
        "sharedConnection",
      ],
    ),
    types: map(ref),
    helpers: map(
      record({
        parameters: array(ref),
        output: ref,
        purity: { const: "pure" },
        evaluation: { const: "synchronous" },
        version: text,
      }),
    ),
    location: record({ file: text, fieldPath: text }),
  }),
  allOf: [
    {
      if: { properties: { mode: { const: "expression" } }, required: ["mode"] },
      then: { properties: { value: { type: "string" } } },
    },
  ],
  $defs: {
    jsonValue: {
      anyOf: [
        { type: ["null", "boolean", "number", "string"] },
        array({ $ref: "#/$defs/jsonValue" }),
        map({ $ref: "#/$defs/jsonValue" }),
      ],
    },
    typeRef: {
      oneOf: [
        record({
          kind: tag("primitive"),
          name: {
            enum: [
              "string",
              "number",
              "boolean",
              "null",
              "unknown",
              "never",
              "void",
            ],
          },
        }),
        record({ kind: tag("named"), ref: text }),
        record({ kind: tag("array"), items: ref }),
        record({ kind: tag("tuple"), items: array(ref) }),
        record({ kind: tag("record"), fields: map(ref) }),
        record({ kind: tag("union"), members: { ...array(ref), minItems: 1 } }),
        record({ kind: tag("generic"), ref: text, arguments: array(ref) }),
        record({ kind: tag("observable"), value: ref }),
      ],
    },
  },
};
