import { evaluationFailure } from "./evaluator.js";
import { createEvaluationFrame, snapshot } from "./frame.js";
import { isThenable } from "./runtime-values.js";
import type {
  CompiledExpression,
  CompiledGroup,
  EmissionBoundary,
  EmissionOperands,
  EvaluationFrame,
  FrameInput,
  ValueRecord,
} from "./runtime-types.js";

/** Operand evaluation is synchronous. Delivery and scheduling remain explicit host actions. */
export function evaluateEmission(
  operands: EmissionOperands,
  frame: EvaluationFrame,
  boundary: EmissionBoundary,
): Readonly<{ delivered: boolean; value: unknown; timing: number }> {
  for (const [key, slot] of [
    ["next", "emitNext"],
    ["emitWhen", "emitWhen"],
    ["timing", "emitTiming"],
  ] as const)
    if (operands[key].unit.slot !== slot)
      throw evaluationFailure(
        "RSL_EXPR_CONTEXT",
        `Emission ${key} requires slot ${slot}`,
        operands[key].unit,
        frame,
      );
  const value = operands.next.evaluate(frame);
  const permission = operands.emitWhen.evaluate(frame);
  const timing = operands.timing.evaluate(frame) as number;
  if (boundary.validateTiming(timing, frame) !== true)
    throw evaluationFailure(
      "RSL_EXPR_TIME",
      "Timing is inconsistent with the explicit delivery contract",
      operands.timing.unit,
      frame,
    );
  const delivered = permission === true && boundary.isActive() === true;
  if (delivered) boundary.deliver(value, timing);
  return Object.freeze({ delivered, value, timing });
}

export interface ReactionScopeConfiguration {
  readonly parameters: ValueRecord;
  readonly initialState: ValueRecord;
  readonly bindings?: ValueRecord;
  readonly clock: NonNullable<FrameInput["clock"]>;
  readonly executionId: string;
  readonly operatorId: string;
  readonly subscriptionId: string;
  readonly parentId?: string;
  readonly connectionId?: string;
  readonly isActive: () => boolean;
}
export interface ReactionAccess {
  readonly frame: (
    phase?: "reaction" | "transition",
    action?: string,
  ) => EvaluationFrame;
  readonly capture: (
    group: CompiledGroup,
    capability?: { readonly nextTimerId: () => unknown },
  ) => ValueRecord;
  readonly transition: (group: CompiledGroup) => ValueRecord;
  /** The caller still applies canonical selection/priority rules. */
  readonly guards: (
    expressions: readonly CompiledExpression[],
  ) => readonly boolean[];
}

/** Integration utility, instantiated by the host for a declared operator owner after subscription. */
export function createReactionScope(configuration: ReactionScopeConfiguration) {
  const config = Object.freeze({
    ...configuration,
    parameters: snapshot(configuration.parameters),
    bindings: snapshot(configuration.bindings ?? {}),
  });
  let state = snapshot(config.initialState);
  return Object.freeze({
    state: () => state,
    run: <T>(
      notification: ValueRecord,
      reaction: string,
      execute: (access: ReactionAccess) => T,
    ): T => {
      // These bindings belong to this invocation; nested run calls cannot overwrite them.
      const event = snapshot(notification);
      let local: ValueRecord = snapshot({});
      let running = true;
      const frame = (
        phase: "reaction" | "transition" = "reaction",
        action?: string,
      ): EvaluationFrame => {
        if (!running)
          throw evaluationFailure(
            "RSL_EXPR_CONTEXT",
            "Reaction access is no longer active",
          );
        return createEvaluationFrame({
          phase,
          parameters: config.parameters,
          bindings: config.bindings,
          state,
          local,
          notification: event,
          clock: config.clock,
          executionId: config.executionId,
          operatorId: config.operatorId,
          subscription: {
            id: config.subscriptionId,
            closed: !config.isActive(),
            ...(config.parentId ? { parentId: config.parentId } : {}),
          },
          connectionId: config.connectionId,
          reaction,
          action,
        });
      };
      const access: ReactionAccess = Object.freeze({
        frame,
        capture: (
          group: CompiledGroup,
          capability?: { readonly nextTimerId: () => unknown },
        ) => {
          local = group.apply(frame("reaction", "capture"), capability);
          return local;
        },
        transition: (group: CompiledGroup) => {
          state = group.apply(frame("transition", "transition"));
          return state;
        },
        guards: (expressions: readonly CompiledExpression[]) => {
          const selection = frame("reaction", "selection");
          return Object.freeze(
            expressions.map((expression) => {
              if (expression.unit.slot !== "guard")
                throw evaluationFailure(
                  "RSL_EXPR_CONTEXT",
                  "Selection requires guard expressions",
                  expression.unit,
                  selection,
                );
              return expression.evaluate(selection) as boolean;
            }),
          );
        },
      });
      try {
        const result = execute(access);
        if (isThenable(result))
          throw evaluationFailure(
            "RSL_EXPR_ASYNC",
            "Reaction integration callback must finish synchronously",
          );
        return result;
      } finally {
        running = false;
      }
    },
  });
}
