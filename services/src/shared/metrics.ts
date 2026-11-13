import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import type { MetricDatum, StandardUnit } from "@aws-sdk/client-cloudwatch";
import { logger, SERVICE_NAME } from "./logger";

type MetricDimensions = Record<string, string>;
export type MetricUnit = StandardUnit;

interface MetricInput {
  name: string;
  value: number;
  dimensions?: MetricDimensions;
  unit?: MetricUnit;
}

// PutMetricData accepts at most 1000 datums per call.
const MAX_DATUMS_PER_CALL = 1000;

let client: CloudWatchClient | undefined;

const toDatum = ({ name, value, dimensions, unit = "Count" }: MetricInput): MetricDatum => {
  const entries = Object.entries(dimensions ?? {});
  return {
    MetricName: name,
    ...(entries.length > 0 ? { Dimensions: entries.map(([Name, Value]) => ({ Name, Value })) } : {}),
    Unit: unit,
    Value: value,
  };
};

/**
 * Publishes several datums to one namespace. Non-finite values are skipped.
 * Never throws: a CloudWatch failure is logged with console.warn so metrics
 * cannot fail the caller. Await it so the call finishes inside the invocation.
 */
export const putMetrics = async (namespace: string, metrics: readonly MetricInput[]): Promise<void> => {
  const data = metrics.filter((metric) => Number.isFinite(metric.value)).map(toDatum);

  for (let start = 0; start < data.length; start += MAX_DATUMS_PER_CALL) {
    const chunk = data.slice(start, start + MAX_DATUMS_PER_CALL);
    try {
      client ??= new CloudWatchClient({});
      await client.send(new PutMetricDataCommand({ Namespace: namespace, MetricData: chunk }));
    } catch (error) {
      const names = Array.from(new Set(chunk.map((datum) => datum.MetricName))).join(", ");
      console.warn(`Failed to emit metric ${names} to ${namespace}`, error);
    }
  }
};

/** Publishes one datum (Unit defaults to Count). Same never-throw behaviour as putMetrics. */
export const putMetric = (
  namespace: string,
  name: string,
  value: number,
  dimensions?: MetricDimensions,
  unit: MetricUnit = "Count",
): Promise<void> => putMetrics(namespace, [{ name, value, dimensions, unit }]);

// ─── Embedded metric format (EMF) ─────────────────────────────────────────────

/** One EMF metric value. The unit defaults to Count. */
export interface EmbeddedMetricInput {
  name: string;
  value: number;
  unit?: MetricUnit;
}

export interface EmbeddedMetricOptions {
  /** Dimension name to value, applied to every metric of the line. None: the metric has no dimensions. */
  dimensions?: MetricDimensions;
  /** Extra fields kept on the log line (searchable in Logs Insights, not metrics). */
  properties?: Record<string, unknown>;
  /** Milliseconds since the epoch; defaults to now. */
  timestamp?: number;
}

/**
 * The EMF log line for these metrics, or null when none has a finite value. CloudWatch Logs turns
 * the `_aws.CloudWatchMetrics` block into metrics under `namespace`; with no dimensions the metric
 * is the same one PutMetricData without dimensions writes, so existing alarms keep working.
 * The line also carries the logger's service, function name and correlation keys in scope.
 * A name given twice is written as a list of values (EMF records each one).
 */
export const formatEmbeddedMetrics = (
  namespace: string,
  metrics: readonly EmbeddedMetricInput[],
  options: EmbeddedMetricOptions = {},
): string | null => {
  const valuesByName = new Map<string, { unit: MetricUnit; values: number[] }>();
  for (const metric of metrics) {
    if (!Number.isFinite(metric.value)) continue;
    const existing = valuesByName.get(metric.name);
    if (existing) existing.values.push(metric.value);
    else valuesByName.set(metric.name, { unit: metric.unit ?? "Count", values: [metric.value] });
  }
  if (valuesByName.size === 0) return null;

  const dimensions = Object.entries(options.dimensions ?? {});
  const line: Record<string, unknown> = {
    service: SERVICE_NAME,
    fn: process.env.AWS_LAMBDA_FUNCTION_NAME || undefined,
    ...logger.currentKeys(),
    ...(options.properties ?? {}),
  };
  for (const [name, value] of dimensions) line[name] = value;
  for (const [name, { values }] of valuesByName) line[name] = values.length === 1 ? values[0] : values;
  line._aws = {
    Timestamp: options.timestamp ?? Date.now(),
    CloudWatchMetrics: [
      {
        Namespace: namespace,
        Dimensions: [dimensions.map(([name]) => name)],
        Metrics: [...valuesByName].map(([name, { unit }]) => ({ Name: name, Unit: unit })),
      },
    ],
  };
  return JSON.stringify(line);
};

/**
 * Writes metrics as one EMF log line instead of calling PutMetricData: no network call to await
 * and no cloudwatch:PutMetricData permission needed. Never throws. With the Lambda JSON log
 * format the line goes straight to stdout, since console.log would wrap it in another object.
 */
export const emitEmbeddedMetrics = (
  namespace: string,
  metrics: readonly EmbeddedMetricInput[],
  options: EmbeddedMetricOptions = {},
): void => {
  try {
    const line = formatEmbeddedMetrics(namespace, metrics, options);
    if (!line) return;
    if (process.env.AWS_LAMBDA_LOG_FORMAT === "JSON") process.stdout.write(`${line}\n`);
    else console.log(line);
  } catch (error) {
    const names = Array.from(new Set(metrics.map((metric) => metric.name))).join(", ");
    console.warn(`Failed to emit embedded metric ${names} to ${namespace}`, error);
  }
};

/** One EMF metric (Count by default); see emitEmbeddedMetrics. */
export const emitEmbeddedMetric = (
  namespace: string,
  name: string,
  value: number,
  options: EmbeddedMetricOptions & { unit?: MetricUnit } = {},
): void => emitEmbeddedMetrics(namespace, [{ name, value, unit: options.unit }], options);
