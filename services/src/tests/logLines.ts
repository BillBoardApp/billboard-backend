/**
 * Reads back the JSON lines shared/logger.ts writes through console (OBS-10). Pass the jest spy
 * on console.log, console.warn or console.error; lines that are not JSON objects are skipped.
 */

/** The EMF block shared/metrics.ts writes on a metric line. */
export interface EmfBlock {
  Timestamp: number;
  CloudWatchMetrics: Array<{
    Namespace: string;
    Dimensions: string[][];
    Metrics: Array<{ Name: string; Unit: string }>;
  }>;
}

/**
 * A line the logger (or shared/metrics.ts, for an EMF line) wrote. The fields they always write are typed; the
 * data a call adds is unknown until a test narrows it.
 */
export interface LogLine {
  timestamp?: string;
  level?: string;
  message?: string;
  service?: string;
  fn?: string;
  awsRequestId?: string;
  _aws?: EmfBlock;
  [key: string]: unknown;
}

export const logLines = (spy: unknown): LogLine[] =>
  ((spy as jest.Mock).mock.calls as unknown[][]).flatMap(([line]) => {
    if (typeof line !== "string" || !line.startsWith("{")) return [];
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === "object" ? [parsed as LogLine] : [];
    } catch {
      return [];
    }
  });

/** The lines whose message equals `message`, or matches it when it is a RegExp. */
export const logLinesWithMessage = (spy: unknown, message: string | RegExp): LogLine[] =>
  logLines(spy).filter((line) =>
    typeof message === "string" ? line.message === message : message.test(String(line.message)),
  );
