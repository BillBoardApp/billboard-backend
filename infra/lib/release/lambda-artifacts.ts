import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import type {
  LambdaArtifactV1,
  LambdaReleaseManifestV1,
  LambdaRuntimeV1,
  ReleaseGitRefV1,
} from "../../../contracts/generated/ts/release-contracts-v1";

type LoadedManifest = {
  manifest: LambdaReleaseManifestV1;
  byLogicalName: Map<string, LambdaArtifactV1>;
};

const manifestFileRaw = process.env.BILLBOARD_RELEASE_MANIFEST_FILE?.trim();
const releaseIdRaw = process.env.BILLBOARD_RELEASE_ID?.trim();
const strictReleaseMode = process.env.BILLBOARD_STRICT_RELEASE === "true";
let loadedManifest: LoadedManifest | null = null;
const consumedArtifacts = new Set<string>();

const runtimeSet = new Set(["nodejs20.x", "nodejs22.x", "nodejs24.x"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`[release-manifest] Invalid or missing string field '${field}'`);
  }
  return value;
};

const validateReleaseManifest = (value: unknown): LambdaReleaseManifestV1 => {
  if (!isRecord(value)) {
    throw new Error("[release-manifest] Root document must be an object");
  }

  if (value.schemaVersion !== 1) {
    throw new Error("[release-manifest] schemaVersion must equal 1");
  }

  const releaseId = assertString(value.releaseId, "releaseId");
  const createdAt = assertString(value.createdAt, "createdAt");
  const service = assertString(value.service, "service");
  if (service !== "billboard-services") {
    throw new Error(`[release-manifest] service must be 'billboard-services', got '${service}'`);
  }

  if (!isRecord(value.git)) {
    throw new Error("[release-manifest] missing git object");
  }

  const git: ReleaseGitRefV1 = {
    repository: assertString(value.git.repository, "git.repository"),
    commitSha: assertString(value.git.commitSha, "git.commitSha"),
    ...(typeof value.git.branch === "string" && value.git.branch.trim().length > 0 ? { branch: value.git.branch } : {}),
  };

  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    throw new Error("[release-manifest] artifacts must be a non-empty array");
  }

  const artifacts: LambdaArtifactV1[] = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) {
      throw new Error(`[release-manifest] artifacts[${index}] must be an object`);
    }

    const runtime = assertString(artifact.runtime, `artifacts[${index}].runtime`) as LambdaRuntimeV1;
    if (!runtimeSet.has(runtime)) {
      throw new Error(`[release-manifest] artifacts[${index}].runtime has unsupported value '${runtime}'`);
    }

    const sha256 = assertString(artifact.sha256, `artifacts[${index}].sha256`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`[release-manifest] artifacts[${index}].sha256 must be 64-char lowercase hex`);
    }

    const sizeBytes = artifact.sizeBytes;
    if (sizeBytes !== undefined && (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0)) {
      throw new Error(`[release-manifest] artifacts[${index}].sizeBytes must be a positive integer when set`);
    }

    return {
      logicalName: assertString(artifact.logicalName, `artifacts[${index}].logicalName`),
      functionName: assertString(artifact.functionName, `artifacts[${index}].functionName`),
      runtime,
      handler: assertString(artifact.handler, `artifacts[${index}].handler`),
      s3Bucket: assertString(artifact.s3Bucket, `artifacts[${index}].s3Bucket`),
      s3Key: assertString(artifact.s3Key, `artifacts[${index}].s3Key`),
      ...(typeof artifact.s3ObjectVersion === "string" && artifact.s3ObjectVersion.trim().length > 0
        ? { s3ObjectVersion: artifact.s3ObjectVersion }
        : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      sha256,
    };
  });

  return {
    schemaVersion: 1,
    releaseId,
    createdAt,
    service: "billboard-services",
    ...(typeof value.environment === "string" && value.environment.trim().length > 0
      ? { environment: value.environment }
      : {}),
    git,
    artifacts,
  };
};

const loadReleaseManifest = (): LoadedManifest | null => {
  if (!manifestFileRaw) {
    if (strictReleaseMode) {
      throw new Error(
        "[release-manifest] BILLBOARD_STRICT_RELEASE=true requires BILLBOARD_RELEASE_MANIFEST_FILE to be set",
      );
    }
    return null;
  }
  if (loadedManifest) return loadedManifest;

  const resolvedPath = path.resolve(process.cwd(), manifestFileRaw);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`[release-manifest] file not found: ${resolvedPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  const manifest = validateReleaseManifest(parsed);

  if (releaseIdRaw && releaseIdRaw !== manifest.releaseId) {
    throw new Error(
      `[release-manifest] releaseId mismatch: BILLBOARD_RELEASE_ID='${releaseIdRaw}' but manifest.releaseId='${manifest.releaseId}'`,
    );
  }

  const byLogicalName = new Map<string, LambdaArtifactV1>();
  const byFunctionName = new Map<string, LambdaArtifactV1>();

  for (const artifact of manifest.artifacts) {
    if (byLogicalName.has(artifact.logicalName)) {
      throw new Error(`[release-manifest] duplicate logicalName '${artifact.logicalName}'`);
    }
    if (byFunctionName.has(artifact.functionName)) {
      throw new Error(`[release-manifest] duplicate functionName '${artifact.functionName}'`);
    }
    byLogicalName.set(artifact.logicalName, artifact);
    byFunctionName.set(artifact.functionName, artifact);
  }

  loadedManifest = { manifest, byLogicalName };
  return loadedManifest;
};

const getLoadedManifest = (): LoadedManifest | null => loadReleaseManifest();

export const lambdaCodeFromRelease = (
  bucket: s3.IBucket,
  logicalName: string,
  defaultKey: string,
): lambda.Code => {
  const loaded = getLoadedManifest();
  if (!loaded) {
    if (strictReleaseMode) {
      throw new Error(
        `[release-manifest] strict mode requires artifact '${logicalName}' in manifest; fallback key '${defaultKey}' not allowed`,
      );
    }
    return lambda.Code.fromBucket(bucket, defaultKey);
  }

  const artifact = loaded.byLogicalName.get(logicalName);
  if (!artifact) {
    throw new Error(
      `[release-manifest] missing artifact for logicalName='${logicalName}' (fallback '${defaultKey}' disabled in release mode)`,
    );
  }

  const bucketName = bucket.bucketName;
  if (!cdk.Token.isUnresolved(bucketName) && bucketName !== artifact.s3Bucket) {
    throw new Error(
      `[release-manifest] bucket mismatch for '${logicalName}': stack bucket='${bucketName}', manifest bucket='${artifact.s3Bucket}'`,
    );
  }

  consumedArtifacts.add(logicalName);
  return lambda.Code.fromBucket(bucket, artifact.s3Key, artifact.s3ObjectVersion);
};

export const assertReleaseManifestFullyConsumed = (): void => {
  const loaded = getLoadedManifest();
  if (!loaded) return;

  const unresolved = loaded.manifest.artifacts
    .map((artifact) => artifact.logicalName)
    .filter((logicalName) => !consumedArtifacts.has(logicalName));

  if (unresolved.length > 0) {
    throw new Error(
      `[release-manifest] unused artifact entries: ${unresolved.sort().join(", ")}. ` +
        `Infra did not reference these logical names during synth.`,
    );
  }
};

export const getReleaseManifestMetadata = (): { enabled: boolean; releaseId?: string; artifactCount?: number } => {
  const loaded = getLoadedManifest();
  if (!loaded) return { enabled: false };

  return {
    enabled: true,
    releaseId: loaded.manifest.releaseId,
    artifactCount: loaded.manifest.artifacts.length,
  };
};
