import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

// C1.8: the shared helper every drop site calls. It must log and count a dropped message and never throw.

type HelperModule = typeof import("../shared/unprocessableMessages");
type LoggerModule = typeof import("../shared/logger");

const LOG_MESSAGE = "Message cannot be processed; acknowledged without retry";

let helper: HelperModule;
let loggerModule: LoggerModule;
let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let restoreEnv: (() => void) | undefined;

beforeEach(() => {
  restoreEnv = applyTestEnv({
    AWS_LAMBDA_FUNCTION_NAME: "BillDiffer",
    AWS_LAMBDA_LOG_FORMAT: undefined,
    LOG_LEVEL: undefined,
  });
  jest.resetModules();
  logSpy = jest.spyOn(console, "log").mockImplementation();
  warnSpy = jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
  loggerModule = require("../shared/logger") as LoggerModule;
  helper = require("../shared/unprocessableMessages") as HelperModule;
  loggerModule.logger.resetContext({ awsRequestId: "req-1" });
});

afterEach(() => {
  jest.restoreAllMocks();
  restoreEnv?.();
  restoreEnv = undefined;
});

const dropLines = () => logLines(warnSpy).filter((line) => line.message === LOG_MESSAGE);
const metricLines = () =>
  logLines(logSpy).filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/Pipeline");

describe("reportUnprocessableMessage (C1.8)", () => {
  it("exports the fixed namespace and metric name", () => {
    expect(helper.UNPROCESSABLE_MESSAGE_NAMESPACE).toBe("BillBoard/Pipeline");
    expect(helper.UNPROCESSABLE_MESSAGE_METRIC).toBe("MessagesUnprocessable");
  });

  it("writes one warning naming the site and one EMF line counting 1 with no dimensions", () => {
    helper.reportUnprocessableMessage({
      site: "billDiffer.missingGuid",
      reason: "missing_guid",
      messageId: "msg-1",
      body: "{}",
      fields: { key: "raw-bills/BILLS-119hr1.json" },
    });

    expect(dropLines()).toEqual([
      expect.objectContaining({
        level: "WARN",
        fn: "BillDiffer",
        awsRequestId: "req-1",
        dropSite: "billDiffer.missingGuid",
        reason: "missing_guid",
        messageId: "msg-1",
        key: "raw-bills/BILLS-119hr1.json",
        messageContent: {},
      }),
    ]);
    expect(logLines(warnSpy)).toHaveLength(1);

    expect(metricLines()).toHaveLength(1);
    const [metric] = metricLines();
    expect(metric).toMatchObject({
      MessagesUnprocessable: 1,
      dropSite: "billDiffer.missingGuid",
      reason: "missing_guid",
    });
    expect(metric._aws!.CloudWatchMetrics).toEqual([
      {
        Namespace: "BillBoard/Pipeline",
        Dimensions: [[]],
        Metrics: [{ Name: "MessagesUnprocessable", Unit: "Count" }],
      },
    ]);
    // Exactly one metric line and no other console output.
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("carries the correlation keys in scope on both lines", () => {
    loggerModule.logger.withKeys({ sqsMessageId: "msg-9", correlationId: "c-1", guid: "BILLS-119hr9" }, () =>
      helper.reportUnprocessableMessage({ site: "userMatcher.malformed", reason: "invalid_json" }),
    );

    expect(dropLines()[0]).toMatchObject({ sqsMessageId: "msg-9", correlationId: "c-1", guid: "BILLS-119hr9" });
    expect(metricLines()[0]).toMatchObject({ sqsMessageId: "msg-9", correlationId: "c-1", guid: "BILLS-119hr9" });
  });

  it("does not let fields override the site, the reason or the message id", () => {
    helper.reportUnprocessableMessage({
      site: "notificationType.currentMissing",
      reason: "current_not_found",
      messageId: "msg-2",
      fields: { dropSite: "spoofed", reason: "spoofed", messageId: "spoofed", toString: "kept", versionId: "v1" },
    });

    expect(dropLines()[0]).toMatchObject({
      dropSite: "notificationType.currentMissing",
      reason: "current_not_found",
      messageId: "msg-2",
      toString: "kept",
      versionId: "v1",
    });
  });

  describe("message content", () => {
    it("logs a JSON body of at most 2 KB as parsed messageContent, with secret and personal keys redacted at any depth", () => {
      const body = JSON.stringify({
        guid: "BILLS-119hr1",
        pushToken: "apns-token-123",
        nested: { user: { email: "someone@example.com", address: "1 Main St" }, list: [{ token: "t-1" }] },
      });

      helper.reportUnprocessableMessage({ site: "userMatcher.malformed", reason: "not_notification_type", body });

      const [line] = dropLines();
      expect(line.messageContent).toEqual({
        guid: "BILLS-119hr1",
        pushToken: "[redacted]",
        nested: { user: { email: "[redacted]", address: "[redacted]" }, list: [{ token: "[redacted]" }] },
      });
      expect(line).not.toHaveProperty("body");
      expect(line).not.toHaveProperty("messagePreview");
      const raw = String(warnSpy.mock.calls[0][0]);
      expect(raw).not.toContain("apns-token-123");
      expect(raw).not.toContain("someone@example.com");
      expect(raw).not.toContain("1 Main St");
    });

    it("logs a non-JSON body as its first 256 characters in messagePreview", () => {
      const body = `not json ${"x".repeat(400)}`;

      helper.reportUnprocessableMessage({ site: "billDiffer.missingGuid", reason: "invalid_json", body });

      const [line] = dropLines();
      expect(line.messagePreview).toBe(body.slice(0, 256));
      expect(line).not.toHaveProperty("messageContent");
      expect(line).not.toHaveProperty("body");
    });

    it("previews a JSON body over 2 KB from its redacted re-serialization", () => {
      const body = JSON.stringify({ pushToken: "apns-token-123", email: "someone@example.com", pad: "y".repeat(3000) });

      helper.reportUnprocessableMessage({ site: "notificationFanout.malformed", reason: "no valid userIds", body });

      const [line] = dropLines();
      expect(line).not.toHaveProperty("messageContent");
      expect(line.messagePreview).toHaveLength(256);
      expect(
        (line.messagePreview as string).startsWith('{"pushToken":"[redacted]","email":"[redacted]","pad":"yyy'),
      ).toBe(true);
      expect(String(warnSpy.mock.calls[0][0])).not.toContain("apns-token-123");
    });

    it("measures the 2 KB limit in UTF-8 bytes", () => {
      // {"v":"..."} is 8 bytes of structure.
      const fits = JSON.stringify({ v: "a".repeat(2040) });
      const tooBig = JSON.stringify({ v: "é".repeat(1021) }); // 1,029 characters, 2,050 bytes
      expect(Buffer.byteLength(fits)).toBe(2048);
      expect(Buffer.byteLength(tooBig)).toBe(2050);

      helper.reportUnprocessableMessage({ site: "userMatcher.malformed", reason: "r", body: fits });
      helper.reportUnprocessableMessage({ site: "userMatcher.malformed", reason: "r", body: tooBig });

      const [first, second] = dropLines();
      expect(first.messageContent).toEqual({ v: "a".repeat(2040) });
      expect(second).not.toHaveProperty("messageContent");
      expect(second.messagePreview).toHaveLength(256);
    });

    it("writes an empty preview for an empty body and no content for a missing one", () => {
      helper.reportUnprocessableMessage({ site: "userNotifier.malformed", reason: "empty_body", body: "" });
      helper.reportUnprocessableMessage({ site: "userNotifier.malformed", reason: "empty_body", body: null });
      helper.reportUnprocessableMessage({ site: "userNotifier.malformed", reason: "empty_body" });

      const [empty, nullBody, missing] = dropLines();
      expect(empty.messagePreview).toBe("");
      for (const line of [nullBody, missing]) {
        expect(line).not.toHaveProperty("messagePreview");
        expect(line).not.toHaveProperty("messageContent");
      }
      expect(metricLines()).toHaveLength(3);
    });

    it("keeps a JSON scalar or null body as messageContent", () => {
      helper.reportUnprocessableMessage({
        site: "enrichOfficialVotes.missingGuid",
        reason: "missing_guid",
        body: "null",
      });
      helper.reportUnprocessableMessage({ site: "enrichOfficialVotes.missingGuid", reason: "missing_guid", body: "7" });

      expect(dropLines().map((line) => line.messageContent)).toEqual([null, 7]);
    });
  });

  describe("never throws", () => {
    it("still counts the drop when the log line cannot be written", () => {
      warnSpy.mockImplementation(() => {
        throw new Error("console.warn broke");
      });

      expect(() =>
        helper.reportUnprocessableMessage({ site: "fetchRawBill.unidentifiedBill", reason: "no_bill_link" }),
      ).not.toThrow();
      expect(metricLines()).toEqual([expect.objectContaining({ dropSite: "fetchRawBill.unidentifiedBill" })]);
    });

    it("still logs the drop when the metric line cannot be written", () => {
      logSpy.mockImplementation(() => {
        throw new Error("console.log broke");
      });

      expect(() =>
        helper.reportUnprocessableMessage({ site: "notificationType.unresolvedBillId", reason: "no_bill_id" }),
      ).not.toThrow();
      expect(dropLines()).toEqual([expect.objectContaining({ dropSite: "notificationType.unresolvedBillId" })]);
    });

    it("survives a throwing stdout and console with the Lambda JSON log format", () => {
      process.env.AWS_LAMBDA_LOG_FORMAT = "JSON";
      const stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => {
        throw new Error("stdout broke");
      });
      warnSpy.mockImplementation(() => {
        throw new Error("console.warn broke");
      });

      expect(() =>
        helper.reportUnprocessableMessage({ site: "userNotifier.malformed", reason: "invalid_json", body: "{" }),
      ).not.toThrow();
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
    });

    it("writes the EMF line to stdout with the Lambda JSON log format", () => {
      process.env.AWS_LAMBDA_LOG_FORMAT = "JSON";
      const stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);

      helper.reportUnprocessableMessage({ site: "userNotifier.malformed", reason: "invalid_json", body: "{" });

      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(stdoutSpy.mock.calls[0][0]));
      expect(line).toMatchObject({
        MessagesUnprocessable: 1,
        dropSite: "userNotifier.malformed",
        reason: "invalid_json",
      });
      expect(dropLines()).toHaveLength(1);
    });

    it("survives a field whose getter throws, and still counts", () => {
      const fields = Object.defineProperty({}, "bad", {
        enumerable: true,
        get() {
          throw new Error("getter broke");
        },
      });

      expect(() =>
        helper.reportUnprocessableMessage({ site: "userMatcher.malformed", reason: "invalid_json", fields }),
      ).not.toThrow();
      expect(metricLines()).toEqual([expect.objectContaining({ dropSite: "userMatcher.malformed" })]);
    });

    it("survives a missing input and counts it under unknown", () => {
      expect(() => helper.reportUnprocessableMessage(undefined as never)).not.toThrow();
      expect(metricLines()).toEqual([expect.objectContaining({ dropSite: "unknown", reason: "unknown" })]);
    });

    it("survives a value that cannot be serialized", () => {
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;

      expect(() =>
        helper.reportUnprocessableMessage({
          site: "userMatcher.malformed",
          reason: "r",
          fields: { circular, big: 1n },
        }),
      ).not.toThrow();
      expect(dropLines()).toEqual([expect.objectContaining({ dropSite: "userMatcher.malformed", big: "1" })]);
      expect(metricLines()).toHaveLength(1);
    });
  });
});
