import { analyzeBill, type AnalyzeBillDeps, type SummarizerCallKind } from "../handlers/billSummarizer/analyzeBill";
import {
  getCorrectionPrompt,
  getUserPrompt,
  validateAnalysis,
  type AnalysisIssue,
  type MinimalBillInput,
  type SummarizerRequestBody,
} from "../handlers/billSummarizer/prompts";
import { BedrockCallError, readMessagesResponse, type ReadResponse } from "../shared/bedrockMessages";

const GUID = "BILLS-119hr1ih";

const input: MinimalBillInput = {
  guid: GUID,
  title: "Rural Broadband Act",
  officialTitle: "To expand rural broadband.",
  textSnippet: "Sec. 1. Short title\nThis Act may be cited as the Rural Broadband Act.",
  textComplete: true,
  hasText: true,
};
const reduced: MinimalBillInput = { ...input, textSnippet: "Sec. 1. Short title", textComplete: false };

const analysis = (overrides: Record<string, unknown> = {}) => ({
  guid: GUID,
  title: "Funds grants for rural broadband",
  billBreakdown: {
    who: "Rural internet providers.",
    what: "Creates a grant program.",
    how: "The Secretary gives grants.",
    when: "The provided text does not say.",
    where: "Rural areas.",
    why: "The bill states its purpose is rural broadband.",
  },
  soWhat: "Rural homes could get faster internet.",
  subCategories: ["Telecommunications"],
  lifeAreas: ["Digital Services"],
  civicProfile: { localVsFederal: 0.5 },
  ...overrides,
});

const withHow = (how: string, overrides: Record<string, unknown> = {}) =>
  analysis({ billBreakdown: { ...analysis().billBreakdown, how }, ...overrides });

/** A breakdown sentence of exactly `chars` characters. */
const sentenceOf = (chars: number): string =>
  `${`The bill ${"funds grants ".repeat(60)}`.slice(0, chars - 1).replace(/ $/, "s")}.`;

const answer = (candidate: unknown, stopReason = "end_turn"): ReadResponse =>
  readMessagesResponse({
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: JSON.stringify({ bills: [candidate] }) },
    ],
    stop_reason: stopReason,
  });

const refusal = (category: string | null): ReadResponse =>
  readMessagesResponse({
    content: [{ type: "text", text: JSON.stringify({ bills: [analysis()] }) }],
    stop_reason: "refusal",
    stop_details: { type: "refusal", category },
  });

const setup = (
  replies: Array<ReadResponse | Error | (() => ReadResponse)>,
  options: { remainingMs?: () => number } = {},
) => {
  const calls: Array<{ kind: SummarizerCallKind; body: SummarizerRequestBody }> = [];
  const log = jest.fn();
  const deps: AnalyzeBillDeps = {
    invoke: async (kind, body) => {
      calls.push({ kind, body });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("unexpected call");
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply() : reply;
    },
    request: { profile: "haiku-5-5", effort: "medium", maxTokens: 8192 },
    remainingMs: options.remainingMs ?? (() => 100_000),
    minRemainingMs: 20_000,
    log,
  };
  const logged = (event: string) => log.mock.calls.filter((call) => call[1] === event).map((call) => call[2]);
  return { deps, calls, log, logged };
};

const issuesOf = (candidate: unknown): AnalysisIssue[] => {
  const result = validateAnalysis(candidate);
  return result.ok ? [] : result.issues;
};

describe("billSummarizer analyzeBill", () => {
  it("returns a valid first answer as it is, after one call", async () => {
    const { deps, calls, log } = setup([answer(analysis())]);

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result).toMatchObject({
      kind: "ready",
      analysis: { guid: GUID, soWhat: "Rural homes could get faster internet." },
      repairs: [],
      revised: false,
      reducedInput: false,
      calls: 1,
      attempts: [{ kind: "first", outcome: "valid" }],
    });
    expect(calls.map((call) => call.kind)).toEqual(["first"]);
    expect(calls[0].body).toMatchObject({ max_tokens: 8192, output_config: { effort: "medium" } });
    expect(calls[0].body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: getUserPrompt([input]) }] },
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it("stores the corrective answer's fields when the first answer breaks a limit", async () => {
    const first = analysis({ soWhat: "Taxes rise. Prices fall. Jobs move." });
    const { deps, calls, logged } = setup([
      answer(first),
      answer(analysis({ soWhat: "Taxes rise and prices fall.", title: "A different headline" })),
    ]);

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result).toMatchObject({ kind: "ready", revised: true, repairs: [], calls: 2 });
    if (result.kind !== "ready") return;
    expect(result.analysis.soWhat).toBe("Taxes rise and prices fall.");
    // Fields the first answer did not break keep its value.
    expect(result.analysis.title).toBe("Funds grants for rural broadband");
    expect(calls[1]).toMatchObject({ kind: "corrective" });
    expect(calls[1].body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: getUserPrompt([input]) }] },
      { role: "assistant", content: [{ type: "text", text: JSON.stringify({ bills: [first] }) }] },
      { role: "user", content: [{ type: "text", text: getCorrectionPrompt(issuesOf(first)) }] },
    ]);
    expect(logged("analysis_rejected")).toEqual([
      {
        attempt: "first",
        errors: ["soWhat has 3 sentences (max 2)"],
        issues: [
          {
            field: "soWhat",
            kind: "soft",
            rule: "max_sentences",
            chars: 35,
            sentences: 3,
            limit: 2,
            target: 240,
            text: "Taxes rise. Prices fall. Jobs move.",
          },
        ],
        correctiveRetry: true,
      },
    ]);
    expect(logged("analysis_revised")).toEqual([{ fields: ["soWhat"], keptFromFirst: [] }]);
    expect(logged("analysis_repaired")).toEqual([]);
  });

  it("keeps whichever answer is less over each field's limit, then fits what is still over", async () => {
    const firstHow = `${sentenceOf(300)} ${sentenceOf(150)}`;
    const first = withHow(firstHow, { soWhat: "Taxes rise. Prices fall. Jobs move." });
    // The corrective answer fixes soWhat but makes `how` longer.
    const revision = withHow(`${sentenceOf(300)} ${sentenceOf(300)}`, { soWhat: "Taxes rise." });
    const { deps, logged } = setup([answer(first), answer(revision)]);

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result).toMatchObject({
      kind: "ready",
      revised: true,
      analysis: { soWhat: "Taxes rise.", billBreakdown: { how: sentenceOf(300) } },
      repairs: [
        { field: "billBreakdown.how", method: "sentences", beforeChars: 451, afterChars: 300, original: firstHow },
      ],
    });
    expect(logged("analysis_rejected").map((line) => line.attempt)).toEqual(["first", "corrective"]);
    expect(logged("analysis_revised")).toEqual([{ fields: ["soWhat"], keptFromFirst: ["billBreakdown.how"] }]);
    // The fitted `how` is the first answer's text.
    expect(logged("analysis_repaired")).toEqual([
      {
        attemptUsed: "corrective",
        repairs: [expect.objectContaining({ field: "billBreakdown.how", from: "first", original: firstHow })],
      },
    ]);
  });

  it("keeps the first answer's text when it fits by whole sentences and the corrective answer would be cut", async () => {
    // The corrective answer is less over the limit, but only as one sentence that must be cut mid-way.
    const first = withHow(`${sentenceOf(200)} ${sentenceOf(209)}`);
    const { deps, logged } = setup([answer(first), answer(withHow(sentenceOf(405)))]);

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result).toMatchObject({
      kind: "ready",
      revised: false,
      analysis: { billBreakdown: { how: sentenceOf(200) } },
      repairs: [{ field: "billBreakdown.how", method: "sentences" }],
    });
    expect(logged("analysis_revised")).toEqual([]);
    expect(logged("analysis_repaired")).toEqual([
      { attemptUsed: "first", repairs: [expect.objectContaining({ field: "billBreakdown.how", from: "first" })] },
    ]);
  });

  it("keeps a soWhat that fits by whole sentences over a single long sentence", async () => {
    const first = analysis({ soWhat: "Taxes rise. Prices fall. Jobs change." });
    const { deps } = setup([answer(first), answer(analysis({ soWhat: sentenceOf(290) }))]);

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result).toMatchObject({
      kind: "ready",
      analysis: { soWhat: "Taxes rise. Prices fall." },
      repairs: [{ field: "soWhat", method: "sentences" }],
    });
  });

  it("keeps a first answer that must be cut mid-sentence when the corrective answer empties the field", async () => {
    const { deps } = setup([answer(withHow(sentenceOf(450))), answer(withHow(""))]);

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result).toMatchObject({ kind: "ready", revised: false, repairs: [{ method: "words" }] });
    if (result.kind !== "ready") return;
    expect(result.analysis.billBreakdown.how).toMatch(/…$/);
    expect(sentenceOf(450).startsWith(result.analysis.billBreakdown.how.slice(0, -1))).toBe(true);
  });

  it("keeps the first answer's text when the corrective answer empties the field", async () => {
    const first = withHow(`${sentenceOf(300)} ${sentenceOf(200)}`);
    const { deps } = setup([answer(first), answer(withHow(""))]);

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result).toMatchObject({
      kind: "ready",
      revised: false,
      analysis: { billBreakdown: { how: sentenceOf(300) } },
    });
  });

  it("fits the first answer without a corrective call when too little time is left", async () => {
    const { deps, calls, logged } = setup([answer(analysis({ soWhat: "Taxes rise. Prices fall. Jobs move." }))], {
      remainingMs: () => 19_999,
    });

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result).toMatchObject({ kind: "ready", revised: false, analysis: { soWhat: "Taxes rise. Prices fall." } });
    expect(calls).toHaveLength(1);
    expect(logged("analysis_rejected")[0]).toMatchObject({ correctiveRetry: false });
    expect(logged("analysis_repaired")[0]).toMatchObject({ attemptUsed: "first", correctiveFailure: "no_time" });
  });

  it.each([
    [
      "error",
      () =>
        new BedrockCallError("Bedrock call failed", {
          kind: "transient",
          errorName: null,
          httpStatus: 500,
          attempt: 2,
          latencyMs: 5,
        }),
    ],
    ["refusal", () => refusal("cyber")],
    [
      "max_tokens",
      () => readMessagesResponse({ content: [{ type: "thinking", thinking: "" }], stop_reason: "max_tokens" }),
    ],
    [
      "no_analysis",
      () => readMessagesResponse({ content: [{ type: "text", text: "Sorry." }], stop_reason: "end_turn" }),
    ],
  ])("fits the first answer when the corrective call ends in %s", async (failure, reply) => {
    const { deps, logged } = setup([answer(analysis({ soWhat: "Taxes rise. Prices fall. Jobs move." })), reply()]);

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result).toMatchObject({ kind: "ready", calls: 2, analysis: { soWhat: "Taxes rise. Prices fall." } });
    expect(logged("analysis_repaired")[0]).toMatchObject({ attemptUsed: "first", correctiveFailure: failure });
  });

  it("fails when a field is still missing after the corrective call", async () => {
    const { deps } = setup([answer(analysis({ title: "" })), answer(analysis({ title: " " }))]);

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result).toMatchObject({
      kind: "failed",
      calls: 2,
      attempts: [
        { kind: "first", outcome: "issues" },
        { kind: "corrective", outcome: "issues" },
      ],
    });
    if (result.kind === "failed")
      expect(result.error.message).toBe(`Invalid analysis for ${GUID}: title is missing or empty`);
  });

  it("fails a missing field without a corrective call when too little time is left", async () => {
    const { deps, calls } = setup([answer(analysis({ title: "" }))], { remainingMs: () => 1_000 });

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result.kind).toBe("failed");
    expect(calls).toHaveLength(1);
  });

  it("stores a missing field the corrective call supplies", async () => {
    const { deps } = setup([answer(analysis({ title: "" })), answer(analysis({ title: "Funds rural broadband" }))]);

    const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

    expect(result).toMatchObject({ kind: "ready", revised: true, analysis: { title: "Funds rural broadband" } });
  });

  it("starts from an analysis a multi-bill call returned, replaying it alone in the corrective call", async () => {
    const candidate = analysis({ soWhat: "Taxes rise. Prices fall. Jobs move." });
    const { deps, calls } = setup([answer(analysis({ soWhat: "Taxes rise." }))]);

    const result = await analyzeBill(input, deps, { firstCandidate: candidate, reducedInput: () => reduced });

    expect(result).toMatchObject({ kind: "ready", calls: 1, revised: true, analysis: { soWhat: "Taxes rise." } });
    expect(calls.map((call) => call.kind)).toEqual(["corrective"]);
    expect(calls[0].body.messages[1].content[0].text).toBe(JSON.stringify({ bills: [candidate] }));
  });

  describe("refusals", () => {
    it("retries a refused bill once on shortened text and stores that answer", async () => {
      const { deps, calls, logged } = setup([refusal("cyber"), answer(analysis())]);

      const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

      expect(result).toMatchObject({ kind: "ready", reducedInput: true, calls: 2 });
      expect(calls.map((call) => call.kind)).toEqual(["first", "refusal_retry"]);
      expect(calls[1].body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: getUserPrompt([reduced]) }] },
      ]);
      expect(logged("summary_refused")).toEqual([{ attempt: "first", category: "cyber", next: "refusal_retry" }]);
      expect(logged("summary_from_reduced_input")).toEqual([{ firstCategory: "cyber", textChars: 19 }]);
    });

    it("fits the retry's answer instead of making a corrective call", async () => {
      const { deps, calls } = setup([
        refusal("bio"),
        answer(analysis({ soWhat: "Taxes rise. Prices fall. Jobs move." })),
      ]);

      const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

      expect(result).toMatchObject({
        kind: "ready",
        reducedInput: true,
        analysis: { soWhat: "Taxes rise. Prices fall." },
      });
      expect(calls).toHaveLength(2);
    });

    it("gives up on a bill refused twice, without using either answer", async () => {
      const { deps, logged } = setup([refusal("cyber"), refusal(null)]);

      const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

      expect(result).toMatchObject({
        kind: "refused",
        category: "cyber",
        calls: 2,
        attempts: [
          { kind: "first", outcome: "refusal", refusalCategory: "cyber" },
          { kind: "refusal_retry", outcome: "refusal", refusalCategory: null },
        ],
      });
      expect(logged("summary_refused")[1]).toEqual({
        attempt: "refusal_retry",
        category: null,
        firstCategory: "cyber",
        next: "acknowledged",
      });
    });

    it("fails the bill when no time is left for the retry", async () => {
      let remaining = 100_000;
      const refusedLate = () => {
        remaining = 10_000;
        return refusal("frontier_llm");
      };
      const { deps, calls, logged } = setup([refusedLate], { remainingMs: () => remaining });

      const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

      expect(result.kind).toBe("failed");
      expect(calls).toHaveLength(1);
      expect(logged("summary_refused")).toEqual([{ attempt: "first", category: "frontier_llm", next: "record_fails" }]);
    });

    it("fails the bill when the retry gets no usable answer", async () => {
      const { deps } = setup([refusal("cyber"), new Error("socket hang up")]);

      const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.error.message).toBe("socket hang up");
    });
  });

  describe("answers without a usable analysis", () => {
    it("fails a first answer cut off at max_tokens, thinking only", async () => {
      const { deps, logged } = setup([
        readMessagesResponse({ content: [{ type: "thinking", thinking: "..." }], stop_reason: "max_tokens" }),
      ]);

      const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

      expect(result).toMatchObject({ kind: "failed", calls: 1, attempts: [{ kind: "first", outcome: "no_analysis" }] });
      if (result.kind === "failed") {
        expect(result.error.message).toBe(`Model response incomplete for ${GUID} (stop_reason=max_tokens)`);
      }
      expect(logged("bedrock_output_problem")).toEqual([
        {
          kind: "first",
          stop_reason: "max_tokens",
          parsed: false,
          analysisFound: false,
          unmatchedGuids: [],
          preview: "",
        },
      ]);
    });

    it("fails a first answer that does not parse, or names another bill", async () => {
      for (const reply of [
        readMessagesResponse({ content: [{ type: "text", text: "I cannot do that." }], stop_reason: "end_turn" }),
        answer(analysis({ guid: "BILLS-119hr2ih" })),
      ]) {
        const { deps } = setup([reply]);
        expect((await analyzeBill(input, deps, { reducedInput: () => reduced })).kind).toBe("failed");
      }
    });

    it("fails with the call's error when the first call gets no answer", async () => {
      const error = new BedrockCallError("Bedrock call failed (invalid_request, ValidationException 400)", {
        kind: "invalid_request",
        errorName: "ValidationException",
        httpStatus: 400,
        attempt: 0,
        latencyMs: 12,
      });
      const { deps } = setup([error]);

      const result = await analyzeBill(input, deps, { reducedInput: () => reduced });

      expect(result).toMatchObject({ kind: "failed", calls: 1, attempts: [{ kind: "first", outcome: "error" }] });
      if (result.kind === "failed") expect(result.error).toBe(error);
    });
  });
});
