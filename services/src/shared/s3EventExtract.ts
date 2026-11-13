import type { SQSEvent, SQSRecord, S3EventRecord } from "aws-lambda";

type S3ObjectRef = {
  key: string;
  versionId?: string;
};

const decodeS3Key = (key: string): string => {
  return decodeURIComponent(key.replace(/\+/g, " "));
};

const unwrapToS3Records = (value: unknown): S3EventRecord[] => {
  if (!value || typeof value !== "object") {
    return [];
  }

  const candidate = value as { Records?: unknown; records?: unknown; Message?: unknown };

  if (Array.isArray(candidate.Records)) {
    return candidate.Records as S3EventRecord[];
  }

  if (Array.isArray(candidate.records)) {
    return candidate.records as S3EventRecord[];
  }

  if (typeof candidate.Message === "string") {
    try {
      return unwrapToS3Records(JSON.parse(candidate.Message));
    } catch {
      return [];
    }
  }

  return [];
};

const parseRecordBodyJson = (record: SQSRecord): unknown => {
  if (!record.body) return null;
  try {
    return JSON.parse(record.body);
  } catch {
    return null;
  }
};

export const extractS3ObjectRefsFromSQSEvent = (event: SQSEvent): S3ObjectRef[] => {
  const refs: S3ObjectRef[] = [];

  for (const record of event.Records ?? []) {
    const payload = parseRecordBodyJson(record);
    const s3Records = unwrapToS3Records(payload ?? record);

    for (const s3r of s3Records) {
      const encodedKey = s3r?.s3?.object?.key;
      if (!encodedKey) continue;

      const key = decodeS3Key(String(encodedKey));
      const versionId = s3r?.s3?.object?.versionId;
      refs.push({ key, ...(typeof versionId === "string" && versionId.length > 0 ? { versionId } : {}) });
    }
  }

  // Dedupe (key+versionId). If versionId is absent, treat all as same.
  const seen = new Set<string>();
  const deduped: S3ObjectRef[] = [];
  for (const r of refs) {
    const id = `${r.key}||${r.versionId ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(r);
  }

  return deduped;
};
