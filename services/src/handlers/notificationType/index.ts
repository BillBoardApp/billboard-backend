import { createHash } from "crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

import { BillStorage } from "../../adapters/billStorage";
import { parseProcessedBillLookupFromS3Key, processedBillGuid } from "../../adapters/processedBillKeys";
import type { ProcessedBillDocument } from "../../models/bill";
import type { BillAlertDetails, NotificationTypeMessage, NotificationType } from "../../models/notifications";
import {
  billOutcomeTextForAction,
  defaultBillOutcomeText,
  deriveBillStatusFromActions,
  latestNewBillOutcomeAction,
  newBillActions,
} from "../../shared/billOutcomes";
import { actionTextWithoutCitations } from "../../shared/congressionalRecordCitations";
import {
  correlationIdFromMetadata,
  correlationIdFromRecord,
  correlationIdMessageAttributes,
  isRel56BackfillCorrelationId,
  mintCorrelationId,
} from "../../shared/correlation";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";
import { OUTCOME_PUSH_TYPES, type OutcomePushType } from "../../shared/pushAudience";
import { extractS3ObjectRefsFromSQSEvent } from "../../shared/s3EventExtract";
import { processSqsRecords } from "../../shared/sqsBatch";
import { reportUnprocessableMessage } from "../../shared/unprocessableMessages";

const BUCKET_NAME = process.env.BUCKET_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const QUEUE_BATCH_SIZE = Number.parseInt(process.env.QUEUE_BATCH_SIZE!, 10);

const PROCESSED_BILLS_PREFIX = process.env.PROCESSED_BILLS_PREFIX ?? "processed-bills/";

/**
 * REL-56 (docs/RUNBOOK.md 16.1, project decision 2026-11-12): what a processed-bill change the backfill wrote sends. The
 * backfill mints "rel56:<run start>:<guid>" correlation ids (shared/correlation.ts), and BillDiffer and BillSummarizer
 * store the id on the version they write, so the version tells.
 * - 'skip' (the infra default): such a change is classified and logged as any other, then handed to nobody: no
 *   userMatcher message, so no pending row, no push, held or paced, and no paired outcome. One line names its would-be
 *   types, and BackfillPushSkipped counts it. The backfill then runs without RUNBOOK 4.1 quiet windows.
 * - 'push': handed to userMatcher as any other change, as before (the rollback; window mode's window drops it).
 * Any other value, or none, means 'skip': it only ever silences the backfill's own changes.
 */
export type BackfillPushMode = "skip" | "push";
export const backfillPushModeOf = (value: string | undefined): BackfillPushMode => (value === "push" ? "push" : "skip");
const BACKFILL_PUSH_MODE = backfillPushModeOf(process.env.BACKFILL_PUSH_MODE);
const NOTIFICATIONS_METRIC_NAMESPACE = "BillBoard/Notifications";

const s3 = new S3Client({});
const sqs = new SQSClient({});

// userMatcher adds sourceRevision to its dedupe key, so a later update to the same
// bill notifies again while a redelivery of this one does not (REL-27).
type RevisionedNotificationTypeMessage = NotificationTypeMessage & { sourceRevision?: string };

// The body goes to userMatcher unchanged; the correlation id travels as a message attribute.
type OutgoingMessage = { message: RevisionedNotificationTypeMessage; correlationId: string };

const normString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const normStringOrNull = (v: unknown): string | null => {
  const s = normString(v);
  return s.length > 0 ? s : null;
};

const arraysEqual = (a: unknown[], b: unknown[]): boolean => {
  return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * The actions as an alert compares them: each text without its Congressional Record citations, as
 * normalizeBillActionKey knows it (shared/billOutcomes.ts). A version whose actions differ from the previous one's only
 * by citations added, changed or removed sends no alert (project decision 2026-11-12, docs/RUNBOOK.md 18.1); any other
 * difference still does, a line repeated or removed included.
 */
const actionsWithoutCitations = (actions: RawBillAction[]): unknown[] =>
  actions.map((action) =>
    action && typeof action === "object" && typeof action.text === "string"
      ? { ...action, text: actionTextWithoutCitations(action.text) }
      : action,
  );

const truncate = (s: string, maxLen: number): string => {
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…";
};

type RawBillAction = {
  actionCode?: unknown;
  actionDate?: unknown;
  text?: unknown;
  type?: unknown;
};

/** A stored processed bill as this handler reads it: each action's fields are checked before use. */
type BillDoc = Omit<ProcessedBillDocument, "actions"> & { actions?: RawBillAction[] };

const toEpochMsOrNull = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};

const sortActionsMostRecentFirst = (actions: RawBillAction[]): RawBillAction[] => {
  // Prefer the most recent action first. If actionDate is missing/unparseable, keep relative order.
  return actions
    .map((a, idx) => ({ a, idx, t: toEpochMsOrNull(a.actionDate) }))
    .sort((x, y) => {
      if (x.t === null && y.t === null) return x.idx - y.idx;
      if (x.t === null) return 1;
      if (y.t === null) return -1;
      if (x.t !== y.t) return y.t - x.t;
      return x.idx - y.idx;
    })
    .map((x) => x.a);
};

/**
 * The plain words and day of an action that has plain words (billOutcomeTextForAction), else null. REL-50 review R2:
 * one vote can reach a bill as two actions that read the same in a push. The House's floor line (an H-code) and the
 * Library of Congress's coded line (9000) for a failed suspension vote both read "House vote fell short of
 * two-thirds"; the Senate's uncoded line and its 18000 line for a failed vote under a 60-vote order both read "Senate
 * vote fell short of 60". The coded one can come a poll later. REL-44: the law lines of one day (36000 "Signed by
 * President.", then 36000 and E40000 "Became Public Law No: ...", which can come a poll or more later) all read "Became law".
 */
const plainVoteKey = (action: RawBillAction): string | null => {
  const words = billOutcomeTextForAction(action);
  const day = normString(action.actionDate).slice(0, 10);
  return words && day ? `${day}|${words}` : null;
};

/**
 * Whether a new action is a vote the previous version already recorded: the same plain words on the same day as one of
 * its actions (plainVoteKey). Its followers were told once, so it sends no alert of its own and is never the alert's
 * action (both apps would show a second, identical Recent actions row).
 */
const repeatsAPreviousVote = (previousActions: RawBillAction[]): ((action: RawBillAction) => boolean) => {
  const previousVotes = new Set(previousActions.map(plainVoteKey).filter((key): key is string => key !== null));
  return (action) => {
    const key = plainVoteKey(action);
    return key !== null && previousVotes.has(key);
  };
};

const toBillAlertDetails = (previous: BillDoc | null, current: BillDoc | null): BillAlertDetails | null => {
  if (!current) return null;

  const prevTitle = normString(previous?.title);
  const currTitle = normString(current?.title);

  const prevActions: RawBillAction[] = Array.isArray(previous?.actions) ? previous.actions : [];
  const currActions: RawBillAction[] = Array.isArray(current?.actions) ? current.actions : [];
  const currActionsNewestFirst = sortActionsMostRecentFirst(currActions);

  // Prefer the newest action that is present in current but not previous, and is not a vote previous recorded. An
  // action that only gained, changed or lost a Congressional Record citation is not new (newBillActions), so a version
  // that also brings one names the real new action.
  const added = newBillActions(prevActions, currActions);
  const isRepeatedVote = repeatsAPreviousVote(prevActions);
  for (const a of currActionsNewestFirst) {
    if (!added.has(a) || isRepeatedVote(a)) continue;
    const text = normString(a.text);
    if (!text) break;
    return {
      text: truncate(text, 180),
      actionDate: normStringOrNull(a.actionDate) ?? undefined,
      actionCode: normStringOrNull(a.actionCode) ?? undefined,
      actionType: normStringOrNull(a.type) ?? undefined,
    };
  }

  if (prevTitle && currTitle && prevTitle !== currTitle) {
    return { text: truncate(`Title updated: ${currTitle}`, 180) };
  }

  // Fallback when we know something changed but can't identify a single new action.
  return { text: "Bill updated" };
};

const toBillOutcomeDetails = (
  previous: BillDoc | null,
  current: BillDoc | null,
  expectedKind: "passed" | "failed",
): BillAlertDetails | null => {
  if (!current) return null;

  const prevActions: RawBillAction[] = Array.isArray(previous?.actions) ? previous.actions : [];
  const currActions: RawBillAction[] = Array.isArray(current?.actions) ? current.actions : [];
  const outcome = latestNewBillOutcomeAction(prevActions, currActions);
  if (!outcome || outcome.kind !== expectedKind) return null;

  return {
    text: truncate(outcome.text ?? defaultBillOutcomeText(outcome), 180),
    actionDate: outcome.actionDate,
    actionCode: outcome.actionCode,
    actionType: outcome.actionType,
  };
};

const extractBillIdFromKey = (key: string): string | null => {
  const parsed = parseProcessedBillLookupFromS3Key(key);
  if (!parsed) return null;
  if (parsed.kind === "guid") return parsed.guid;
  if (parsed.kind === "guidWithLocator") return parsed.guid;
  if (parsed.kind === "identifier") {
    const id = parsed.identifier;
    return `identifier:${id.congress}/${id.billType}/${id.billNumber}`;
  }
  return null;
};

const classifyBill = (previous: BillDoc | null, current: BillDoc | null): NotificationType[] => {
  if (!current) return [];
  if (!previous) return ["new"];

  const types: NotificationType[] = [];

  const prevBreakdown = JSON.stringify(previous.billBreakdown ?? "");
  const currBreakdown = JSON.stringify(current.billBreakdown ?? "");
  const prevSoWhat = normString(previous.soWhat);
  const currSoWhat = normString(current.soWhat);
  if (prevBreakdown !== currBreakdown || prevSoWhat !== currSoWhat) {
    types.push("updated");
  }

  const prevTitle = normString(previous.title);
  const currTitle = normString(current.title);
  const prevActions = Array.isArray(previous.actions) ? previous.actions : [];
  const currActions = Array.isArray(current.actions) ? current.actions : [];

  // An alert for a new title or changed actions, but not when every new action is a vote the previous version already
  // recorded in the same plain words on the same day (repeatsAPreviousVote: the coded twin of a floor line), and not
  // when the actions differ only by Congressional Record citations (actionsWithoutCitations, newBillActions).
  const added = newBillActions(prevActions, currActions);
  const newActions: RawBillAction[] = currActions.filter((action: RawBillAction) => added.has(action));
  const onlyRepeatedVotes = newActions.length > 0 && newActions.every(repeatsAPreviousVote(prevActions));
  const actionsChanged = !arraysEqual(actionsWithoutCitations(prevActions), actionsWithoutCitations(currActions));
  if (prevTitle !== currTitle || (actionsChanged && !onlyRepeatedVotes)) {
    types.push("alert");
  }

  // A new passage or failure of the bill itself (shared/billOutcomes.ts, REL-50: by action code; an amendment or
  // motion line, a failed suspension vote or a failed 60-vote Senate vote is only the "alert" above). A new failure
  // of a bill whose previous actions already give Failed (a vote taken again on reconsideration) is only that alert
  // too: "Failed:" says the bill failed, and its followers were told so once. billStatus is not compared: a version
  // that changes only it (the REL-50 and REL-44 status repairs) sends nothing. A bill becoming law (REL-44) has no
  // outcome type of its own: its law lines are the "alert" above, which says "Became law" (BECAME_LAW_TEXT). So a
  // version of a law sends no outcome either: not when one poll adds the passage together with the law lines (an
  // urgent bill passed and signed the same day), nor for a coded passage line that comes after the law. A "Passed"
  // push would then reach most followers about a bill both apps show as "Became law". A passage or failure line that
  // gains, changes or loses a Congressional Record citation is no new outcome (newBillActions, 2026-11-12).
  const latestOutcome = latestNewBillOutcomeAction(prevActions, currActions);
  const isLaw = deriveBillStatusFromActions(currActions) === "Finalized";
  if (
    latestOutcome &&
    !isLaw &&
    !(latestOutcome.kind === "failed" && deriveBillStatusFromActions(prevActions) === "Failed")
  ) {
    types.push(latestOutcome.kind);
  }

  return types;
};

// The S3 version id of the version read identifies the stored bill; without one (an unversioned GetObject answer), fall
// back to a hash of its content.
const sourceRevisionFor = (versionId: string | undefined, current: unknown): string =>
  versionId ?? `sha256:${createHash("sha256").update(JSON.stringify(current)).digest("hex").slice(0, 32)}`;

/**
 * UX-33: when the version with the new summary was stored, for an "updated" (userNotifier drops its "vote again" push
 * for a user who voted after it): the S3 write time, else the document's storedAt (a copy restored by an S3 rollback
 * keeps its old storedAt, RUNBOOK 5, but gets a new write time). Undefined when neither is a time.
 */
const changedAtFor = (lastModified: string | undefined, current: unknown): string | undefined => {
  for (const candidate of [lastModified, (current as { storedAt?: unknown } | null)?.storedAt]) {
    const ms = typeof candidate === "string" ? Date.parse(candidate) : Number.NaN;
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return undefined;
};

/**
 * UX-33: the outcome push this version also sends, for its "alert" message: one of the outcome push types
 * (shared/pushAudience.ts OUTCOME_PUSH_TYPES; a version stamps at most one). The outcome message then carries the
 * alert's details (`sameVersionAlert`), so userMatcher writes the action's row beside the outcome's in one write, and
 * userNotifier sends each device one of the two (project decision 2026-10-29, "one event, per phone").
 */
const outcomeOf = (types: readonly NotificationType[]): OutcomePushType | undefined =>
  OUTCOME_PUSH_TYPES.find((type) => types.includes(type));

const sendMessagesToQueue = async (messages: OutgoingMessage[]): Promise<number> => {
  if (!QUEUE_URL) throw new Error("Missing env var QUEUE_URL");
  if (!Number.isFinite(QUEUE_BATCH_SIZE) || QUEUE_BATCH_SIZE <= 0) {
    throw new Error("Missing/invalid env var QUEUE_BATCH_SIZE");
  }
  if (messages.length === 0) return 0;

  let enqueued = 0;
  for (let i = 0; i < messages.length; i += QUEUE_BATCH_SIZE) {
    const batch = messages.slice(i, i + QUEUE_BATCH_SIZE);
    const resp = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: QUEUE_URL,
        Entries: batch.map((msg, idx) => ({
          Id: `msg-${i + idx}`,
          MessageBody: JSON.stringify(msg.message),
          ...correlationIdMessageAttributes(msg.correlationId),
        })),
      }),
    );

    const failed = resp.Failed ?? [];
    if (failed.length > 0) {
      for (const f of failed) {
        logger.error("Failed to enqueue notificationType message to SQS", { failure: f });
      }
      throw new Error(`Failed to enqueue ${failed.length} message(s) to SQS`);
    }

    enqueued += resp.Successful ? resp.Successful.length : batch.length;
  }

  return enqueued;
};

type BatchTotals = { scanned: number; enqueued: number; backfillPushSkipped: number };

const processRecord = async (
  record: SQSRecord,
  storage: BillStorage,
  processedRefIds: Set<string>,
  totals: BatchTotals,
): Promise<void> => {
  const refs = extractS3ObjectRefsFromSQSEvent({ Records: [record] }).filter((r) => r.key.endsWith(".json"));

  const outMessages: OutgoingMessage[] = [];
  const refIds: string[] = [];

  for (const ref of refs) {
    const key = ref.key;
    const versionId = ref.versionId;

    if (!key.startsWith(PROCESSED_BILLS_PREFIX)) continue;

    // The same object can appear in more than one record of a batch.
    const refId = `${key}||${versionId ?? ""}`;
    if (processedRefIds.has(refId) || refIds.includes(refId)) continue;
    refIds.push(refId);

    totals.scanned += 1;

    // REL-59: the version the message names and the content version stored just before it, never the latest in its
    // place. A message without one (from a CreateBillsManifest older than REL-59 (2/2), a key that normalization
    // rewrote, or one sent by hand) reads the latest version and the one just before it.
    const { current, previous, currentMetadata, currentLastModified, currentVersionId, previousVersionId } =
      await storage.getLatestAndPreviousJson<BillDoc>(key, versionId);
    // Each drop below acknowledges only this object, as before; the record's other objects go on.
    // Now logged and counted (C1.8). A named version that is no longer stored is not judged at all (REL-59).
    if (!current) {
      reportUnprocessableMessage({
        site: "notificationType.currentMissing",
        reason: versionId ? "version_not_found" : "current_not_found",
        messageId: record.messageId,
        fields: { key, versionId },
      });
      continue;
    }

    const billId = processedBillGuid(key, current.guid) ?? extractBillIdFromKey(key);
    if (!billId) {
      reportUnprocessableMessage({
        site: "notificationType.unresolvedBillId",
        reason: "no_bill_id",
        messageId: record.messageId,
        fields: { key, versionId },
      });
      continue;
    }

    // The writer (billSummarizer or billDiffer) stored the bill's trace id on the object; S3
    // events and the manifest step carry none (OBS-10).
    const correlationId =
      correlationIdFromMetadata(currentMetadata) ?? correlationIdFromRecord(record) ?? mintCorrelationId(billId);

    const types = classifyBill(previous, current);
    // versionId is the version judged and previousVersionId the one it was judged against (none for a "new"); pair
    // says whether the message named the version ("named") or the latest was read ("latest"). RUNBOOK 18.10.
    const pair = versionId ? "named" : "latest";
    logger.info("Classified processed bill", {
      guid: billId,
      correlationId,
      key,
      versionId: currentVersionId,
      previousVersionId,
      pair,
      types,
    });
    if (types.length === 0) continue;

    // REL-56: only the hand-off is skipped; everything above (the read, the classification, its log line) is as for
    // any change, and nothing else here acts on a change.
    if (BACKFILL_PUSH_MODE === "skip" && isRel56BackfillCorrelationId(correlationId)) {
      logger.info("Backfill change; no push sent (REL-56)", {
        guid: billId,
        correlationId,
        key,
        versionId: currentVersionId,
        pair,
        types,
        backfillPushMode: BACKFILL_PUSH_MODE,
      });
      emitEmbeddedMetric(NOTIFICATIONS_METRIC_NAMESPACE, "BackfillPushSkipped", 1);
      totals.backfillPushSkipped += 1;
      continue;
    }

    // The version read, named or not (REL-59): two messages about one version carry one revision, so userMatcher's
    // dedupe marker stops a second push, and a "new" carries its first version's id, which a companion bill's "new"
    // defers to (APPF-23, userMatcher firstStoredRevision).
    const sourceRevision = sourceRevisionFor(currentVersionId, current);
    const alertDetails = types.includes("alert") ? toBillAlertDetails(previous, current) : null;
    const passedDetails = types.includes("passed") ? toBillOutcomeDetails(previous, current, "passed") : null;
    const failedDetails = types.includes("failed") ? toBillOutcomeDetails(previous, current, "failed") : null;
    const changedAt = types.includes("updated") ? changedAtFor(currentLastModified, current) : undefined;
    // UX-33: an action and an outcome of one version are named on each other's message, only together, so the alert
    // is never skipped without the outcome carrying it.
    const sameVersionOutcome = alertDetails ? outcomeOf(types) : undefined;
    for (const t of types) {
      outMessages.push({
        message: {
          domain: "bill",
          objectId: billId,
          notificationType: t,
          sourceRevision,
          ...(t === "alert" && alertDetails ? { alert: alertDetails } : {}),
          ...(t === "alert" && sameVersionOutcome ? { sameVersionOutcome } : {}),
          ...(t === "passed" && passedDetails ? { passed: passedDetails } : {}),
          ...(t === "failed" && failedDetails ? { failed: failedDetails } : {}),
          ...(t === sameVersionOutcome && alertDetails ? { sameVersionAlert: alertDetails } : {}),
          ...(t === "updated" && changedAt ? { changedAt } : {}),
        },
        correlationId,
      });
    }
  }

  totals.enqueued += await sendMessagesToQueue(outMessages);
  for (const refId of refIds) processedRefIds.add(refId);
};

export async function handler(event: SQSEvent, context?: LambdaContextLike): Promise<SQSBatchResponse> {
  logger.resetContext(context);
  if (!BUCKET_NAME) throw new Error("Missing env var BUCKET_NAME");
  if (!QUEUE_URL) throw new Error("Missing env var QUEUE_URL");

  const storage = new BillStorage(s3, BUCKET_NAME);
  const processedRefIds = new Set<string>();
  const totals: BatchTotals = { scanned: 0, enqueued: 0, backfillPushSkipped: 0 };

  // Each record succeeds or fails on its own, so one bad object does not replay the whole batch.
  const response = await processSqsRecords(event, (record) => processRecord(record, storage, processedRefIds, totals), {
    label: "Failed to classify processed bill record",
  });

  logger.info("notificationType batch complete", {
    records: event.Records?.length ?? 0,
    failedRecords: response.batchItemFailures.length,
    ...totals,
  });
  return response;
}
