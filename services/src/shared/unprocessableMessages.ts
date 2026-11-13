import { isRedactedKey, logger, REDACTED } from "./logger";
import { emitEmbeddedMetric } from "./metrics";

/**
 * Counts messages that can never succeed (C1.8). A consumer that acknowledges such a message
 * (returns, or continues, without failing the record) calls `reportUnprocessableMessage` at that
 * point, so the drop is visible: one warning log line naming the drop site and one embedded-metric
 * line, `BillBoard/Pipeline` `MessagesUnprocessable` = 1, with no dimensions (one metric for every
 * site; `dropSite` and `reason` ride on the line as properties for Logs Insights).
 *
 * The helper never throws: a failing logger or stdout must not turn an acknowledged message into a
 * retry. It makes no network call and needs no IAM permission (EMF, not PutMetricData).
 *
 * The message content is logged for diagnosis, never under a key named `body` (the logger redacts
 * that key by design):
 * - `messageContent`: the parsed JSON when the body is JSON of at most 2 KB, so the logger's key
 *   redaction (tokens, emails, addresses, ...) applies at any depth;
 * - `messagePreview` otherwise: the first 256 characters. A larger JSON body is previewed from its
 *   re-serialization with the same keys redacted, so a token near the start is not written.
 */

export const UNPROCESSABLE_MESSAGE_NAMESPACE = "BillBoard/Pipeline";
export const UNPROCESSABLE_MESSAGE_METRIC = "MessagesUnprocessable";

export type UnprocessableDropSite =
  | "fetchRawBill.unidentifiedBill"
  | "billDiffer.missingGuid"
  | "billSummarizer.refused"
  | "enrichOfficialVotes.missingGuid"
  | "enrichOfficialVotes.rawBillMissing"
  | "notificationFanout.malformed"
  | "notificationType.currentMissing"
  | "notificationType.unresolvedBillId"
  | "userMatcher.malformed"
  | "userNotifier.malformed";

const LOG_MESSAGE = "Message cannot be processed; acknowledged without retry";
const MAX_CONTENT_BYTES = 2048;
const MAX_PREVIEW_CHARACTERS = 256;

const redactKeys = (key: string, value: unknown): unknown => (key && isRedactedKey(key) ? REDACTED : value);

const contentFields = (body: string | null | undefined): Record<string, unknown> => {
  if (typeof body !== "string") return {};
  let parsed: { value: unknown } | undefined;
  try {
    parsed = { value: JSON.parse(body) };
  } catch {
    parsed = undefined;
  }
  if (parsed && Buffer.byteLength(body, "utf8") <= MAX_CONTENT_BYTES) return { messageContent: parsed.value };
  const text = parsed ? JSON.stringify(parsed.value, redactKeys) : body;
  return { messagePreview: text.slice(0, MAX_PREVIEW_CHARACTERS) };
};

/**
 * Logs and counts one message that is acknowledged without retry. Call it where the consumer drops
 * the message; keep the existing `return`/`continue`. Never throws.
 */
export function reportUnprocessableMessage(input: {
  site: UnprocessableDropSite;
  reason: string;
  messageId?: string;
  body?: string | null;
  fields?: Record<string, unknown>;
}): void {
  let dropSite = "unknown";
  let reason = "unknown";
  try {
    dropSite = String(input.site);
    reason = String(input.reason);
    const data: Record<string, unknown> = { dropSite, reason, messageId: input.messageId };
    for (const [name, value] of Object.entries(input.fields ?? {})) {
      if (!Object.hasOwn(data, name)) data[name] = value;
    }
    Object.assign(data, contentFields(input.body));
    logger.warn(LOG_MESSAGE, data);
  } catch {
    // The log line is lost; the metric below still counts the drop.
  }
  try {
    emitEmbeddedMetric(UNPROCESSABLE_MESSAGE_NAMESPACE, UNPROCESSABLE_MESSAGE_METRIC, 1, {
      properties: { dropSite, reason },
    });
  } catch {
    // emitEmbeddedMetric already catches its own failures; this covers a throwing console.warn there.
  }
}
