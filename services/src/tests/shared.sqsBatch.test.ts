import type { SQSEvent, SQSRecord } from "aws-lambda";
import { processSqsRecords } from "../shared/sqsBatch";
import { logger } from "../shared/logger";
import { logLines } from "./logLines";

const makeRecord = (messageId: string, body = "{}"): SQSRecord =>
  ({
    messageId,
    receiptHandle: `rh-${messageId}`,
    body,
    attributes: {} as SQSRecord["attributes"],
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:TestQueue",
    awsRegion: "us-east-1",
  }) as SQSRecord;

const makeEvent = (...ids: string[]): SQSEvent => ({ Records: ids.map((id) => makeRecord(id)) });

describe("processSqsRecords", () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("returns no failures when every record succeeds", async () => {
    const handled: string[] = [];
    const result = await processSqsRecords(makeEvent("a", "b", "c"), async (record) => {
      handled.push(record.messageId);
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(handled).toEqual(["a", "b", "c"]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("reports only the failed records, in batch order, and logs each with its messageId", async () => {
    const errB = new Error("b failed");
    const errD = new Error("d failed");
    const result = await processSqsRecords(makeEvent("a", "b", "c", "d"), async (record) => {
      if (record.messageId === "b") throw errB;
      if (record.messageId === "d") throw errD;
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "b" }, { itemIdentifier: "d" }] });
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(logLines(errorSpy)).toEqual([
      expect.objectContaining({
        message: "Failed to process SQS record",
        messageId: "b",
        sqsMessageId: "b",
        error: expect.objectContaining({ name: "Error", message: "b failed", stack: expect.any(String) }),
      }),
      expect.objectContaining({
        message: "Failed to process SQS record",
        messageId: "d",
        sqsMessageId: "d",
        error: expect.objectContaining({ name: "Error", message: "d failed", stack: expect.any(String) }),
      }),
    ]);
  });

  it("catches synchronous throws and non-Error rejections", async () => {
    const result = await processSqsRecords(makeEvent("sync", "value", "ok"), (record) => {
      if (record.messageId === "sync") throw new Error("sync");
      if (record.messageId === "value") return Promise.reject("plain string");
      return undefined;
    });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "sync" }, { itemIdentifier: "value" }]);
    expect(logLines(errorSpy)).toContainEqual(
      expect.objectContaining({ message: "Failed to process SQS record", messageId: "value", error: "plain string" }),
    );
  });

  it("uses a custom log label", async () => {
    await processSqsRecords(
      makeEvent("x"),
      async () => {
        throw new Error("nope");
      },
      { label: "billSummarizer record failure" },
    );
    expect(logLines(errorSpy)).toContainEqual(
      expect.objectContaining({ message: "billSummarizer record failure", messageId: "x" }),
    );
  });

  it("adds each record's sqsMessageId and correlationId attribute to what it logs (OBS-10)", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation();
    const traced = {
      ...makeRecord("m1"),
      messageAttributes: {
        correlationId: { dataType: "String", stringValue: "2026-03-02T10:00:00.000Z:BILLS-119hr1" },
      },
    } as SQSRecord;

    await processSqsRecords(
      { Records: [traced, makeRecord("m2")] },
      async () => {
        await Promise.resolve();
        logger.info("handled");
      },
      { concurrency: 2 },
    );

    const lines = logLines(logSpy);
    expect(lines).toEqual([
      expect.objectContaining({
        message: "handled",
        sqsMessageId: "m1",
        correlationId: "2026-03-02T10:00:00.000Z:BILLS-119hr1",
      }),
      expect.objectContaining({ message: "handled", sqsMessageId: "m2" }),
    ]);
    expect(lines[1]).not.toHaveProperty("correlationId");
    logSpy.mockRestore();
  });

  it("processes records sequentially by default and passes the index", async () => {
    const events: string[] = [];
    await processSqsRecords(makeEvent("a", "b", "c"), async (record, index) => {
      events.push(`start ${record.messageId}#${index}`);
      await new Promise((resolve) => setImmediate(resolve));
      events.push(`end ${record.messageId}`);
    });

    expect(events).toEqual(["start a#0", "end a", "start b#1", "end b", "start c#2", "end c"]);
  });

  it("keeps processing after a failure", async () => {
    const handled: string[] = [];
    const result = await processSqsRecords(makeEvent("a", "b", "c"), async (record) => {
      handled.push(record.messageId);
      if (record.messageId === "a") throw new Error("a failed");
    });

    expect(handled).toEqual(["a", "b", "c"]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "a" }]);
  });

  it("honours the concurrency option", async () => {
    let active = 0;
    let peak = 0;
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);

    const result = await processSqsRecords(
      makeEvent(...ids),
      async (record) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (record.messageId === "m7") throw new Error("m7 failed");
      },
      { concurrency: 3 },
    );

    expect(peak).toBe(3);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m7" }]);
  });

  it.each([{ Records: [] }, { Records: undefined as unknown as SQSRecord[] }, undefined, null])(
    "returns no failures for an empty event (%p)",
    async (event) => {
      const handleRecord = jest.fn();
      await expect(processSqsRecords(event, handleRecord)).resolves.toEqual({ batchItemFailures: [] });
      expect(handleRecord).not.toHaveBeenCalled();
    },
  );
});
