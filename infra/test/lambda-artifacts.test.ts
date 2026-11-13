/**
 * Strict-mode error paths of lib/release/lambda-artifacts.ts, the guard that
 * stops a production synth from silently falling back to "latest" zips.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { LambdaArtifactV1, LambdaReleaseManifestV1 } from '../../contracts/generated/ts/release-contracts-v1';
import { LAMBDA_ARTIFACTS_BUCKET_NAME } from '../lib/config/deployment-identity';

type ReleaseModule = typeof import('../lib/release/lambda-artifacts');

const ENV_KEYS = [
  'BILLBOARD_RELEASE_MANIFEST_FILE',
  'BILLBOARD_RELEASE_ID',
  'BILLBOARD_STRICT_RELEASE',
] as const;
type ReleaseEnv = Partial<Record<(typeof ENV_KEYS)[number], string>>;

const BUCKET_NAME = LAMBDA_ARTIFACTS_BUCKET_NAME;
const RELEASE_ID = 'services-20260924-abc1234';
const SHA256 = 'a'.repeat(64);

const artifact = (logicalName: string): LambdaArtifactV1 => ({
  logicalName,
  functionName: logicalName,
  runtime: 'nodejs24.x',
  handler: 'dist/index.handler',
  s3Bucket: BUCKET_NAME,
  s3Key: `artifacts/${logicalName}/${SHA256}.zip`,
  releaseS3Key: `releases/${RELEASE_ID}/${logicalName}.zip`,
  sha256: SHA256,
});

const manifest = (artifacts: LambdaArtifactV1[]): LambdaReleaseManifestV1 => ({
  schemaVersion: 1,
  releaseId: RELEASE_ID,
  createdAt: '2026-09-24T00:00:00.000Z',
  service: 'billboard-services',
  git: { repository: 'BillBoardApp/billboard-services', commitSha: 'abc1234' },
  artifacts,
});

let tmpDir: string;
let savedEnv: ReleaseEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-manifest-'));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeManifest = (value: unknown): string => {
  const file = path.join(tmpDir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

// The module reads its environment and caches the manifest at import time, so
// every case loads a fresh copy under its own environment.
const loadReleaseModule = (env: ReleaseEnv): ReleaseModule => {
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  let loaded: ReleaseModule | undefined;
  jest.isolateModules(() => {
    loaded = require('../lib/release/lambda-artifacts') as ReleaseModule;
  });
  if (!loaded) {
    throw new Error('lambda-artifacts module did not load');
  }
  return loaded;
};

const strictEnv = (manifestFile: string): ReleaseEnv => ({
  BILLBOARD_STRICT_RELEASE: 'true',
  BILLBOARD_RELEASE_ID: RELEASE_ID,
  BILLBOARD_RELEASE_MANIFEST_FILE: manifestFile,
});

const artifactsBucket = (): s3.IBucket =>
  s3.Bucket.fromBucketName(new cdk.Stack(), 'Artifacts', BUCKET_NAME);

describe('release manifest strict mode', () => {
  test('uses the manifest s3Key for a known artifact', () => {
    const release = loadReleaseModule(strictEnv(writeManifest(manifest([artifact('fnA')]))));

    const code = release.lambdaCodeFromRelease(artifactsBucket(), 'fnA', 'fnA.zip');
    const config = code.bind(new cdk.Stack());

    expect(config.s3Location).toEqual(expect.objectContaining({
      bucketName: BUCKET_NAME,
      objectKey: `artifacts/fnA/${SHA256}.zip`,
    }));
    expect(() => release.assertReleaseManifestFullyConsumed()).not.toThrow();
  });

  test('fails when no manifest file is configured', () => {
    const release = loadReleaseModule({ BILLBOARD_STRICT_RELEASE: 'true' });

    expect(() => release.lambdaCodeFromRelease(artifactsBucket(), 'fnA', 'fnA.zip'))
      .toThrow(/BILLBOARD_STRICT_RELEASE=true requires BILLBOARD_RELEASE_MANIFEST_FILE/);
  });

  test('fails when the manifest file is missing', () => {
    const missingFile = path.join(tmpDir, 'missing.json');
    const release = loadReleaseModule(strictEnv(missingFile));

    expect(() => release.lambdaCodeFromRelease(artifactsBucket(), 'fnA', 'fnA.zip'))
      .toThrow(`[release-manifest] file not found: ${missingFile}`);
  });

  test('fails when a manifest artifact is never consumed during synth', () => {
    const release = loadReleaseModule(
      strictEnv(writeManifest(manifest([artifact('fnA'), artifact('fnB'), artifact('fnC')]))),
    );

    release.lambdaCodeFromRelease(artifactsBucket(), 'fnB', 'fnB.zip');

    expect(() => release.assertReleaseManifestFullyConsumed())
      .toThrow('[release-manifest] unused artifact entries: fnA, fnC.');
  });

  test('fails for a logical name the manifest does not contain', () => {
    const release = loadReleaseModule(strictEnv(writeManifest(manifest([artifact('fnA')]))));

    expect(() => release.lambdaCodeFromRelease(artifactsBucket(), 'fnUnknown', 'fnUnknown.zip'))
      .toThrow("[release-manifest] missing artifact for logicalName='fnUnknown'");
  });

  test('fails when an artifact declares a runtime outside the contract', () => {
    const release = loadReleaseModule(strictEnv(writeManifest({
      ...manifest([]),
      artifacts: [{ ...artifact('fnA'), runtime: 'nodejs18.x' }],
    })));

    expect(() => release.lambdaCodeFromRelease(artifactsBucket(), 'fnA', 'fnA.zip'))
      .toThrow("[release-manifest] artifacts[0].runtime has unsupported value 'nodejs18.x'");
  });

  test('fails when the manifest belongs to a different release', () => {
    const release = loadReleaseModule({
      ...strictEnv(writeManifest(manifest([artifact('fnA')]))),
      BILLBOARD_RELEASE_ID: 'services-20260101-0000000',
    });

    expect(() => release.lambdaCodeFromRelease(artifactsBucket(), 'fnA', 'fnA.zip'))
      .toThrow(/releaseId mismatch/);
  });
});
