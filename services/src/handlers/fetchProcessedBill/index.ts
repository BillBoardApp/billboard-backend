import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  activeCompanionPairs,
  BillCompanionDao,
  billCompanionConfigFromEnv,
  type CompanionGroupsState,
} from "../../adapters/billCompanionDao";
import { ProcessedBillDao } from "../../adapters/processedBillDao";
import { isValidProcessedBillGuid } from "../../adapters/processedBillKeys";
import { BillPriorityDao } from "../../adapters/billPriorityDao";
import type { CompanionGroupV1 } from "../../contracts";
import { companionIndex, plainBillGuid, type CompanionIndex } from "../../shared/billCompanions";
import { mergePriorityIntoProcessedBill } from "../../shared/billPriority";
import { isCommemorativeResolution } from "../../shared/commemorativeResolutions";
import { logger } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";

const BUCKET_NAME = process.env.BUCKET_NAME!;
const PRIORITY_TABLE_NAME = process.env.PRIORITY_TABLE_NAME;
const PRIORITY_TABLE_PARTITION_KEY = process.env.PRIORITY_TABLE_PARTITION_KEY ?? "guid";

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const processedBillDao = new ProcessedBillDao(s3, BUCKET_NAME);
const priorityDao = PRIORITY_TABLE_NAME
  ? new BillPriorityDao(ddb, {
      tableName: PRIORITY_TABLE_NAME,
      partitionKey: PRIORITY_TABLE_PARTITION_KEY,
    })
  : null;

// Companion groups (APPF-23): a grouped bill's response (plain or suffixed guid, /processed-bill
// and /public/processed-bill alike) gets `companionGroup`, from the groups PublishBillsManifest
// last published, read at most every 60 s. It is never stored. If the read fails the field is left out.
const COMPANION_GROUPS_MAX_AGE_MS = 60_000;
const COMPANION_METRIC_NAMESPACE = "BillBoard/BillsManifest";
const companionDao = new BillCompanionDao(ddb, billCompanionConfigFromEnv());
let companionIndexFor: { state: CompanionGroupsState | null; index: CompanionIndex } | undefined;

const readCompanionGroup = async (guids: unknown[]): Promise<CompanionGroupV1 | undefined> => {
  const plain = guids.map((guid) => plainBillGuid(guid)).find((guid): guid is string => guid !== null);
  if (!plain) return undefined;
  try {
    const state = await companionDao.getCurrentGroups({ maxAgeMs: COMPANION_GROUPS_MAX_AGE_MS });
    if (companionIndexFor?.state !== state) {
      companionIndexFor = { state, index: companionIndex(activeCompanionPairs(state)) };
    }
    return companionIndexFor.index.get(plain);
  } catch (error) {
    logger.warn("Could not read the companion groups; answering without companionGroup", { error });
    emitEmbeddedMetric(COMPANION_METRIC_NAMESPACE, "CompanionGroupsReadFailed", 1);
    return undefined;
  }
};

// Locator values are interpolated into legacy S3 keys, so they are held to their real shapes.
const CONGRESS_PATTERN = /^\d{1,3}$/;
const BILL_TYPE_PATTERN = /^[a-z][a-z-]{0,39}$/i;
const BILL_NUMBER_PATTERN = /^\d{1,6}$/;

const trimmedParam = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const guid = trimmedParam(event.queryStringParameters?.guid);
  const congress = trimmedParam(event.queryStringParameters?.congress);
  const type = trimmedParam(event.queryStringParameters?.type);
  const billId = trimmedParam(event.queryStringParameters?.bill_id);

  const hasGuid = guid.length > 0;
  const hasValidLocator = CONGRESS_PATTERN.test(congress) && BILL_TYPE_PATTERN.test(type);

  if (!hasGuid && !(congress && type && billId)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing guid, or congress/type/bill_id" }),
    };
  }
  if (hasGuid && !isValidProcessedBillGuid(guid)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid guid" }),
    };
  }
  if (!hasGuid && !(hasValidLocator && BILL_NUMBER_PATTERN.test(billId))) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid congress/type/bill_id" }),
    };
  }

  try {
    // With a valid guid, an unusable locator is ignored rather than rejected: the app sends the
    // manifest's bill type as-is and moves on to its next query shape only after a 404.
    const bill = hasGuid
      ? hasValidLocator
        ? await processedBillDao.getByGuidWithLocator({ congress, billType: type, guid })
        : await processedBillDao.getByGuid(guid)
      : await processedBillDao.get({ congress, billType: type, billNumber: billId });

    if (!bill) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Bill not found" }),
      };
    }

    // A document stored with a text-version suffix is served under its plain guid: the app keys the bill by it.
    const plain = typeof bill.guid === "string" ? { ...bill, guid: plainBillGuid(bill.guid) ?? bill.guid } : bill;
    // A ceremonial resolution is served without topics or life areas, as CreateBillsManifest writes its row (feature
    // review S6; topics since 2026-10-29). 1.1 and 1.2 add the life areas of an opened bill to those its card holds,
    // and take its first topic as the bill's topic (the card's followed-topic tag, Search, the topic groups), so
    // serving the document's would put them back on any device that opens it. The keys stay: both apps decode them as
    // required lists. The stored document keeps both.
    const served = isCommemorativeResolution({
      guid: plain.guid ?? guid,
      billType: plain.identifier?.billType,
      officialTitle: plain.officialTitle,
      title: plain.title,
    })
      ? { ...plain, subCategories: [], lifeAreas: [] }
      : plain;

    const enrichedBill =
      priorityDao && typeof served.guid === "string" && served.guid.trim().length > 0
        ? mergePriorityIntoProcessedBill(served, await priorityDao.getByGuid(served.guid))
        : served;

    const companionGroup = await readCompanionGroup([served.guid, guid]);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(companionGroup ? { ...enrichedBill, companionGroup } : enrichedBill),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 404,
      body: JSON.stringify({ error: "Bill not found" }),
    };
  }
}
