import type { ReadResponse } from "../../shared/bedrockMessages";
import {
  answerFieldText,
  buildBedrockRequestBody,
  fieldFitRank,
  fieldOverage,
  interpretModelOutput,
  mergeRevision,
  repairAnalysis,
  validateAnalysis,
  type AnalysisIssue,
  type AnalysisValidationResult,
  type BedrockBillAnalysis,
  type FieldRepair,
  type MinimalBillInput,
  type SummarizerRequestBody,
  type SummarizerRequestOptions,
} from "./prompts";

/**
 * One bill's way from model answers to a summary within the display contract (LLM-11, REL-40). The Bedrock
 * call is injected, so scripts/evalSummaries.ts can run the same steps as the handler.
 *
 * 1. The first answer, or the bill's analysis from a multi-bill call. Valid: ready.
 * 2. A field over its limit, missing or empty: one corrective call, while time allows, that replays the answer
 *    and names each issue. Each named field comes from the answer whose text needs the lighter fit (none, whole
 *    sentences dropped, or a cut mid-sentence), and on a tie from the one less over its limits.
 * 3. A field still over its limit is fitted (fitText) and the fit is logged with the original text. A field
 *    still missing fails the bill.
 * A refused first call is retried once on shortened text (extractReducedBillInfo); a second refusal is final.
 * Nothing from a refused answer is used. An answer cut off or not parseable, or a call that got no answer,
 * fails the bill, so its records fail and SQS redelivers them.
 */

/** The bedrock_call `kind` of a single-bill summarizer call. */
export type SummarizerCallKind = "first" | "corrective" | "refusal_retry";

type LogLevel = "info" | "warn" | "error";

export interface AnalyzeBillDeps {
  /** Resolves with every answer, refusals and max_tokens included; rejects when no answer came back. */
  invoke: (kind: SummarizerCallKind, body: SummarizerRequestBody) => Promise<ReadResponse>;
  request: SummarizerRequestOptions;
  remainingMs: () => number;
  /** No corrective call or refusal retry starts with less than this left (the invoke's own minimum). */
  minRemainingMs: number;
  log: (level: LogLevel, event: string, fields: Record<string, unknown>) => void;
}

export interface AnalyzeBillOptions {
  /** The bill's analysis from a multi-bill call; no first call is made. */
  firstCandidate?: unknown;
  /** The input for the retry after a refusal (extractReducedBillInfo). */
  reducedInput: () => MinimalBillInput;
}

/**
 * What one answer came to: valid; issues (failed validation); refusal; no_analysis (cut off, not parseable,
 * or without this bill); error (no answer).
 */
export interface AnalysisAttempt {
  kind: SummarizerCallKind;
  outcome: "valid" | "issues" | "refusal" | "no_analysis" | "error";
  issues?: AnalysisIssue[];
  refusalCategory?: string | null;
}

interface AnalysisTrace {
  /** Bedrock calls made here (a multi-bill call is not counted). */
  calls: number;
  attempts: AnalysisAttempt[];
}

export type AnalyzeBillResult = AnalysisTrace &
  (
    | {
        kind: "ready";
        analysis: BedrockBillAnalysis;
        repairs: FieldRepair[];
        /** True when a field of the corrective answer is stored. */
        revised: boolean;
        /** True when the analysis comes from the retry on shortened text. */
        reducedInput: boolean;
      }
    | { kind: "refused"; category: string | null }
    | { kind: "failed"; error: Error }
  );

type Answer =
  | { kind: "candidate"; candidate: unknown }
  | { kind: "refusal"; category: string | null }
  | { kind: "none"; error: Error; reason: string };

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const issueFields = (issues: readonly AnalysisIssue[]): string[] => [...new Set(issues.map((issue) => issue.field))];

// analysis_rejected carries each field's text, capped so one line stays small.
const MAX_LOGGED_TEXT_CHARS = 1_000;

const loggedIssues = (issues: readonly AnalysisIssue[]) =>
  issues.map(({ text, ...issue }) =>
    text === undefined ? issue : { ...issue, text: text.slice(0, MAX_LOGGED_TEXT_CHARS) },
  );

export const analyzeBill = async (
  input: MinimalBillInput,
  deps: AnalyzeBillDeps,
  options: AnalyzeBillOptions,
): Promise<AnalyzeBillResult> => {
  const { guid } = input;
  const trace: AnalysisTrace = { calls: 0, attempts: [] };
  const hasTime = (): boolean => deps.remainingMs() >= deps.minRemainingMs;
  const failed = (error: Error): AnalyzeBillResult => ({ kind: "failed", error, ...trace });

  /** One call for this bill and the analysis in its answer, or why there is none. */
  const ask = async (kind: SummarizerCallKind, body: SummarizerRequestBody): Promise<Answer> => {
    trace.calls += 1;
    let read: ReadResponse;
    try {
      read = await deps.invoke(kind, body);
    } catch (error) {
      trace.attempts.push({ kind, outcome: "error" });
      return { kind: "none", error: toError(error), reason: "error" };
    }
    if (read.outcome === "refusal") {
      trace.attempts.push({ kind, outcome: "refusal", refusalCategory: read.refusalCategory });
      return { kind: "refusal", category: read.refusalCategory };
    }
    const output = interpretModelOutput(read.text, read.stopReason, [guid]);
    const candidate = output.analyses.get(guid);
    if (!output.complete || output.unmatchedGuids.length > 0 || candidate === undefined) {
      deps.log("warn", "bedrock_output_problem", {
        kind,
        stop_reason: read.stopReason,
        parsed: output.parsed,
        analysisFound: candidate !== undefined,
        unmatchedGuids: output.unmatchedGuids,
        ...(output.parsed ? {} : { preview: read.text.slice(0, 300) }),
      });
    }
    if (candidate === undefined) {
      trace.attempts.push({ kind, outcome: "no_analysis" });
      const error = output.complete
        ? new Error(`Analysis for ${guid} missing from model response`)
        : new Error(`Model response incomplete for ${guid} (stop_reason=${read.stopReason ?? "unknown"})`);
      return { kind: "none", error, reason: read.outcome === "ok" ? "no_analysis" : read.outcome };
    }
    return { kind: "candidate", candidate };
  };

  /** Validates an answer and records it; a rejection is logged with each issue's text. */
  const judge = (kind: SummarizerCallKind, candidate: unknown, correctiveFollows: boolean) => {
    const validation = validateAnalysis(candidate);
    if (validation.ok) {
      trace.attempts.push({ kind, outcome: "valid" });
      return validation;
    }
    trace.attempts.push({ kind, outcome: "issues", issues: validation.issues });
    deps.log("warn", "analysis_rejected", {
      attempt: kind,
      errors: validation.errors,
      issues: loggedIssues(validation.issues),
      correctiveRetry: correctiveFollows,
    });
    return validation;
  };

  const ready = (
    analysis: BedrockBillAnalysis,
    details: { repairs?: FieldRepair[]; revised?: boolean; reducedInput?: boolean } = {},
  ): AnalyzeBillResult => ({
    kind: "ready",
    analysis,
    repairs: details.repairs ?? [],
    revised: details.revised ?? false,
    reducedInput: details.reducedInput ?? false,
    ...trace,
  });

  /**
   * Fits a rejected answer that has only soft issues; one with a hard issue fails the bill. `attemptUsed` (the
   * last answer that supplied fields) and `correctiveFailure` go on the analysis_repaired line, and each repair
   * names the answer that wrote its field (`from`): after a corrective call, a field kept from the first answer
   * (`keptFromFirst`, not in `fromRevision`) is "first".
   */
  const fit = (
    validation: Extract<AnalysisValidationResult, { ok: false }>,
    attemptUsed: SummarizerCallKind,
    details: {
      revised?: boolean;
      reducedInput?: boolean;
      correctiveFailure?: string;
      fromRevision?: readonly string[];
    } = {},
  ): AnalyzeBillResult => {
    const repaired = validation.normalized ? repairAnalysis(validation.normalized, validation.issues) : null;
    if (!repaired) return failed(new Error(`Invalid analysis for ${guid}: ${validation.errors.join("; ")}`));
    const loggedRepairs = repaired.repairs.map((repair) => ({
      ...repair,
      from: details.fromRevision && !details.fromRevision.includes(repair.field) ? "first" : attemptUsed,
    }));
    const recheck = validateAnalysis(repaired.analysis);
    if (!recheck.ok) {
      // fitText keeps every field within its limit, so this is a bug, not a model problem.
      deps.log("error", "analysis_repair_failed", { attemptUsed, errors: recheck.errors, repairs: loggedRepairs });
      return failed(new Error(`Fitted analysis for ${guid} is still invalid: ${recheck.errors.join("; ")}`));
    }
    deps.log("warn", "analysis_repaired", {
      attemptUsed,
      ...(details.correctiveFailure ? { correctiveFailure: details.correctiveFailure } : {}),
      repairs: loggedRepairs,
    });
    return ready(recheck.analysis, {
      repairs: repaired.repairs,
      revised: details.revised,
      reducedInput: details.reducedInput,
    });
  };

  /** After a refused first call: one retry on shortened text, without a corrective call. */
  const retryAfterRefusal = async (category: string | null): Promise<AnalyzeBillResult> => {
    if (!hasTime()) {
      deps.log("warn", "summary_refused", { attempt: "first", category, next: "record_fails" });
      return failed(new Error(`Bedrock refused to summarize ${guid} (${category ?? "no category"}), no time to retry`));
    }
    deps.log("warn", "summary_refused", { attempt: "first", category, next: "refusal_retry" });
    const reduced = options.reducedInput();
    const answer = await ask("refusal_retry", buildBedrockRequestBody([reduced], deps.request));
    if (answer.kind === "refusal") {
      deps.log("warn", "summary_refused", {
        attempt: "refusal_retry",
        category: answer.category,
        firstCategory: category,
        next: "acknowledged",
      });
      return { kind: "refused", category: answer.category ?? category, ...trace };
    }
    if (answer.kind === "none") return failed(answer.error);

    const validation = judge("refusal_retry", answer.candidate, false);
    const result = validation.ok
      ? ready(validation.analysis, { reducedInput: true })
      : fit(validation, "refusal_retry", { reducedInput: true });
    if (result.kind === "ready") {
      deps.log("warn", "summary_from_reduced_input", {
        firstCategory: category,
        textChars: reduced.textSnippet.length,
      });
    }
    return result;
  };

  let first = options.firstCandidate;
  if (first === undefined) {
    const answer = await ask("first", buildBedrockRequestBody([input], deps.request));
    if (answer.kind === "refusal") return retryAfterRefusal(answer.category);
    if (answer.kind === "none") return failed(answer.error);
    first = answer.candidate;
  }

  const correctiveAllowed = hasTime();
  const firstCheck = judge("first", first, correctiveAllowed);
  if (firstCheck.ok) return ready(firstCheck.analysis);
  if (!correctiveAllowed) return fit(firstCheck, "first", { correctiveFailure: "no_time" });

  const answer = await ask(
    "corrective",
    buildBedrockRequestBody([input], deps.request, { previous: first, issues: firstCheck.issues }),
  );
  if (answer.kind !== "candidate") {
    return fit(firstCheck, "first", { correctiveFailure: answer.kind === "refusal" ? "refusal" : answer.reason });
  }
  const revision = answer.candidate;
  judge("corrective", revision, false);

  // Per field the first answer broke, the corrective answer's text unless it would be stored worse (fieldFitRank):
  // empty, or cut mid-sentence where the first answer fits by whole sentences, or, fitted the same way, further
  // over the limits (a tie goes to the corrective answer, which saw the issues).
  const prefersRevision = (field: string): boolean => {
    const firstText = answerFieldText(first, field);
    const revisionText = answerFieldText(revision, field);
    const byFit = fieldFitRank(field, revisionText) - fieldFitRank(field, firstText);
    return byFit !== 0 ? byFit < 0 : fieldOverage(field, revisionText) <= fieldOverage(field, firstText);
  };
  const fields = issueFields(firstCheck.issues);
  const fromRevision = fields.filter(prefersRevision);
  const revised = fromRevision.length > 0;
  if (revised) {
    deps.log("info", "analysis_revised", {
      fields: fromRevision,
      keptFromFirst: fields.filter((field) => !fromRevision.includes(field)),
    });
  }
  const merged = validateAnalysis(mergeRevision(first, revision, fromRevision));
  if (merged.ok) return ready(merged.analysis, { revised });
  return fit(merged, revised ? "corrective" : "first", { revised, fromRevision });
};
