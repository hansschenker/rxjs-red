import type {
  Diagnostic,
  ExpressionUnit,
  HelperContract,
  TypeRef,
  ValidationResult,
} from "./types.js";

export type ValueRecord = Readonly<Record<string, unknown>>;
export interface LogicalClock {
  readonly id: string;
  readonly unit: string;
  readonly sample: () => number;
}
export interface FrameInput {
  readonly phase: "initial" | "reaction" | "transition";
  readonly parameters: ValueRecord;
  readonly bindings?: ValueRecord;
  readonly state?: ValueRecord;
  readonly local?: ValueRecord;
  readonly notification?: ValueRecord;
  readonly clock?: LogicalClock;
  readonly executionId?: string;
  readonly operatorId?: string;
  readonly subscription?: Readonly<{
    id: string;
    closed: boolean;
    parentId?: string;
  }>;
  readonly connectionId?: string;
  readonly reaction?: string;
  readonly action?: string;
}
export interface EvaluationFrame {
  readonly phase: FrameInput["phase"];
  readonly bindings: EvaluationBindings;
  readonly time?: Readonly<{ contextId: string; unit: string; now: number }>;
  readonly executionId?: string;
  readonly operatorId?: string;
  readonly subscription?: FrameInput["subscription"];
  readonly connectionId?: string;
  readonly reaction?: string;
  readonly action?: string;
}
export interface RslContextView {
  readonly parameters: ValueRecord;
  readonly memory?: ValueRecord;
  readonly previousMemory?: ValueRecord;
  readonly event?: ValueRecord;
  readonly locals?: ValueRecord;
  readonly time?: EvaluationFrame["time"];
  readonly execution?: Readonly<{ id: string }>;
  readonly operator?: Readonly<{ id: string }>;
  readonly subscription?: FrameInput["subscription"];
  readonly connection?: Readonly<{ id: string }>;
}
export interface EvaluationBindings extends ValueRecord {
  readonly parameters: ValueRecord;
  readonly rsl: RslContextView;
  readonly state?: ValueRecord;
  readonly previousState?: ValueRecord;
  readonly notification?: ValueRecord;
  readonly local?: ValueRecord;
}
export interface RuntimeDiagnostic extends Diagnostic {
  readonly executionId?: string;
  readonly operatorId?: string;
  readonly reaction?: string;
  readonly action?: string;
  readonly eventSource?: string;
  readonly eventKind?: string;
  readonly logicalTime?: number;
}
export interface EvaluationFailure extends Error {
  readonly diagnostic: RuntimeDiagnostic;
  readonly diagnostics?: readonly Diagnostic[];
}
export interface HelperImplementation {
  readonly contract: HelperContract;
  readonly call: (...arguments_: readonly unknown[]) => unknown;
}
export interface ReferenceContract {
  /** Recognize values reserved for resources, including nested output checks. */
  readonly isReference: (value: unknown) => boolean;
  /** Check exact type and current ownership/liveness without invoking the resource. */
  readonly accepts: (
    value: unknown,
    type: TypeRef,
    frame: EvaluationFrame,
  ) => boolean;
}
export interface AdapterConfiguration {
  readonly helpers?: Readonly<Record<string, HelperImplementation>>;
  readonly helperRegistryVersion: string;
  readonly references?: ReferenceContract;
  /** Numeric range/precision policy, in addition to finite/nonnegative checks. */
  readonly timeValue?: (
    value: number,
    type: TypeRef,
    frame: EvaluationFrame,
  ) => boolean;
  /** Approval of dimensional calculations left unresolved by static analysis. */
  readonly temporalExpression?: (unit: ExpressionUnit) => boolean;
  /** Custom date pictures must fully specify date and timezone; checked per call. */
  readonly dateTimeArguments?: (timestamp: string, picture: string) => boolean;
  readonly maxEvaluationSteps?: number;
  readonly maxValueNodes?: number;
}
export interface CompileOptions {
  /** Explicit enclosing payload contract; only a complete direct selector qualifies. */
  readonly directValue?: {
    readonly accepts: (value: unknown, type: TypeRef) => boolean;
    readonly contractId: string;
  };
}
export interface CompiledExpression {
  readonly unit: ExpressionUnit;
  readonly validation: ValidationResult;
  readonly evaluate: (frame: EvaluationFrame) => unknown;
}
export interface CompiledGroup {
  readonly evaluate: (
    frame: EvaluationFrame,
    capability?: { readonly nextTimerId: () => unknown },
  ) => ValueRecord;
  /** Returns a new complete state/local record. Caller commits it at the declared step. */
  readonly apply: (
    frame: EvaluationFrame,
    capability?: { readonly nextTimerId: () => unknown },
  ) => ValueRecord;
}
export interface EmissionOperands {
  readonly next: CompiledExpression;
  readonly emitWhen: CompiledExpression;
  readonly timing: CompiledExpression;
}
export interface EmissionBoundary {
  readonly isActive: () => boolean;
  readonly validateTiming: (time: number, frame: EvaluationFrame) => boolean;
  readonly deliver: (value: unknown, time: number) => void;
}
