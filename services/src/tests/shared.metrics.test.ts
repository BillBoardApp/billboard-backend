export {};

const mockCloudWatchSend = jest.fn();
const mockCloudWatchClient = jest.fn(() => ({ send: mockCloudWatchSend }));

jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn((...args: unknown[]) => (mockCloudWatchClient as jest.Mock)(...args)),
  PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

type MetricsModule = typeof import("../shared/metrics");

let metrics: MetricsModule;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.resetModules();
  mockCloudWatchSend.mockReset();
  mockCloudWatchSend.mockResolvedValue({});
  mockCloudWatchClient.mockClear();
  warnSpy = jest.spyOn(console, "warn").mockImplementation();
  metrics = require("../shared/metrics") as MetricsModule;
});

afterEach(() => {
  warnSpy.mockRestore();
});

const sentInputs = () => mockCloudWatchSend.mock.calls.map(([command]) => command.input);

describe("putMetric", () => {
  it("emits a Count datum with no Dimensions key when no dimensions are given", async () => {
    await metrics.putMetric("BillBoard/BillIngestion", "CongressApiAuthFailure", 1);

    expect(sentInputs()).toEqual([
      {
        Namespace: "BillBoard/BillIngestion",
        MetricData: [{ MetricName: "CongressApiAuthFailure", Unit: "Count", Value: 1 }],
      },
    ]);
    expect(sentInputs()[0].MetricData[0]).not.toHaveProperty("Dimensions");
  });

  it("maps dimensions to CloudWatch Name/Value pairs", async () => {
    await metrics.putMetric("BillBoard/BillIngestion", "BillXmlFetchFailure", 1, { Source: "CongressGov" });

    expect(sentInputs()[0].MetricData).toEqual([
      {
        MetricName: "BillXmlFetchFailure",
        Dimensions: [{ Name: "Source", Value: "CongressGov" }],
        Unit: "Count",
        Value: 1,
      },
    ]);
  });

  it("treats an empty dimensions object like no dimensions", async () => {
    await metrics.putMetric("BillBoard/Notifications", "Sent", 3, {});
    expect(sentInputs()[0].MetricData[0]).not.toHaveProperty("Dimensions");
  });

  it("honours a custom unit", async () => {
    await metrics.putMetric("BillBoard/Notifications", "ApnsCertificateDaysRemaining", 42, undefined, "None");
    expect(sentInputs()[0].MetricData[0]).toEqual({
      MetricName: "ApnsCertificateDaysRemaining",
      Unit: "None",
      Value: 42,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "skips non-finite values (%p) without calling CloudWatch",
    async (value) => {
      await metrics.putMetric("BillBoard/WeeklyDigest", "WeeklyDigestUsersFailed", value);
      expect(mockCloudWatchSend).not.toHaveBeenCalled();
    },
  );

  it("emits zero values", async () => {
    await metrics.putMetric("BillBoard/WeeklyDigest", "WeeklyDigestUsersFailed", 0);
    expect(sentInputs()[0].MetricData[0].Value).toBe(0);
  });

  it("never throws; logs a warning when CloudWatch fails", async () => {
    const failure = new Error("throttled");
    mockCloudWatchSend.mockRejectedValueOnce(failure);

    await expect(metrics.putMetric("BillBoard/BillIngestion", "CongressApi429", 1)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith("Failed to emit metric CongressApi429 to BillBoard/BillIngestion", failure);
  });

  it("creates one CloudWatch client lazily and reuses it", async () => {
    expect(mockCloudWatchClient).not.toHaveBeenCalled();
    await metrics.putMetric("NS", "A", 1);
    await metrics.putMetric("NS", "B", 1);
    expect(mockCloudWatchClient).toHaveBeenCalledTimes(1);
  });
});

describe("putMetrics", () => {
  it("sends several datums in one call, keeping per-datum dimensions and units", async () => {
    await metrics.putMetrics("BillBoard/BillIngestion", [
      { name: "BillXmlFetchFailure", value: 1, dimensions: { Source: "CongressGov" } },
      { name: "BillXmlFetchFailure", value: 1, dimensions: { Source: "CongressGov", StatusCode: "404" } },
      { name: "FetchSeconds", value: 2.5, unit: "Seconds" },
    ]);

    expect(mockCloudWatchSend).toHaveBeenCalledTimes(1);
    expect(sentInputs()[0]).toEqual({
      Namespace: "BillBoard/BillIngestion",
      MetricData: [
        {
          MetricName: "BillXmlFetchFailure",
          Dimensions: [{ Name: "Source", Value: "CongressGov" }],
          Unit: "Count",
          Value: 1,
        },
        {
          MetricName: "BillXmlFetchFailure",
          Dimensions: [
            { Name: "Source", Value: "CongressGov" },
            { Name: "StatusCode", Value: "404" },
          ],
          Unit: "Count",
          Value: 1,
        },
        { MetricName: "FetchSeconds", Unit: "Seconds", Value: 2.5 },
      ],
    });
  });

  it("drops only the non-finite datums", async () => {
    await metrics.putMetrics("NS", [
      { name: "Good", value: 1 },
      { name: "Bad", value: Number.NaN },
    ]);
    expect(sentInputs()[0].MetricData.map((d: { MetricName: string }) => d.MetricName)).toEqual(["Good"]);
  });

  it("does nothing for an empty list", async () => {
    await metrics.putMetrics("NS", []);
    expect(mockCloudWatchSend).not.toHaveBeenCalled();
  });

  it("splits more than 1000 datums into separate calls and keeps going after a failed chunk", async () => {
    mockCloudWatchSend.mockRejectedValueOnce(new Error("first chunk failed"));
    const data = Array.from({ length: 2001 }, (_, i) => ({ name: `M${i % 2}`, value: i }));

    await expect(metrics.putMetrics("NS", data)).resolves.toBeUndefined();

    expect(sentInputs().map((input) => input.MetricData.length)).toEqual([1000, 1000, 1]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("Failed to emit metric M0, M1 to NS", expect.any(Error));
  });
});

describe("embedded metric format", () => {
  let logSpy: jest.SpyInstance;
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation();
    const saved = {
      fn: process.env.AWS_LAMBDA_FUNCTION_NAME,
      format: process.env.AWS_LAMBDA_LOG_FORMAT,
    };
    process.env.AWS_LAMBDA_FUNCTION_NAME = "FetchBillsManifest";
    delete process.env.AWS_LAMBDA_LOG_FORMAT;
    restoreEnv = () => {
      for (const [name, value] of [
        ["AWS_LAMBDA_FUNCTION_NAME", saved.fn],
        ["AWS_LAMBDA_LOG_FORMAT", saved.format],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restoreEnv?.();
  });

  const writtenLines = () => logSpy.mock.calls.map(([line]) => JSON.parse(line));

  it("writes one JSON line whose _aws block declares the metric, with no dimensions and no CloudWatch call", () => {
    metrics.emitEmbeddedMetric("BillBoard/BillsManifest", "SnapshotPointerServed", 1, { timestamp: 1_760_000_000_000 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(typeof logSpy.mock.calls[0][0]).toBe("string");
    expect(logSpy.mock.calls[0]).toHaveLength(1);
    expect(writtenLines()).toEqual([
      {
        service: "billboard-services",
        fn: "FetchBillsManifest",
        SnapshotPointerServed: 1,
        _aws: {
          Timestamp: 1_760_000_000_000,
          CloudWatchMetrics: [
            {
              Namespace: "BillBoard/BillsManifest",
              Dimensions: [[]],
              Metrics: [{ Name: "SnapshotPointerServed", Unit: "Count" }],
            },
          ],
        },
      },
    ]);
    expect(mockCloudWatchSend).not.toHaveBeenCalled();
    expect(mockCloudWatchClient).not.toHaveBeenCalled();
  });

  it("stamps the current time, writes dimensions as top-level fields and keeps units", () => {
    jest.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);

    metrics.emitEmbeddedMetrics(
      "BillBoard/CongressMemberStats",
      [
        { name: "MemberCounterSkippedUnseeded", value: 3 },
        { name: "ApplySeconds", value: 0.25, unit: "Seconds" },
      ],
      { dimensions: { Counter: "billsSponsored" }, properties: { key: "processed-bills/BILLS-119hr1.json" } },
    );

    const [line] = writtenLines();
    expect(line).toMatchObject({
      Counter: "billsSponsored",
      key: "processed-bills/BILLS-119hr1.json",
      MemberCounterSkippedUnseeded: 3,
      ApplySeconds: 0.25,
      _aws: {
        Timestamp: 1_770_000_000_000,
        CloudWatchMetrics: [
          {
            Namespace: "BillBoard/CongressMemberStats",
            Dimensions: [["Counter"]],
            Metrics: [
              { Name: "MemberCounterSkippedUnseeded", Unit: "Count" },
              { Name: "ApplySeconds", Unit: "Seconds" },
            ],
          },
        ],
      },
    });
  });

  it("carries the logger's correlation keys in scope", () => {
    const { logger } = require("../shared/logger");
    logger.resetContext({ awsRequestId: "req-1" });

    logger.withKeys({ correlationId: "2026-09-25T00:00:00.000Z:BILLS-119hr1", guid: "BILLS-119hr1" }, () =>
      metrics.emitEmbeddedMetric("NS", "Seen", 1),
    );

    expect(writtenLines()[0]).toMatchObject({
      correlationId: "2026-09-25T00:00:00.000Z:BILLS-119hr1",
      guid: "BILLS-119hr1",
      Seen: 1,
    });
  });

  it("writes a name given twice as a list of values and drops non-finite values", () => {
    metrics.emitEmbeddedMetrics("NS", [
      { name: "Latency", value: 4, unit: "Milliseconds" },
      { name: "Latency", value: 6, unit: "Milliseconds" },
      { name: "Broken", value: Number.POSITIVE_INFINITY },
    ]);

    const [line] = writtenLines();
    expect(line.Latency).toEqual([4, 6]);
    expect(line).not.toHaveProperty("Broken");
    expect(line._aws.CloudWatchMetrics[0].Metrics).toEqual([{ Name: "Latency", Unit: "Milliseconds" }]);
  });

  it("writes nothing when no value is finite", () => {
    expect(metrics.formatEmbeddedMetrics("NS", [{ name: "X", value: Number.NaN }])).toBeNull();
    metrics.emitEmbeddedMetric("NS", "X", Number.NaN);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not let a property override the _aws block", () => {
    const line = JSON.parse(
      metrics.formatEmbeddedMetrics("NS", [{ name: "X", value: 1 }], { properties: { _aws: "x" } })!,
    );
    expect(line._aws.CloudWatchMetrics[0].Namespace).toBe("NS");
  });

  it("writes straight to stdout with the Lambda JSON log format, so the line is not wrapped", () => {
    process.env.AWS_LAMBDA_LOG_FORMAT = "JSON";
    const stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      metrics.emitEmbeddedMetric("NS", "X", 1);
      expect(logSpy).not.toHaveBeenCalled();
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const written = String(stdoutSpy.mock.calls[0][0]);
      expect(written.endsWith("\n")).toBe(true);
      expect(JSON.parse(written)._aws.CloudWatchMetrics[0].Metrics).toEqual([{ Name: "X", Unit: "Count" }]);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("never throws; a line that cannot be serialized is reported with console.warn", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => metrics.emitEmbeddedMetric("NS", "X", 1, { properties: { circular } })).not.toThrow();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("Failed to emit embedded metric X to NS", expect.any(Error));
  });
});
