import { applyTestEnv } from "./fixtures/env";
import { FakeVersionedS3, type FakeS3Input } from "./fakeVersionedS3";
import { logLines } from "./logLines";
import type { SQSBatchResponse } from "aws-lambda";
import type { ProcessedBillDocument, RawBill } from "../models/bill";
import { SOURCE_METADATA_KEYS, sourceTextHash } from "../shared/billSourceReconcile";

const originalEnv = { ...process.env };
const mockS3Send = jest.fn();
const mockBedrockSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ kind: "get", input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ kind: "put", input })),
  ListObjectVersionsCommand: jest.fn().mockImplementation((input) => ({ kind: "list", input })),
}));

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

type Analysis = Record<string, unknown>;

const billXml = (guid: string) =>
  `<?xml version="1.0"?><bill><metadata><dublinCore><dc:title>${guid}</dc:title></dublinCore></metadata><form><legis-type>A BILL</legis-type><official-title>To support rural broadband (${guid}).</official-title></form><legis-body><section><enum>1.</enum><header>Short title</header><text>This Act may be cited as the Test Act for ${guid}.</text></section><section><enum>2.</enum><header>Grants</header><text>The Secretary shall award grants to rural providers.</text></section></legis-body></bill>`;

/** What the mocked S3 command constructors return: the kind of command and its input. */
interface FakeS3Call {
  kind: "get" | "put" | "list";
  input: FakeS3Input;
}

const rawBill = (guid: string, options: { text?: boolean } = {}): RawBill => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2026-09-01T00:00:00Z",
  identifier: { congress: "119", billType: "hr", billNumber: guid.replace(/\D+/g, "").slice(3) || "1" },
  metadata: {
    guid,
    title: `Test Act ${guid}`,
    pubDate: "",
    legislationUrl: `https://www.congress.gov/bill/119th-congress/house-bill/${guid}`,
    fetchedAt: "",
  },
  content: {
    ...(options.text === false ? {} : { billXML: billXml(guid) }),
    bill: { bill: { sponsors: [{ bioguideId: "S000001" }] } },
    cosponsors: { cosponsors: [{ bioguideId: "C000001" }] },
    actions: { actions: [{ actionDate: "2026-08-01", text: "Introduced in House" }] },
    committees: { committees: [] },
  },
});

const analysis = (guid: string, overrides: Analysis = {}): Analysis => ({
  guid,
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
  civicProfile: { localVsFederal: 0.4 },
  ...overrides,
});

/** An InvokeModel response: the text as one text block, or the content blocks as given. */
const bedrockResponse = (
  content: string | Array<Record<string, unknown>>,
  stopReason = "end_turn",
  usage = { input_tokens: 1200, output_tokens: 300 },
  stopDetails: Record<string, unknown> | null = null,
) => ({
  body: new TextEncoder().encode(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "haiku",
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: stopDetails,
      usage,
    }),
  ),
});

const billsJson = (...analyses: Analysis[]) => JSON.stringify({ bills: analyses });

interface TestSqsRecord {
  messageId: string;
  body: string;
  messageAttributes?: { correlationId: { dataType: string; stringValue: string } };
}

const sqsEvent = (guids: string[]): { Records: TestSqsRecord[] } => ({
  Records: guids.map((guid, i) => ({ messageId: `msg-${i + 1}`, body: JSON.stringify({ guid }) })),
});

const normalizedKey = (guid: string) => guid.replace(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i, "$1");

/** In-memory bill store: raw bills by guid, captures processed-bill puts. */
const setupStore = (raws: Record<string, unknown>, options: { failGetFor?: string[]; failPutFor?: string[] } = {}) => {
  const stored: Record<string, ProcessedBillDocument> = {};
  mockS3Send.mockImplementation(async (command: FakeS3Call) => {
    const key: string = command.input?.Key ?? "";
    if (command.kind === "get") {
      const match = key.match(/^raw-bills\/(.+)\.json$/);
      const guid = Object.keys(raws).find((g) => match && normalizedKey(g) === match[1]);
      if (guid && options.failGetFor?.includes(guid)) {
        throw Object.assign(new Error("S3 internal error"), {
          name: "InternalError",
          $metadata: { httpStatusCode: 500 },
        });
      }
      if (!guid) throw Object.assign(new Error("not found"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => JSON.stringify(raws[guid]) } };
    }
    if (command.kind === "put") {
      const guid = Object.keys(raws).find((g) => key === `processed-bills/${normalizedKey(g)}.json`);
      if (guid && options.failPutFor?.includes(guid)) throw new Error("S3 put failed");
      stored[key] = JSON.parse(command.input?.Body as string) as ProcessedBillDocument;
      return {};
    }
    throw new Error(`Unexpected S3 command ${command.kind} ${key}`);
  });
  return stored;
};

const promptBills = (callIndex: number): Array<{ guid: string }> => {
  const body = JSON.parse(mockBedrockSend.mock.calls[callIndex][0].input.body);
  const text: string = body.messages[0].content[0].text;
  return JSON.parse(text.slice(text.indexOf("Bills: ") + "Bills: ".length));
};

const promptGuids = (callIndex: number): string[] => promptBills(callIndex).map((bill) => bill.guid);

const bedrockLogLines = (spy: jest.SpyInstance): Array<Record<string, unknown>> =>
  spy.mock.calls
    .map((call) => call[0])
    .filter((line) => typeof line === "string" && line.includes('"event":"bedrock_call"'))
    .map((line) => JSON.parse(line));

const failedIds = (response: { batchItemFailures: Array<{ itemIdentifier: string }> }) =>
  response.batchItemFailures.map((failure) => failure.itemIdentifier);

/** The values of an EMF metric written through console.log, in order. */
const metricValues = (spy: jest.SpyInstance, name: string): number[] =>
  logLines(spy)
    .filter((line) => line._aws && name in line)
    .map((line) => line[name] as number);

const HAIKU_4_5 =
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_5_5 = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-5-5";

describe("billSummarizer handler", () => {
  let restoreEnv: (() => void) | undefined;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const loadHandler = () => {
    return require("../handlers/billSummarizer").handler as (
      event: unknown,
      context?: unknown,
    ) => Promise<SQSBatchResponse>;
  };

  beforeEach(() => {
    jest.resetModules();
    mockS3Send.mockReset();
    mockBedrockSend.mockReset();
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "bill-store",
        MODEL_ID: HAIKU_4_5,
        MAX_BILLS_PER_BATCH: "5",
        MAX_OUTPUT_TOKENS: "4096",
        BEDROCK_MAX_RETRIES: "2",
        BEDROCK_BASE_DELAY_MS: "1",
        BEDROCK_MAX_DELAY_MS: "2",
      },
      { replace: true, base: originalEnv },
    );
    logSpy = jest.spyOn(console, "log").mockImplementation();
    warnSpy = jest.spyOn(console, "warn").mockImplementation();
    errorSpy = jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    restoreEnv?.();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv as NodeJS.ProcessEnv;
  });

  it("stores every bill from a fenced JSON response and reports no failures", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih"];
    const stored = setupStore({ [guids[0]]: rawBill(guids[0]), [guids[1]]: rawBill(guids[1]) });
    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponse(
        "```json\n" + billsJson(analysis(guids[0]), analysis(guids[1], { lifeAreas: undefined })) + "\n```",
      ),
    );

    const response = await loadHandler()(sqsEvent(guids));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(Object.keys(stored).sort()).toEqual([
      "processed-bills/BILLS-119hr1.json",
      "processed-bills/BILLS-119hr2.json",
    ]);
    const doc = stored["processed-bills/BILLS-119hr1.json"];
    // Stored under the plain guid its key names, though the message (as a legacy DLQ message does) named BILLS-119hr1ih.
    expect(doc).toMatchObject({
      kind: "processed",
      guid: "BILLS-119hr1",
      title: "Funds grants for rural broadband",
      officialTitle: "To support rural broadband (BILLS-119hr1ih).",
      soWhat: "Rural homes could get faster internet.",
      subCategories: ["Telecommunications"],
      lifeAreas: ["Digital Services"],
      civicProfile: { localVsFederal: 0.5 },
      sponsors: ["S000001"],
      cosponsors: ["C000001"],
      link: "https://www.congress.gov/bill/119th-congress/house-bill/BILLS-119hr1ih/text",
    });
    expect(stored["processed-bills/BILLS-119hr2.json"].lifeAreas).toEqual([]);

    const request = JSON.parse(mockBedrockSend.mock.calls[0][0].input.body);
    // Haiku 4.5 keeps temperature 0 and gets no effort.
    expect(request.temperature).toBe(0);
    expect(request).not.toHaveProperty("output_config");
    expect(request.max_tokens).toBe(4096);
    expect(promptBills(0)[0]).toMatchObject({
      guid: "BILLS-119hr1ih",
      officialTitle: "To support rural broadband (BILLS-119hr1ih).",
      textComplete: true,
    });
    expect(promptBills(0)[0]).toHaveProperty("text", expect.stringContaining("Sec. 2. Grants"));
    expect(JSON.stringify(promptBills(0))).not.toContain("dublinCore");
  });

  it("logs one JSON line per Bedrock call with guids, stop reason, tokens and latency", async () => {
    const guid = "BILLS-119hr1ih";
    setupStore({ [guid]: rawBill(guid) });
    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponse(billsJson(analysis(guid)), "end_turn", { input_tokens: 1500, output_tokens: 420 }),
    );
    process.env.AWS_LAMBDA_FUNCTION_NAME = "BillSummarizer";

    await loadHandler()(sqsEvent([guid]));

    const lines = bedrockLogLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "bedrock_call",
      fn: "BillSummarizer",
      service: "billboard-services",
      caller: "BillSummarizer",
      modelId: HAIKU_4_5,
      requestProfile: "haiku-4-5",
      effort: null,
      max_tokens: 4096,
      kind: "first",
      attempt: 0,
      outcome: "ok",
      guids: [guid],
      correlationIds: [expect.stringMatching(/:BILLS-119hr1ih$/)],
      stop_reason: "end_turn",
      content_types: ["text"],
      thinking_blocks: 0,
      input_tokens: 1500,
      output_tokens: 420,
    });
    expect(typeof lines[0].latencyMs).toBe("number");
    expect(logLines(logSpy).find((line) => line.event === "summary_stored")).toMatchObject({
      guid,
      modelId: HAIKU_4_5,
      requestProfile: "haiku-4-5",
      effort: null,
      calls: 1,
      revised: false,
      repairedFields: [],
      civicAxes: 1,
      fields: { title: { chars: 32, sentences: 1 }, "billBreakdown.how": { chars: 27, sentences: 1 } },
    });
    expect(metricValues(logSpy, "BillSummarizerStored")).toEqual([1]);
    expect(metricValues(logSpy, "BillSummarizerRepairedBills")).toEqual([0]);
  });

  it("stores an answer that scores no civic axis without a civic profile and logs civicAxes 0 (REL-43)", async () => {
    const guid = "BILLS-119hres1061";
    const stored = setupStore({ [guid]: rawBill(guid) });
    mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guid, { civicProfile: {} }))));

    const response = await loadHandler()(sqsEvent([guid]));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(stored[`processed-bills/${guid}.json`]).not.toHaveProperty("civicProfile");
    expect(logLines(logSpy).find((line) => line.event === "summary_stored")).toMatchObject({ guid, civicAxes: 0 });
  });

  it("accepts JSON followed by trailing prose", async () => {
    const guid = "BILLS-119hr1ih";
    const stored = setupStore({ [guid]: rawBill(guid) });
    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponse(`${billsJson(analysis(guid))}\n\nI scored the axes using the rubric {as instructed}.`),
    );

    const response = await loadHandler()(sqsEvent([guid]));

    expect(failedIds(response)).toEqual([]);
    expect(Object.keys(stored)).toEqual(["processed-bills/BILLS-119hr1.json"]);
  });

  it("fails only the record whose analysis is missing from a complete response", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih", "BILLS-119hr3ih"];
    const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
    mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[0]), analysis(guids[2]))));

    const response = await loadHandler()(sqsEvent(guids));

    expect(failedIds(response)).toEqual(["msg-2"]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(Object.keys(stored).sort()).toEqual([
      "processed-bills/BILLS-119hr1.json",
      "processed-bills/BILLS-119hr3.json",
    ]);
  });

  it("treats an analysis with a mismatched guid as missing", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih"];
    const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
    mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[0]), analysis("BILLS-119hr999ih"))));

    const response = await loadHandler()(sqsEvent(guids));

    expect(failedIds(response)).toEqual(["msg-2"]);
    expect(Object.keys(stored)).toEqual(["processed-bills/BILLS-119hr1.json"]);
    const problem = warnSpy.mock.calls
      .map((c) => c[0])
      .find((line) => typeof line === "string" && line.includes("bedrock_output_problem"));
    expect(JSON.parse(problem)).toMatchObject({
      missingGuids: ["BILLS-119hr2ih"],
      unmatchedGuids: ["BILLS-119hr999ih"],
    });
  });

  it("on stop_reason max_tokens keeps completed bills and retries the rest one bill at a time", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih", "BILLS-119hr3ih"];
    const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
    const full = billsJson(analysis(guids[0]), analysis(guids[1]), analysis(guids[2]));
    const cut = full.slice(0, full.indexOf(guids[1]) + 40);
    mockBedrockSend
      .mockResolvedValueOnce(bedrockResponse("```json\n" + cut, "max_tokens"))
      .mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[1]))))
      .mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[2]))));

    const response = await loadHandler()(sqsEvent(guids));

    expect(failedIds(response)).toEqual([]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(3);
    expect(promptGuids(0)).toEqual(guids);
    expect(promptGuids(1)).toEqual([guids[1]]);
    expect(promptGuids(2)).toEqual([guids[2]]);
    expect(Object.keys(stored)).toHaveLength(3);
    expect(bedrockLogLines(warnSpy).map((line) => [line.kind, line.outcome])).toEqual([["batch", "max_tokens"]]);
    expect(bedrockLogLines(logSpy).map((line) => [line.kind, line.stop_reason])).toEqual([
      ["first", "end_turn"],
      ["first", "end_turn"],
    ]);
  });

  it("fails a bill after its single-bill retry is also cut off", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih"];
    const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
    const full = billsJson(analysis(guids[0]), analysis(guids[1]));
    mockBedrockSend
      .mockResolvedValueOnce(bedrockResponse(full.slice(0, full.indexOf(guids[1]) + 20), "max_tokens"))
      .mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[1])).slice(0, 80), "max_tokens"));

    const response = await loadHandler()(sqsEvent(guids));

    expect(failedIds(response)).toEqual(["msg-2"]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
    expect(Object.keys(stored)).toEqual(["processed-bills/BILLS-119hr1.json"]);
  });

  it("retries each bill alone when the batch response is not JSON at all", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih"];
    setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
    mockBedrockSend
      .mockResolvedValueOnce(bedrockResponse("I'm sorry, I can only analyze one bill at a time."))
      .mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[0]))))
      .mockResolvedValueOnce(bedrockResponse("still not JSON"));

    const response = await loadHandler()(sqsEvent(guids));

    expect(failedIds(response)).toEqual(["msg-2"]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(3);
  });

  it("skips bills with no text without calling Bedrock and without failing the record", async () => {
    const withText = "BILLS-119hr1ih";
    const noText = "BILLS-119hr2ih";
    const stored = setupStore({ [withText]: rawBill(withText), [noText]: rawBill(noText, { text: false }) });
    mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(withText))));

    const response = await loadHandler()(sqsEvent([withText, noText]));

    expect(failedIds(response)).toEqual([]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(promptGuids(0)).toEqual([withText]);
    expect(Object.keys(stored)).toEqual(["processed-bills/BILLS-119hr1.json"]);
    const skip = warnSpy.mock.calls
      .map((c) => c[0])
      .find((line) => typeof line === "string" && line.includes("bill_skipped"));
    expect(JSON.parse(skip)).toMatchObject({ reason: "no_bill_text", guid: noText });
  });

  it("does not call Bedrock when no bill in the batch has text", async () => {
    const guid = "BILLS-119hr2ih";
    setupStore({ [guid]: rawBill(guid, { text: false }) });

    const response = await loadHandler()(sqsEvent([guid]));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it("fits a field still over its limit after the corrective call, and fails only the bill still missing one", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih", "BILLS-119hr3ih"];
    const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
    mockBedrockSend
      .mockResolvedValueOnce(
        bedrockResponse(
          billsJson(
            analysis(guids[0], { subCategories: undefined, lifeAreas: undefined }),
            analysis(guids[1], { soWhat: "Taxes rise. Prices fall. Jobs move." }),
            analysis(guids[2], { title: "" }),
          ),
        ),
      )
      // The corrective calls break the same rules again.
      .mockResolvedValueOnce(
        bedrockResponse(billsJson(analysis(guids[1], { soWhat: "Taxes rise. Prices fall. Jobs move." }))),
      )
      .mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[2], { title: "" }))));

    const response = await loadHandler()(sqsEvent(guids));

    expect(failedIds(response)).toEqual(["msg-3"]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(3);
    expect(promptGuids(1)).toEqual([guids[1]]);
    expect(promptGuids(2)).toEqual([guids[2]]);
    expect(Object.keys(stored).sort()).toEqual([
      "processed-bills/BILLS-119hr1.json",
      "processed-bills/BILLS-119hr2.json",
    ]);
    expect(stored["processed-bills/BILLS-119hr1.json"]).toMatchObject({ subCategories: [], lifeAreas: [] });
    // The leading whole sentences, never a rewrite.
    expect(stored["processed-bills/BILLS-119hr2.json"].soWhat).toBe("Taxes rise. Prices fall.");

    const repaired = logLines(warnSpy).filter((line) => line.event === "analysis_repaired");
    expect(repaired).toEqual([
      expect.objectContaining({
        guid: guids[1],
        attemptUsed: "corrective",
        repairs: [
          // A tie goes to the corrective answer.
          expect.objectContaining({
            field: "soWhat",
            rules: ["max_sentences"],
            method: "sentences",
            from: "corrective",
            original: "Taxes rise. Prices fall. Jobs move.",
          }),
        ],
      }),
    ]);
    const rejected = logLines(warnSpy).filter((line) => line.event === "analysis_rejected");
    expect(rejected.map((line) => [line.guid, line.attempt])).toEqual([
      [guids[1], "first"],
      [guids[1], "corrective"],
      [guids[2], "first"],
      [guids[2], "corrective"],
    ]);
    expect(rejected[0].issues).toEqual([
      expect.objectContaining({
        field: "soWhat",
        rule: "max_sentences",
        sentences: 3,
        text: "Taxes rise. Prices fall. Jobs move.",
      }),
    ]);
    expect(metricValues(logSpy, "BillSummarizerAnalysisRejected")).toEqual([2, 2]);
    expect(metricValues(logSpy, "BillSummarizerStored")).toEqual([1, 1]);
    expect(metricValues(logSpy, "BillSummarizerRepairedBills")).toEqual([0, 1]);
    expect(metricValues(logSpy, "BillSummarizerFieldRepaired")).toEqual([0, 1]);
    expect(logLines(logSpy).find((line) => line.event === "summary_stored" && line.guid === guids[1])).toMatchObject({
      calls: 2,
      revised: true,
      repairedFields: ["soWhat"],
      fields: { soWhat: { chars: 24, sentences: 2 } },
    });
  });

  it("retries a bill that breaks a length rule once, alone, quoting the rule, and stores the corrected answer", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih"];
    const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
    mockBedrockSend
      .mockResolvedValueOnce(
        bedrockResponse(
          billsJson(analysis(guids[0]), analysis(guids[1], { soWhat: "Taxes rise. Prices fall. Jobs move." })),
        ),
      )
      .mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[1], { soWhat: "Taxes rise and prices fall." }))));

    const response = await loadHandler()(sqsEvent(guids));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
    expect(promptGuids(1)).toEqual([guids[1]]);
    // The bill's own answer from the batch call, then the issues, as the last user turn.
    const corrective = JSON.parse(mockBedrockSend.mock.calls[1][0].input.body);
    expect(corrective.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(corrective.messages[1].content[0].text).toBe(
      billsJson(analysis(guids[1], { soWhat: "Taxes rise. Prices fall. Jobs move." })),
    );
    expect(corrective.messages[2].content[0].text).toContain(
      "- soWhat has 3 sentences. The limit is 2 sentences and 280 characters; rewrite it in at most 240 characters.",
    );
    expect(JSON.parse(mockBedrockSend.mock.calls[0][0].input.body).messages).toHaveLength(1);
    expect(stored["processed-bills/BILLS-119hr2.json"].soWhat).toBe("Taxes rise and prices fall.");
    expect(logLines(logSpy).filter((line) => line.event === "analysis_revised")).toEqual([
      expect.objectContaining({ guid: guids[1], fields: ["soWhat"], keptFromFirst: [] }),
    ]);
    expect(metricValues(logSpy, "BillSummarizerAnalysisRevised")).toEqual([0, 1]);
  });

  it("fails every record in the batch when a Bedrock error outlasts its retries, and logs their guids", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih"];
    const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
    mockBedrockSend.mockRejectedValue(
      Object.assign(new Error("Model error"), { name: "ModelErrorException", $metadata: { httpStatusCode: 424 } }),
    );

    const response = await loadHandler()(sqsEvent(guids));

    expect(failedIds(response)).toEqual(["msg-1", "msg-2"]);
    expect(stored).toEqual({});
    // A 424 is transient: two retries, then the call fails.
    expect(mockBedrockSend).toHaveBeenCalledTimes(3);
    expect(bedrockLogLines(warnSpy).map((line) => [line.outcome, line.attempt, typeof line.retryInMs])).toEqual([
      ["transient", 0, "number"],
      ["transient", 1, "number"],
    ]);
    const lines = bedrockLogLines(errorSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      outcome: "transient",
      attempt: 2,
      guids,
      errorName: "ModelErrorException",
      httpStatus: 424,
      errorMessage: "Model error",
    });
    expect(lines[0]).not.toHaveProperty("retryInMs");
  });

  it("retries a throttled call and then succeeds", async () => {
    const guid = "BILLS-119hr1ih";
    const stored = setupStore({ [guid]: rawBill(guid) });
    mockBedrockSend
      .mockRejectedValueOnce(
        Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } }),
      )
      .mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guid))));

    const response = await loadHandler()(sqsEvent([guid]));

    expect(failedIds(response)).toEqual([]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
    expect(Object.keys(stored)).toHaveLength(1);
    expect(bedrockLogLines(warnSpy)[0]).toMatchObject({ outcome: "throttled", guids: [guid], attempt: 0 });
    expect(bedrockLogLines(logSpy)[0]).toMatchObject({ outcome: "ok", attempt: 1 });
    expect(bedrockLogLines(errorSpy)).toEqual([]);
  });

  it("fails only the record whose raw bill could not be loaded", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih"];
    const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])), { failGetFor: [guids[0]] });
    mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[1]))));

    const response = await loadHandler()(sqsEvent(guids));

    expect(failedIds(response)).toEqual(["msg-1"]);
    expect(promptGuids(0)).toEqual([guids[1]]);
    expect(Object.keys(stored)).toEqual(["processed-bills/BILLS-119hr2.json"]);
  });

  it("fails only the record whose processed bill could not be stored", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih"];
    const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])), { failPutFor: [guids[1]] });
    mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[0]), analysis(guids[1]))));

    const response = await loadHandler()(sqsEvent(guids));

    expect(failedIds(response)).toEqual(["msg-2"]);
    expect(Object.keys(stored)).toEqual(["processed-bills/BILLS-119hr1.json"]);
  });

  it("skips records without a usable body or raw bill instead of failing them", async () => {
    const guid = "BILLS-119hr1ih";
    setupStore({ [guid]: rawBill(guid) });
    mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guid))));

    const event = {
      Records: [
        { messageId: "msg-1", body: JSON.stringify({ guid }) },
        { messageId: "msg-2", body: "not a bill id" },
        { messageId: "msg-3", body: JSON.stringify({ guid: "BILLS-119hr404ih" }) },
        { messageId: "msg-4", body: "BILLS-119hr5ih" },
      ],
    };
    const response = await loadHandler()(event);

    expect(failedIds(response)).toEqual([]);
    expect(promptGuids(0)).toEqual([guid]);
  });

  it("summarizes a bill named by several records once and reports them together", async () => {
    const guid = "BILLS-119hr1ih";
    setupStore({ [guid]: rawBill(guid) });
    mockBedrockSend.mockRejectedValueOnce(
      Object.assign(new Error("Malformed input request"), {
        name: "ValidationException",
        $metadata: { httpStatusCode: 400 },
      }),
    );

    const response = await loadHandler()(sqsEvent([guid, guid]));

    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(promptGuids(0)).toEqual([guid]);
    expect(failedIds(response)).toEqual(["msg-1", "msg-2"]);
  });

  it("does not start a Bedrock call without enough time left and fails those records", async () => {
    const guid = "BILLS-119hr1ih";
    setupStore({ [guid]: rawBill(guid) });

    const response = await loadHandler()(sqsEvent([guid]), { getRemainingTimeInMillis: () => 5_000 });

    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(failedIds(response)).toEqual(["msg-1"]);
    expect(bedrockLogLines(errorSpy)[0]).toMatchObject({ outcome: "skipped", guids: [guid] });
  });

  it("keeps bills stored before the time ran out and fails only the rest", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih", "BILLS-119hr3ih"];
    const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
    const full = billsJson(analysis(guids[0]), analysis(guids[1]), analysis(guids[2]));
    let remaining = 50_000;
    mockBedrockSend
      .mockImplementationOnce(async () => {
        remaining = 25_000;
        return bedrockResponse(full.slice(0, full.indexOf(guids[1]) + 20), "max_tokens");
      })
      .mockImplementationOnce(async () => {
        remaining = 10_000;
        return bedrockResponse(billsJson(analysis(guids[1])));
      });

    const response = await loadHandler()(sqsEvent(guids), { getRemainingTimeInMillis: () => remaining });

    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
    expect(failedIds(response)).toEqual(["msg-3"]);
    expect(Object.keys(stored).sort()).toEqual([
      "processed-bills/BILLS-119hr1.json",
      "processed-bills/BILLS-119hr2.json",
    ]);
  });

  it("splits more bills than MAX_BILLS_PER_BATCH across calls", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      { BUCKET_NAME: "bill-store", MODEL_ID: HAIKU_4_5, MAX_BILLS_PER_BATCH: "2", MAX_OUTPUT_TOKENS: "4096" },
      { replace: true, base: originalEnv },
    );
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih", "BILLS-119hr3ih"];
    setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
    mockBedrockSend
      .mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[0]), analysis(guids[1]))))
      .mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[2]))));

    const response = await loadHandler()(sqsEvent(guids));

    expect(failedIds(response)).toEqual([]);
    expect(promptGuids(0)).toEqual(guids.slice(0, 2));
    expect(promptGuids(1)).toEqual([guids[2]]);
  });

  it("stores each bill's correlation id as S3 metadata and logs it on the Bedrock line (OBS-10)", async () => {
    const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih"];
    setupStore({ [guids[0]]: rawBill(guids[0]), [guids[1]]: rawBill(guids[1]) });
    const puts: FakeS3Input[] = [];
    const store = mockS3Send.getMockImplementation()!;
    mockS3Send.mockImplementation(async (command: FakeS3Call) => {
      if (command.kind === "put") puts.push(command.input);
      return store(command);
    });
    mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(guids[0]), analysis(guids[1]))));
    const event = sqsEvent(guids);
    event.Records[0].messageAttributes = {
      correlationId: { dataType: "String", stringValue: "2026-03-02T10:00:00.000Z:BILLS-119hr1ih" },
    };

    const response = await loadHandler()(event, { awsRequestId: "req-9", getRemainingTimeInMillis: () => 600_000 });

    expect(failedIds(response)).toEqual([]);
    const metadataByKey = Object.fromEntries(puts.map((input) => [input.Key, input.Metadata]));
    expect(metadataByKey["processed-bills/BILLS-119hr1.json"]).toEqual({
      "correlation-id": "2026-03-02T10:00:00.000Z:BILLS-119hr1ih",
      // REL-30: the text the summary was written from (the test store has no versions or fetch times).
      "source-text-hash": sourceTextHash(rawBill(guids[0]) as unknown as RawBill),
    });
    // The second record carried none, so one was minted for it.
    const minted = metadataByKey["processed-bills/BILLS-119hr2.json"]["correlation-id"];
    expect(minted).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z:BILLS-119hr2ih$/);
    expect(bedrockLogLines(logSpy)[0]).toMatchObject({
      guids,
      correlationIds: ["2026-03-02T10:00:00.000Z:BILLS-119hr1ih", minted],
      awsRequestId: "req-9",
    });
  });

  it.each([
    [{ MAX_BILLS_PER_BATCH: "0" }, "Invalid env var MAX_BILLS_PER_BATCH"],
    [{ BEDROCK_CONCURRENCY: "1.5" }, "Invalid env var BEDROCK_CONCURRENCY"],
    [{ BEDROCK_CALL_TIMEOUT_MS: "soon" }, "Invalid env var BEDROCK_CALL_TIMEOUT_MS"],
  ])("throws on invalid configuration %j so the whole batch is retried", async (env, message) => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      { BUCKET_NAME: "bill-store", MODEL_ID: HAIKU_4_5, MAX_BILLS_PER_BATCH: "1", MAX_OUTPUT_TOKENS: "4096", ...env },
      { replace: true, base: originalEnv },
    );

    await expect(loadHandler()(sqsEvent(["BILLS-119hr1ih"]))).rejects.toThrow(message);
  });

  it.each([
    [{ MODEL_ID: "anthropic.claude-3-haiku-20240307-v1:0" }, "Unknown Bedrock model profile"],
    [{ MODEL_ID: HAIKU_5_5, BEDROCK_EFFORT: "max" }, "Invalid Bedrock effort: max"],
  ])("fails at cold start on a model or effort it has no request shape for: %j", (env, message) => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      { BUCKET_NAME: "bill-store", MAX_BILLS_PER_BATCH: "1", MAX_OUTPUT_TOKENS: "4096", ...env },
      { replace: true, base: originalEnv },
    );

    expect(() => loadHandler()).toThrow(message);
  });

  describe("on Haiku 5.5 (LLM-11)", () => {
    const useHaiku55 = (env: Record<string, string> = {}) => {
      restoreEnv?.();
      restoreEnv = applyTestEnv(
        {
          BUCKET_NAME: "bill-store",
          MODEL_ID: HAIKU_5_5,
          MAX_BILLS_PER_BATCH: "1",
          MAX_OUTPUT_TOKENS: "8192",
          BEDROCK_MAX_RETRIES: "2",
          BEDROCK_BASE_DELAY_MS: "1",
          BEDROCK_MAX_DELAY_MS: "2",
          ...env,
        },
        { replace: true, base: originalEnv },
      );
    };
    beforeEach(() => useHaiku55());

    const THINKING = { type: "thinking", thinking: "", signature: "sig" };
    const thinkingFirst = (text: string, stopReason = "end_turn") =>
      bedrockResponse([THINKING, { type: "text", text }], stopReason, { input_tokens: 1300, output_tokens: 900 });
    // A refusal can carry the start of an answer; it must never be stored.
    const refused = (guids: string[], category: string) =>
      bedrockResponse(
        [{ type: "text", text: billsJson(...guids.map((g) => analysis(g, { soWhat: "From the refused answer." }))) }],
        "refusal",
        { input_tokens: 1300, output_tokens: 40 },
        { type: "refusal", category },
      );
    const requestBody = (callIndex: number) => JSON.parse(mockBedrockSend.mock.calls[callIndex][0].input.body);

    it("sends output_config.effort and no sampling parameters, and stores a thinking-first answer", async () => {
      const guid = "BILLS-119hr1ih";
      const stored = setupStore({ [guid]: rawBill(guid) });
      mockBedrockSend.mockResolvedValueOnce(thinkingFirst(billsJson(analysis(guid))));

      const response = await loadHandler()(sqsEvent([guid]));

      expect(failedIds(response)).toEqual([]);
      const body = requestBody(0);
      expect(Object.keys(body)).toEqual(["anthropic_version", "max_tokens", "output_config", "system", "messages"]);
      expect(body).toMatchObject({ max_tokens: 8192, output_config: { effort: "medium" } });
      for (const field of ["temperature", "top_p", "top_k", "thinking", "fallbacks"]) {
        expect(body).not.toHaveProperty(field);
      }
      expect(body.messages.map((message: { role: string }) => message.role)).toEqual(["user"]);
      expect(stored["processed-bills/BILLS-119hr1.json"].soWhat).toBe("Rural homes could get faster internet.");
      expect(bedrockLogLines(logSpy)[0]).toMatchObject({
        modelId: HAIKU_5_5,
        requestProfile: "haiku-5-5",
        effort: "medium",
        max_tokens: 8192,
        content_types: ["thinking", "text"],
        thinking_blocks: 1,
        output_tokens: 900,
      });
      expect(logLines(logSpy).find((line) => line.event === "summary_stored")).toMatchObject({
        requestProfile: "haiku-5-5",
        effort: "medium",
        calls: 1,
      });
    });

    it("takes the effort from BEDROCK_EFFORT", async () => {
      useHaiku55({ BEDROCK_EFFORT: "low" });
      const guid = "BILLS-119hr1ih";
      setupStore({ [guid]: rawBill(guid) });
      mockBedrockSend.mockResolvedValueOnce(thinkingFirst(billsJson(analysis(guid))));

      await loadHandler()(sqsEvent([guid]));

      expect(requestBody(0).output_config).toEqual({ effort: "low" });
    });

    it("fails the record, without a corrective call, when thinking used all of max_tokens", async () => {
      const guid = "BILLS-119hr1ih";
      const stored = setupStore({ [guid]: rawBill(guid) });
      mockBedrockSend.mockResolvedValueOnce(bedrockResponse([THINKING], "max_tokens"));

      const response = await loadHandler()(sqsEvent([guid]));

      expect(failedIds(response)).toEqual(["msg-1"]);
      expect(mockBedrockSend).toHaveBeenCalledTimes(1);
      expect(stored).toEqual({});
      expect(bedrockLogLines(warnSpy)[0]).toMatchObject({ outcome: "max_tokens", text_chars: 0, thinking_blocks: 1 });
    });

    it("retries a refused bill on shortened text, then acknowledges every record naming it", async () => {
      const guid = "BILLS-119hr1ih";
      const stored = setupStore({ [guid]: rawBill(guid) });
      mockBedrockSend.mockResolvedValueOnce(refused([guid], "cyber")).mockResolvedValueOnce(refused([guid], "cyber"));

      const response = await loadHandler()(sqsEvent([guid, guid]));

      expect(failedIds(response)).toEqual([]);
      expect(stored).toEqual({});
      expect(mockBedrockSend).toHaveBeenCalledTimes(2);
      expect(bedrockLogLines(warnSpy).map((line) => [line.kind, line.outcome, line.refusal_category])).toEqual([
        ["first", "refusal", "cyber"],
        ["refusal_retry", "refusal", "cyber"],
      ]);
      expect(promptBills(1)[0]).toMatchObject({ guid, textComplete: false });
      const dropped = logLines(warnSpy).filter((line) => line.dropSite === "billSummarizer.refused");
      expect(dropped).toEqual([
        expect.objectContaining({ reason: "refusal", messageId: "msg-1", guid, category: "cyber" }),
        expect.objectContaining({ reason: "refusal", messageId: "msg-2", guid, category: "cyber" }),
      ]);
      expect(metricValues(logSpy, "MessagesUnprocessable")).toEqual([1, 1]);
      expect(metricValues(logSpy, "BedrockRefusal")).toEqual([1, 1]);
      expect(metricValues(logSpy, "BillSummarizerStored")).toEqual([]);
    });

    it("stores the retry's answer when only the full text was refused", async () => {
      const guid = "BILLS-119hr1ih";
      const stored = setupStore({ [guid]: rawBill(guid) });
      mockBedrockSend
        .mockResolvedValueOnce(refused([guid], "bio"))
        .mockResolvedValueOnce(thinkingFirst(billsJson(analysis(guid))));

      const response = await loadHandler()(sqsEvent([guid]));

      expect(failedIds(response)).toEqual([]);
      expect(stored["processed-bills/BILLS-119hr1.json"].soWhat).toBe("Rural homes could get faster internet.");
      expect(logLines(warnSpy).find((line) => line.event === "summary_from_reduced_input")).toMatchObject({
        guid,
        firstCategory: "bio",
      });
      expect(logLines(logSpy).find((line) => line.event === "summary_stored")).toMatchObject({
        calls: 2,
        reducedInput: true,
      });
    });

    it("stores nothing from a refused multi-bill answer and asks for each bill alone", async () => {
      useHaiku55({ MAX_BILLS_PER_BATCH: "5" });
      const guids = ["BILLS-119hr1ih", "BILLS-119hr2ih"];
      const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
      mockBedrockSend
        .mockResolvedValueOnce(refused(guids, "general_harms"))
        .mockResolvedValueOnce(thinkingFirst(billsJson(analysis(guids[0]))))
        .mockResolvedValueOnce(thinkingFirst(billsJson(analysis(guids[1]))));

      const response = await loadHandler()(sqsEvent(guids));

      expect(failedIds(response)).toEqual([]);
      expect(mockBedrockSend).toHaveBeenCalledTimes(3);
      expect(promptGuids(0)).toEqual(guids);
      expect(promptGuids(1)).toEqual([guids[0]]);
      expect(promptGuids(2)).toEqual([guids[1]]);
      for (const guid of guids) {
        expect(stored[`processed-bills/${guid.replace(/ih$/, "")}.json`].soWhat).toBe(
          "Rural homes could get faster internet.",
        );
      }
      expect(logLines(warnSpy).find((line) => line.event === "bedrock_output_problem")).toMatchObject({
        refused: true,
        missingGuids: guids,
      });
    });

    it.each([
      ["ValidationException", 400, "invalid_request"],
      ["AccessDeniedException", 403, "access_denied"],
      ["ResourceNotFoundException", 404, "not_found"],
    ])("does not retry a rejected request (%s) and counts it for the alarm", async (name, status, outcome) => {
      const guid = "BILLS-119hr1ih";
      setupStore({ [guid]: rawBill(guid) });
      mockBedrockSend.mockRejectedValue(
        Object.assign(new Error("Request rejected"), { name, $metadata: { httpStatusCode: status } }),
      );

      const response = await loadHandler()(sqsEvent([guid]));

      expect(failedIds(response)).toEqual(["msg-1"]);
      expect(mockBedrockSend).toHaveBeenCalledTimes(1);
      expect(bedrockLogLines(errorSpy)).toEqual([
        expect.objectContaining({ outcome, errorName: name, httpStatus: status, guids: [guid] }),
      ]);
      expect(metricValues(logSpy, "BedrockRequestRejected")).toEqual([1]);
    });

    it("aborts an attempt at BEDROCK_CALL_TIMEOUT_MS and does not retry it", async () => {
      useHaiku55({ BEDROCK_CALL_TIMEOUT_MS: "20" });
      const guid = "BILLS-119hr1ih";
      setupStore({ [guid]: rawBill(guid) });
      mockBedrockSend.mockImplementation(
        (_command: unknown, options: { abortSignal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.abortSignal.addEventListener("abort", () =>
              reject(Object.assign(new Error("Request aborted"), { name: "AbortError" })),
            );
          }),
      );

      const response = await loadHandler()(sqsEvent([guid]), { getRemainingTimeInMillis: () => 100_000 });

      expect(failedIds(response)).toEqual(["msg-1"]);
      expect(mockBedrockSend).toHaveBeenCalledTimes(1);
      expect(bedrockLogLines(errorSpy)).toEqual([expect.objectContaining({ outcome: "timeout", timeoutMs: 20 })]);
    });

    it("runs up to BEDROCK_CONCURRENCY single-bill calls at once", async () => {
      useHaiku55({ BEDROCK_CONCURRENCY: "3" });
      const guids = [1, 2, 3, 4, 5].map((n) => `BILLS-119hr${n}ih`);
      const stored = setupStore(Object.fromEntries(guids.map((g) => [g, rawBill(g)])));
      let inFlight = 0;
      let maxInFlight = 0;
      mockBedrockSend.mockImplementation(async (command: { input: { body: string } }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const text: string = JSON.parse(command.input.body).messages[0].content[0].text;
        const [bill] = JSON.parse(text.slice(text.indexOf("Bills: ") + "Bills: ".length));
        return thinkingFirst(billsJson(analysis(bill.guid)));
      });

      const response = await loadHandler()(sqsEvent(guids));

      expect(failedIds(response)).toEqual([]);
      expect(mockBedrockSend).toHaveBeenCalledTimes(5);
      expect(maxInFlight).toBe(3);
      expect(Object.keys(stored)).toHaveLength(5);
    });
  });

  describe("conditional writes and the already-current shortcut (REL-30)", () => {
    const KIND: Record<string, "GetObject" | "PutObject" | "ListObjectVersions"> = {
      get: "GetObject",
      put: "PutObject",
      list: "ListObjectVersions",
    };
    const GUID = "BILLS-119hr1ih";
    const RAW_KEY = "raw-bills/BILLS-119hr1.json";
    const PROCESSED_KEY = "processed-bills/BILLS-119hr1.json";
    const FETCHED_AT = "2026-09-01T00:00:00.000Z";

    let fake: FakeVersionedS3;
    beforeEach(() => {
      fake = new FakeVersionedS3();
      mockS3Send.mockImplementation((command: FakeS3Call) =>
        fake.send({ __cmd: KIND[command.kind], input: command.input }),
      );
    });

    const raw = (
      options: { text?: string; fetchedAt?: string; actions?: unknown[]; officialVotes?: Record<string, unknown> } = {},
    ) => {
      const doc = rawBill(GUID);
      doc.metadata.fetchedAt = options.fetchedAt ?? FETCHED_AT;
      if (options.text) doc.content.billXML = billXml(options.text);
      if (options.actions) doc.content.actions = { actions: options.actions };
      if (options.officialVotes) doc.content.officialVotes = options.officialVotes;
      return doc;
    };
    /** A processed bill as billSummarizer stored it from `builtFrom` (version `rawVersion`). */
    const storeProcessed = (builtFrom: RawBill, rawVersion: string, overrides: Record<string, unknown> = {}) =>
      fake.put(
        PROCESSED_KEY,
        {
          schemaVersion: 1,
          kind: "processed",
          storedAt: "2026-09-01T00:00:00.000Z",
          identifier: builtFrom.identifier,
          guid: GUID,
          title: "Earlier headline",
          link: "",
          soWhat: "Earlier summary.",
          billBreakdown: analysis(GUID).billBreakdown,
          subCategories: [],
          lifeAreas: [],
          sponsors: ["S000001"],
          cosponsors: ["C000001"],
          actions: (builtFrom.content.actions as { actions: unknown[] }).actions,
          committees: [],
          billStatus: "New",
          ...overrides,
        },
        {
          [SOURCE_METADATA_KEYS.textHash]: sourceTextHash(builtFrom),
          [SOURCE_METADATA_KEYS.rawVersion]: rawVersion,
          [SOURCE_METADATA_KEYS.fetchedAt]: builtFrom.metadata.fetchedAt,
        },
      );
    const event = (...bodies: unknown[]) => ({
      Records: bodies.map((body, i) => ({ messageId: `msg-${i + 1}`, body: JSON.stringify(body) })),
    });
    const processedPuts = () => fake.commands("PutObject", PROCESSED_KEY).map((call) => call.input);
    const metric = (name: string) => logLines(logSpy).filter((line) => line._aws && name in line).length;
    const houseVote = (members: unknown[] = []) => ({
      source: "congress_api",
      lastSyncedAt: FETCHED_AT,
      completeness: members.length > 0 ? "complete" : "partial",
      house: {
        yea: 220,
        nay: 210,
        present: 0,
        notVoting: 0,
        totalCounted: 430,
        actionCode: "8000",
        actionDate: "2026-08-20",
        memberDataAvailable: members.length > 0,
        members,
      },
    });
    const MEMBERS = [{ bioguideId: "A000001", displayName: "Doe, Jane", votePosition: "Yea" }];

    it("creates a new processed bill with IfNoneMatch and records its source", async () => {
      const versionId = fake.put(RAW_KEY, raw());
      mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(GUID))));

      const response = await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(failedIds(response)).toEqual([]);
      const [put] = processedPuts();
      expect(put.IfNoneMatch).toBe("*");
      expect(put.IfMatch).toBeUndefined();
      expect(put.Metadata).toEqual({
        "correlation-id": expect.stringMatching(/:BILLS-119hr1ih$/),
        "source-text-hash": sourceTextHash(raw()),
        "source-raw-version": versionId,
        "source-fetched-at": FETCHED_AT,
      });
    });

    it("writes over an existing processed bill with IfMatch on the version it read", async () => {
      const old = raw({ text: "BILLS-119hr1-old" });
      fake.put(RAW_KEY, old);
      storeProcessed(old, "rv-old");
      const read = fake.current(PROCESSED_KEY)!.etag;
      const versionId = fake.put(RAW_KEY, raw());
      mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(GUID))));

      await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(processedPuts()).toEqual([expect.objectContaining({ IfMatch: read })]);
      expect(fake.json<ProcessedBillDocument>(PROCESSED_KEY)!.soWhat).toBe("Rural homes could get faster internet.");
    });

    it("skips Bedrock when billDiffer's work finds the summary already current, and catches up the derived fields", async () => {
      const current = raw();
      fake.put(RAW_KEY, current);
      storeProcessed(current, "rv-earlier");
      const actions = [{ actionDate: "2026-08-21", actionCode: "8000", text: "Passed House" }];
      const versionId = fake.put(RAW_KEY, raw({ actions }));

      const response = await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(failedIds(response)).toEqual([]);
      expect(mockBedrockSend).not.toHaveBeenCalled();
      expect(fake.json(PROCESSED_KEY)).toMatchObject({ soWhat: "Earlier summary.", actions, billStatus: "Passed" });
      expect(fake.current(PROCESSED_KEY)!.metadata).toMatchObject({ "source-raw-version": versionId });
      expect(metric("BillSummarizerAlreadyCurrent")).toBe(1);
    });

    // REL-44: the release day's order (RUNBOOK 4.13) relies on a new summary of a law writing Finalized, not Passed.
    const LAW_ACTIONS = [
      { actionDate: "2026-08-28", actionCode: "36000", text: "Became Public Law No: 119-60.", type: "BecameLaw" },
      { actionDate: "2026-08-28", actionCode: "36000", text: "Signed by President.", type: "BecameLaw" },
      { actionDate: "2026-08-21", actionCode: "8000", text: "Passed House" },
    ];

    it("writes Finalized when the bill it summarizes became law (REL-44)", async () => {
      const versionId = fake.put(RAW_KEY, raw({ actions: LAW_ACTIONS }));
      mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(GUID))));

      const response = await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(failedIds(response)).toEqual([]);
      expect(mockBedrockSend).toHaveBeenCalledTimes(1);
      expect(fake.json(PROCESSED_KEY)).toMatchObject({ actions: LAW_ACTIONS, billStatus: "Finalized" });
    });

    it("catches up a stored Passed to Finalized when the summary is already current and the bill became law", async () => {
      const current = raw();
      fake.put(RAW_KEY, current);
      storeProcessed(current, "rv-earlier", { billStatus: "Passed" });
      const versionId = fake.put(RAW_KEY, raw({ actions: LAW_ACTIONS }));

      await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(mockBedrockSend).not.toHaveBeenCalled();
      expect(fake.json(PROCESSED_KEY)).toMatchObject({ actions: LAW_ACTIONS, billStatus: "Finalized" });
    });

    it("always calls Bedrock for unmarked records, even next to a marked one", async () => {
      const current = raw();
      const versionId = fake.put(RAW_KEY, current);
      storeProcessed(current, versionId);
      mockBedrockSend.mockResolvedValue(bedrockResponse(billsJson(analysis(GUID))));

      await loadHandler()(event({ guid: GUID }));
      await loadHandler()(event({ guid: GUID, rawVersionId: versionId }, { guid: GUID }));

      expect(mockBedrockSend).toHaveBeenCalledTimes(2);
      expect(metric("BillSummarizerAlreadyCurrent")).toBe(0);
    });

    it("retries an unmarked record's write once over the new ETag after a 412", async () => {
      const current = raw();
      const versionId = fake.put(RAW_KEY, current);
      storeProcessed(current, versionId);
      fake.beforePut(PROCESSED_KEY, () => {
        storeProcessed(current, versionId, { cosponsors: ["C000001", "C000009"] }); // billDiffer patched meanwhile
      });
      mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(GUID))));

      const response = await loadHandler()(event({ guid: GUID }));

      expect(failedIds(response)).toEqual([]);
      const puts = processedPuts();
      expect(puts).toHaveLength(2);
      expect(puts[1].IfMatch).toBe(fake.versions(PROCESSED_KEY)[1].etag);
      expect(fake.json<ProcessedBillDocument>(PROCESSED_KEY)!.soWhat).toBe("Rural homes could get faster internet.");
    });

    it("catches up instead of retrying when the other writer stored a summary of the same text", async () => {
      const old = raw({ text: "BILLS-119hr1-old" });
      fake.put(RAW_KEY, old);
      storeProcessed(old, "rv-old");
      const current = raw();
      const versionId = fake.put(RAW_KEY, current);
      fake.beforePut(PROCESSED_KEY, () => {
        storeProcessed(current, versionId, { soWhat: "The other job's summary." });
      });
      mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(GUID))));

      const response = await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(failedIds(response)).toEqual([]);
      expect(mockBedrockSend).toHaveBeenCalledTimes(1);
      expect(processedPuts()).toHaveLength(1);
      expect(fake.json<ProcessedBillDocument>(PROCESSED_KEY)!.soWhat).toBe("The other job's summary.");
      expect(metric("BillSummarizerAlreadyCurrent")).toBe(1);
    });

    it("fails the record after a second conflict", async () => {
      const current = raw();
      const versionId = fake.put(RAW_KEY, current);
      storeProcessed(raw({ text: "BILLS-119hr1-old" }), "rv-old");
      for (const label of ["first", "second"]) {
        fake.beforePut(PROCESSED_KEY, () => {
          storeProcessed(raw({ text: "BILLS-119hr1-old" }), "rv-old", { soWhat: `${label} patch.` });
        });
      }
      mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(GUID))));

      const response = await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(failedIds(response)).toEqual(["msg-1"]);
      expect(fake.json<ProcessedBillDocument>(PROCESSED_KEY)!.soWhat).toBe("second patch.");
    });

    it("fails the record when a create gets 412 with no object there", async () => {
      const versionId = fake.put(RAW_KEY, raw());
      fake.put(PROCESSED_KEY, { deleted: true });
      fake.deleteObject(PROCESSED_KEY);
      fake.injectPutError(PROCESSED_KEY, 412);
      fake.injectPutError(PROCESSED_KEY, 412);
      mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(GUID))));

      const response = await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(failedIds(response)).toEqual(["msg-1"]);
      expect(processedPuts().every((put) => put.IfNoneMatch === "*")).toBe(true);
      expect(fake.current(PROCESSED_KEY)).toBeUndefined();
    });

    it("builds from the latest raw bill when it has the same text, carrying the enrichment's members", async () => {
      const versionId = fake.put(RAW_KEY, raw({ officialVotes: houseVote() }));
      let enriched = "";
      mockBedrockSend.mockImplementationOnce(async () => {
        enriched = fake.put(RAW_KEY, raw({ officialVotes: houseVote(MEMBERS) }));
        return bedrockResponse(billsJson(analysis(GUID)));
      });

      await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(fake.json<ProcessedBillDocument>(PROCESSED_KEY)!.officialVotes!.house!.members).toEqual(MEMBERS);
      expect(fake.current(PROCESSED_KEY)!.metadata).toMatchObject({ "source-raw-version": enriched });
    });

    it("keeps the members the processed bill already had for the same roll call", async () => {
      const old = raw({ text: "BILLS-119hr1-old", officialVotes: houseVote(MEMBERS) });
      fake.put(RAW_KEY, old);
      storeProcessed(old, "rv-old", { officialVotes: houseVote(MEMBERS) });
      const versionId = fake.put(RAW_KEY, raw({ fetchedAt: "2026-09-05T00:00:00.000Z", officialVotes: houseVote() }));
      mockBedrockSend.mockResolvedValueOnce(bedrockResponse(billsJson(analysis(GUID))));

      await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(fake.json(PROCESSED_KEY)).toMatchObject({
        soWhat: "Rural homes could get faster internet.",
        officialVotes: { house: { members: MEMBERS }, completeness: "complete" },
      });
    });

    it("builds from the raw bill it read when a different text from an older fetch landed meanwhile", async () => {
      const versionId = fake.put(RAW_KEY, raw({ fetchedAt: "2026-09-05T00:00:00.000Z" }));
      mockBedrockSend.mockImplementationOnce(async () => {
        fake.put(RAW_KEY, raw({ text: "BILLS-119hr1-older", fetchedAt: "2026-09-01T00:00:00.000Z" }));
        return bedrockResponse(billsJson(analysis(GUID)));
      });

      await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(fake.current(PROCESSED_KEY)!.metadata).toMatchObject({
        "source-raw-version": versionId,
        "source-text-hash": sourceTextHash(raw({ fetchedAt: "2026-09-05T00:00:00.000Z" })),
      });
    });

    it("builds from a latest raw bill stored without text, keeping the summarized text's hash", async () => {
      const versionId = fake.put(RAW_KEY, raw());
      let textless = "";
      mockBedrockSend.mockImplementationOnce(async () => {
        const doc = raw({ fetchedAt: "2026-09-09T00:00:00.000Z" });
        delete doc.content.billXML;
        textless = fake.put(RAW_KEY, doc);
        return bedrockResponse(billsJson(analysis(GUID)));
      });

      const response = await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(failedIds(response)).toEqual([]);
      expect(fake.current(PROCESSED_KEY)!.metadata).toMatchObject({
        "source-text-hash": sourceTextHash(raw()),
        "source-raw-version": textless,
        "source-fetched-at": "2026-09-09T00:00:00.000Z",
      });
      expect(metric("BillSummarizerSuperseded")).toBe(0);
    });

    it("skips Bedrock when the processed bill comes from a newer fetch than the raw bill (stale_raw)", async () => {
      const newer = raw({ text: "BILLS-119hr1-newer", fetchedAt: "2026-09-09T00:00:00.000Z" });
      fake.put(RAW_KEY, newer);
      storeProcessed(newer, "rv-newer");
      const versionId = fake.put(RAW_KEY, raw({ fetchedAt: "2026-09-05T00:00:00.000Z" }));

      const response = await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(failedIds(response)).toEqual([]);
      expect(mockBedrockSend).not.toHaveBeenCalled();
      expect(processedPuts()).toEqual([]);
      expect(metric("BillSummarizerSuperseded")).toBe(1);
    });

    it("fails the record, without Bedrock, when the newer fetch's raw version cannot be read to check it for text", async () => {
      // The processed bill keeps the old text's hash with the derived fields of a newer fetch without text.
      const textless = raw({ fetchedAt: "2026-09-09T00:00:00.000Z" });
      delete textless.content.billXML;
      storeProcessed(raw({ fetchedAt: "2026-09-09T00:00:00.000Z" }), fake.put(RAW_KEY, textless));
      // An older fetch with new text, stored late.
      const versionId = fake.put(RAW_KEY, raw({ text: "BILLS-119hr1-v2", fetchedAt: "2026-09-04T00:00:00.000Z" }));
      // The load's GET of the latest raw bill passes; the next one (the source version) fails.
      fake.afterGet(RAW_KEY, async () =>
        fake.afterGet(RAW_KEY, async () => {
          throw Object.assign(new Error("S3 internal error"), {
            name: "InternalError",
            $metadata: { httpStatusCode: 500 },
          });
        }),
      );

      const response = await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(failedIds(response)).toEqual(["msg-1"]);
      expect(mockBedrockSend).not.toHaveBeenCalled();
      expect(processedPuts()).toEqual([]);
    });

    it("stores nothing when newer text landed meanwhile (superseded), and the record succeeds", async () => {
      const versionId = fake.put(RAW_KEY, raw());
      mockBedrockSend.mockImplementationOnce(async () => {
        fake.put(RAW_KEY, raw({ text: "BILLS-119hr1-newer", fetchedAt: "2026-09-09T00:00:00.000Z" }));
        return bedrockResponse(billsJson(analysis(GUID)));
      });

      const response = await loadHandler()(event({ guid: GUID, rawVersionId: versionId }));

      expect(failedIds(response)).toEqual([]);
      expect(processedPuts()).toEqual([]);
      expect(metric("BillSummarizerSuperseded")).toBe(1);
    });
  });
});
