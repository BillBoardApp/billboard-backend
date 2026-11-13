jest.mock("@aws-sdk/client-sqs", () => ({
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import { groupEntriesForBatches, sendMessageBatchWithRetry, SqsBatchSendError } from "../shared/sqsSendWithRetry";

const entry = (id: string, body = "{}") => ({ Id: id, MessageBody: body });
const ids = (entries: Array<{ Id?: string }>) => entries.map((e) => e.Id);

beforeEach(() => {
  jest.spyOn(Math, "random").mockReturnValue(0); // no backoff delay
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("groupEntriesForBatches", () => {
  it("puts at most ten entries (or batchSize) in a call", () => {
    const entries = Array.from({ length: 23 }, (_, i) => entry(`e-${i}`));
    expect(groupEntriesForBatches(entries).map((batch) => batch.length)).toEqual([10, 10, 3]);
    expect(groupEntriesForBatches(entries, 5).map((batch) => batch.length)).toEqual([5, 5, 5, 5, 3]);
    expect(groupEntriesForBatches(entries, 50).map((batch) => batch.length)).toEqual([10, 10, 3]);
  });

  it("keeps each call under the SQS batch payload limit", () => {
    const big = "x".repeat(100 * 1024);
    const batches = groupEntriesForBatches([entry("a", big), entry("b", big), entry("c", big), entry("d", "{}")]);
    expect(batches.map(ids)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("sendMessageBatchWithRetry", () => {
  it("retries only the entries SQS reports as failed", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ Successful: [{ Id: "a" }, { Id: "c" }], Failed: [{ Id: "b", Code: "InternalError" }] })
      .mockResolvedValueOnce({ Successful: [{ Id: "b" }], Failed: [] });

    const sent = await sendMessageBatchWithRetry({ send }, "https://queue", [entry("a"), entry("b"), entry("c")]);

    expect(sent).toBe(3);
    expect(send).toHaveBeenCalledTimes(2);
    expect(ids(send.mock.calls[1][0].input.Entries)).toEqual(["b"]);
    expect(send.mock.calls[0][0].input.QueueUrl).toBe("https://queue");
  });

  it("retries a call that throws", async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ Successful: [{ Id: "a" }], Failed: [] });

    await expect(sendMessageBatchWithRetry({ send }, "q", [entry("a")])).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("throws with the failed ids once the attempts are used up", async () => {
    const send = jest.fn().mockResolvedValue({ Successful: [], Failed: [{ Id: "a", Code: "InternalError" }] });

    const error = await sendMessageBatchWithRetry({ send }, "q", [entry("a")], { maxAttempts: 3 }).catch((e) => e);

    expect(error).toBeInstanceOf(SqsBatchSendError);
    expect(error.failedIds).toEqual(["a"]);
    expect(error.message).toBe("Failed to send 1 message(s) to SQS after 3 attempt(s)");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not retry a sender fault", async () => {
    const send = jest
      .fn()
      .mockResolvedValue({ Successful: [], Failed: [{ Id: "a", Code: "InvalidMessageContents", SenderFault: true }] });

    await expect(sendMessageBatchWithRetry({ send }, "q", [entry("a")])).rejects.toThrow(SqsBatchSendError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
