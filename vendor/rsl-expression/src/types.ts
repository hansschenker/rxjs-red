/** Structurally compatible with rxjs-rsl-astra's normalized TypeRef model. */
export type TypeRef =
  | {
      readonly kind: "primitive";
      readonly name:
        "string" | "number" | "boolean" | "null" | "unknown" | "never" | "void";
    }
  | { readonly kind: "named"; readonly ref: string }
  | { readonly kind: "array"; readonly items: TypeRef }
  | { readonly kind: "tuple"; readonly items: readonly TypeRef[] }
  | {
      readonly kind: "record";
      readonly fields: Readonly<Record<string, TypeRef>>;
    }
  | {
      readonly kind: "union";
      readonly members: readonly [TypeRef, ...TypeRef[]];
    }
  | {
      readonly kind: "generic";
      readonly ref: string;
      readonly arguments: readonly TypeRef[];
    }
  | { readonly kind: "observable"; readonly value: TypeRef };
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type Slot =
  | "initial"
  | "guard"
  | "capture"
  | "transition"
  | "invokeArgument"
  | "emitNext"
  | "emitWhen"
  | "emitTiming"
  | "scheduleTime"
  | "resourceSelector";
export interface HelperContract {
  readonly parameters: readonly TypeRef[];
  readonly output: TypeRef;
  readonly purity: "pure";
  readonly evaluation: "synchronous";
  readonly version: string;
}
export interface EventType {
  readonly source:
    "source" | "input" | "inner" | "timer" | "notifier" | "downstream";
  readonly kind: "next" | "error" | "complete" | "unsubscribe";
  readonly valueType?: TypeRef;
  readonly errorType?: TypeRef;
  readonly scheduled?: boolean;
}
export interface ExpressionContext {
  readonly parameters: Readonly<Record<string, TypeRef>>;
  readonly state: Readonly<Record<string, TypeRef>>;
  /** Only already-produced locals, not every name declared later in a reaction. */
  readonly locals: Readonly<Record<string, TypeRef>>;
  readonly bindings: Readonly<
    Record<
      string,
      {
        readonly type: TypeRef;
        readonly owner: "execution" | "operator" | "connection";
        readonly source: string;
      }
    >
  >;
  readonly clock: { readonly id: string; readonly unit: string };
  readonly sharedConnection: boolean;
  readonly event?: EventType;
}
/** Normalized compiler input, not an ASL state or complete reaction definition. */
export interface ExpressionUnit {
  readonly profile: "rsl.expression-context/0.1";
  readonly dialect: "rsl.jsonata.core-1";
  readonly QueryLanguage: "JSONata";
  readonly slot: Slot;
  readonly mode: "literal" | "expression" | "template";
  readonly value: JsonValue;
  readonly expectedType: TypeRef;
  readonly context: ExpressionContext;
  readonly types: Readonly<Record<string, TypeRef>>;
  readonly helpers: Readonly<Record<string, HelperContract>>;
  readonly location: { readonly file: string; readonly fieldPath: string };
}
export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly file: string;
  readonly fieldPath: string;
  /** UTF-16 offset into the decoded field string, not the YAML source bytes. */
  readonly offset?: number;
  readonly line?: number;
  readonly column?: number;
  readonly causeCode?: string;
}
export interface RuntimeCheck {
  readonly kind:
    | "result-type"
    | "presence"
    | "function-contract"
    | "time-contract"
    | "reference-contract"
    | "evaluation";
  readonly fieldPath: string;
  readonly message: string;
}
export interface ValidationResult {
  readonly valid: boolean;
  readonly status: "invalid" | "valid" | "valid-with-runtime-checks";
  readonly diagnostics: readonly Diagnostic[];
  readonly runtimeChecks: readonly RuntimeCheck[];
  readonly requirements: {
    readonly dialect: "rsl.jsonata.core-1";
    readonly synchronousEvaluation: true;
    readonly functions: readonly string[];
    readonly features: readonly string[];
    readonly bindings: readonly string[];
    readonly capabilities: readonly string[];
  };
}
