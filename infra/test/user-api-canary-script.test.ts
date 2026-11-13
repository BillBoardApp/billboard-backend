/**
 * C1.9: the Synthetics canary's script (lib/canaries/user-api-canary.js), run with the Synthetics runtime,
 * the AWS SDK clients and `https` replaced by fakes.
 *
 * - Without the smoke-test secret name only `health` and `api-up` run.
 * - With it, the canary follows the R1 app's bills path: GET /bills-manifest?delivery=snapshot must answer
 *   with a pointer (an inline manifest fails the run), then the presigned snapshot is downloaded with no
 *   headers, gunzipped when stored gzip, and must hold exactly the pointer's count of bills.
 * - The presigned URL (signature and session token) never appears in an error or in console output.
 * - The two blind manifest-age metrics are gone; WeeklyDigestAgeSeconds is still emitted.
 * - A sign-in that cannot happen because of the test account or its secret (an unreadable secret, bad JSON, wrong keys, a
 *   challenge, a refused password) does not fail the run: the canary skips the signed-in steps and emits
 *   CanarySmokeSignInFailed, which has a notify-only alarm. A failure of a signed-in step still fails the run.
 */
import { EventEmitter } from 'node:events';
import * as zlib from 'node:zlib';
import { USER_API_CANARY_SCRIPT_PATH } from '../lib/constructs/user-api-canary';

type HttpReply = { status: number; body?: string; headers?: Record<string, string> };
type SnapshotReply =
  | { status: number; body: Buffer; headers?: Record<string, string> }
  | { error: { code: string; message: string } };

interface CanaryFakes {
  httpReplies: Record<string, HttpReply>;
  httpSteps: Array<{ stepName: string; options: Record<string, any>; stepConfig: unknown; arity: number }>;
  executedSteps: Array<{ stepName: string; stepConfig: unknown }>;
  secrets: Record<string, string>;
  metrics: Array<Record<string, any>>;
  snapshot: SnapshotReply;
  httpsGets: unknown[][];
  /** Set to make GetSecretValue fail with an AWS-style error of this name. */
  secretError?: { name: string; message: string };
  /** What InitiateAuth answers: a reply, or an AWS-style error to throw. */
  cognito: { reply?: Record<string, unknown>; error?: { name: string; message: string } };
  /** Set to make PutMetricData fail. */
  metricError?: Error;
}

// jest.mock factories may only reach variables whose names start with "mock".
const mockFakes: CanaryFakes = {
  httpReplies: {},
  httpSteps: [],
  executedSteps: [],
  secrets: {},
  metrics: [],
  snapshot: { status: 200, body: Buffer.from('{}') },
  httpsGets: [],
  secretError: undefined,
  cognito: {},
  metricError: undefined,
};

const mockAwsError = (error: { name: string; message: string }): Error =>
  Object.assign(new Error(error.message), { name: error.name });

const mockEmitResponse = (res: EventEmitter, body: Buffer | string | undefined): void => {
  setImmediate(() => {
    if (body !== undefined && body.length > 0) res.emit('data', body);
    res.emit('end');
  });
};

jest.mock(
  '@aws/synthetics-puppeteer',
  () => ({
    executeHttpStep: jest.fn(async (...args: any[]) => {
      const [stepName, options, callback, stepConfig] = args;
      mockFakes.httpSteps.push({ stepName, options, stepConfig, arity: args.length });
      const reply = mockFakes.httpReplies[stepName] ?? { status: 200, body: '{}' };
      const res = Object.assign(new EventEmitter(), { statusCode: reply.status, headers: reply.headers ?? {} });
      mockEmitResponse(res, reply.body);
      return callback(res);
    }),
    executeStep: jest.fn(async (stepName: string, fn: () => Promise<unknown>, stepConfig: unknown) => {
      mockFakes.executedSteps.push({ stepName, stepConfig });
      return fn();
    }),
  }),
  { virtual: true },
);

jest.mock(
  '@aws-sdk/client-secrets-manager',
  () => ({
    SecretsManagerClient: class {
      async send(command: { input: { SecretId: string } }) {
        if (mockFakes.secretError) throw mockAwsError(mockFakes.secretError);
        const value = mockFakes.secrets[command.input.SecretId];
        if (value === undefined) throw new Error(`no fake secret ${command.input.SecretId}`);
        return { SecretString: value };
      }
    },
    GetSecretValueCommand: class {
      constructor(public readonly input: unknown) {}
    },
  }),
  { virtual: true },
);

jest.mock(
  '@aws-sdk/client-cognito-identity-provider',
  () => ({
    CognitoIdentityProviderClient: class {
      async send() {
        if (mockFakes.cognito.error) throw mockAwsError(mockFakes.cognito.error);
        return mockFakes.cognito.reply ?? { AuthenticationResult: { IdToken: 'fake-id-token' } };
      }
    },
    InitiateAuthCommand: class {
      constructor(public readonly input: unknown) {}
    },
  }),
  { virtual: true },
);

jest.mock(
  '@aws-sdk/client-cloudwatch',
  () => ({
    CloudWatchClient: class {
      async send(command: { input: Record<string, any> }) {
        if (mockFakes.metricError) throw mockFakes.metricError;
        mockFakes.metrics.push(command.input);
        return {};
      }
    },
    PutMetricDataCommand: class {
      constructor(public readonly input: unknown) {}
    },
  }),
  { virtual: true },
);

jest.mock('https', () => ({
  get: jest.fn((...args: any[]) => {
    mockFakes.httpsGets.push(args);
    const callback = args[args.length - 1] as (res: EventEmitter) => void;
    const request = Object.assign(new EventEmitter(), {
      setTimeout: jest.fn(),
      destroy: jest.fn(),
    });
    const reply = mockFakes.snapshot;
    setImmediate(() => {
      if ('error' in reply) {
        request.emit('error', Object.assign(new Error(reply.error.message), { code: reply.error.code }));
        return;
      }
      const res = Object.assign(new EventEmitter(), { statusCode: reply.status, headers: reply.headers ?? {} });
      callback(res);
      mockEmitResponse(res, reply.body);
    });
    return request;
  }),
}));

// ── fixtures ──────────────────────────────────────────────────────────────────

const SIGNATURE = 'SECRETSIGNATUREabc123';
const SESSION_TOKEN = 'SECRETSESSIONTOKENxyz789';
const SNAPSHOT_HOST = 'billboard-manifest-snapshot.s3.us-east-1.amazonaws.com';
const SNAPSHOT_URL = `https://${SNAPSHOT_HOST}/bills/manifest-v1.json?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Security-Token=${SESSION_TOKEN}&X-Amz-Signature=${SIGNATURE}`;
const SECRET_FRAGMENTS = [SIGNATURE, SESSION_TOKEN, 'manifest-v1.json?', 'X-Amz-'];

const pointerBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    snapshotUrl: SNAPSHOT_URL,
    generatedAt: '2026-10-07T12:00:00.000Z',
    count: 2,
    expiresAt: '2026-10-07T12:05:00.000Z',
    ...overrides,
  });

const snapshotJson = (bills: Array<{ guid: string }>): string =>
  JSON.stringify({ generatedAt: '2026-10-07T12:00:00.000Z', count: bills.length, bills });

const TWO_BILLS = [{ guid: 'BILLS-119hr1' }, { guid: 'BILLS-119hr2' }];

const gzipSnapshot = (bills = TWO_BILLS): SnapshotReply => ({
  status: 200,
  headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
  body: zlib.gzipSync(snapshotJson(bills)),
});

const authenticatedReplies = (overrides: Record<string, HttpReply> = {}): Record<string, HttpReply> => ({
  health: { status: 200, body: JSON.stringify({ status: 'ok' }) },
  'api-up': { status: 401, body: '{"message":"Unauthorized"}' },
  'auth-me': { status: 200, body: JSON.stringify({ userId: 'smoke-user' }) },
  'auth-bills-manifest-pointer': { status: 200, body: pointerBody() },
  'auth-processed-bill': { status: 200, body: JSON.stringify({ guid: 'BILLS-119hr1' }) },
  'auth-congress-members-manifest': { status: 200, body: JSON.stringify({ members: [{ bioguideId: 'A000001' }] }) },
  'auth-processed-congress-member': { status: 200, body: JSON.stringify({ member: { bioguideId: 'A000001' } }) },
  'auth-latest-weekly-digest': { status: 204 },
  ...overrides,
});

const CANARY_ENV = {
  API_URL: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/',
  USER_POOL_CLIENT_ID: 'client-id',
  SMOKE_TEST_FIXTURES_SECRET_NAME: '',
  SMOKE_TEST_WRITE_CHECKS: 'false',
  MAX_WEEKLY_DIGEST_AGE_SECONDS: '691200',
};

let consoleOutput: string[] = [];
const savedEnv = { ...process.env };

beforeEach(() => {
  mockFakes.httpReplies = authenticatedReplies();
  mockFakes.httpSteps = [];
  mockFakes.executedSteps = [];
  mockFakes.secrets = {
    'Billboard/CanarySmokeTestCredentials': JSON.stringify({ username: 'smoke@example.com', password: 'fake-password' }),
  };
  mockFakes.metrics = [];
  mockFakes.snapshot = gzipSnapshot();
  mockFakes.httpsGets = [];
  mockFakes.secretError = undefined;
  mockFakes.cognito = {};
  mockFakes.metricError = undefined;
  consoleOutput = [];
  (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((level) =>
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(' '));
    }),
  );
  process.env = { ...savedEnv, ...CANARY_ENV, SMOKE_TEST_SECRET_NAME: 'Billboard/CanarySmokeTestCredentials' };
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...savedEnv };
});

/** Loads the script fresh (it reads its clients at load) and runs its handler. */
const runCanary = async (): Promise<void> => {
  let handler: (() => Promise<void>) | undefined;
  jest.isolateModules(() => {
    handler = require(USER_API_CANARY_SCRIPT_PATH).handler;
  });
  await handler!();
};

const stepNames = (): string[] => mockFakes.httpSteps.map((step) => step.stepName);
const stepPath = (stepName: string): string | undefined =>
  mockFakes.httpSteps.find((step) => step.stepName === stepName)?.options.path;
const metricNames = (): string[] =>
  mockFakes.metrics.flatMap((input) => (input.MetricData as Array<{ MetricName: string }>).map((datum) => datum.MetricName));

/** Runs the canary, expects it to fail, and returns the error message. */
const failure = async (): Promise<string> => {
  let message: string | undefined;
  try {
    await runCanary();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBeDefined();
  return message!;
};

const expectNoSecretIn = (text: string): void => {
  SECRET_FRAGMENTS.forEach((fragment) => expect({ fragment, leaked: text.includes(fragment) }).toEqual({ fragment, leaked: false }));
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('canary without the smoke-test secret name', () => {
  test('runs only health and api-up, and signs in, downloads and emits nothing', async () => {
    process.env.SMOKE_TEST_SECRET_NAME = '';
    await runCanary();
    expect(stepNames()).toEqual(['health', 'api-up']);
    expect(stepPath('api-up')).toBe('/prod/bills-manifest');
    expect(mockFakes.executedSteps).toEqual([]);
    expect(mockFakes.httpsGets).toEqual([]);
    expect(mockFakes.metrics).toEqual([]);
    expect(consoleOutput.join('\n')).toContain('authenticated smoke checks skipped');
  });
});

describe('canary on the snapshot path (C1.9)', () => {
  test('a pointer and a gzip snapshot pass, and the bill guid comes from the snapshot', async () => {
    await runCanary();

    expect(stepNames()).toEqual([
      'health',
      'api-up',
      'auth-me',
      'auth-bills-manifest-pointer',
      'auth-processed-bill',
      'auth-congress-members-manifest',
      'auth-processed-congress-member',
      'auth-latest-weekly-digest',
    ]);
    // The app's own request: the pointer, with the bearer token.
    const pointerStep = mockFakes.httpSteps.find((step) => step.stepName === 'auth-bills-manifest-pointer')!;
    expect(pointerStep.options.path).toBe('/prod/bills-manifest?delivery=snapshot');
    expect(pointerStep.options.headers.Authorization).toBe('Bearer fake-id-token');
    // The pointer's body holds the presigned URL, so it stays out of the Synthetics HTTP report.
    expect(pointerStep.stepConfig).toEqual({ includeResponseBody: false });
    expect(pointerStep.arity).toBe(4);
    // Every other step calls executeHttpStep exactly as before (three arguments).
    mockFakes.httpSteps
      .filter((step) => step.stepName !== 'auth-bills-manifest-pointer')
      .forEach((step) => expect({ step: step.stepName, arity: step.arity }).toEqual({ step: step.stepName, arity: 3 }));

    // The download is a plain step, not an HTTP step, with no screenshots.
    expect(mockFakes.executedSteps).toEqual([
      {
        stepName: 'auth-bills-manifest-snapshot',
        stepConfig: { screenshotOnStepStart: false, screenshotOnStepSuccess: false, screenshotOnStepFailure: false },
      },
    ]);
    // A GET of the presigned URL with no headers, as the app does.
    expect(mockFakes.httpsGets).toHaveLength(1);
    expect(mockFakes.httpsGets[0]).toEqual([SNAPSHOT_URL, expect.any(Function)]);

    expect(stepPath('auth-processed-bill')).toBe('/prod/processed-bill?guid=BILLS-119hr1');
    expectNoSecretIn(consoleOutput.join('\n'));
  });

  test('an uncompressed snapshot passes too', async () => {
    mockFakes.snapshot = { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(snapshotJson(TWO_BILLS)) };
    await runCanary();
    expect(stepPath('auth-processed-bill')).toBe('/prod/processed-bill?guid=BILLS-119hr1');
  });

  test('a bill guid fixture still wins over the snapshot', async () => {
    process.env.SMOKE_TEST_FIXTURES_SECRET_NAME = 'Billboard/CanarySmokeTestFixtures';
    mockFakes.secrets['Billboard/CanarySmokeTestFixtures'] = JSON.stringify({ billGuid: 'BILLS-119s5' });
    await runCanary();
    expect(stepPath('auth-processed-bill')).toBe('/prod/processed-bill?guid=BILLS-119s5');
  });

  test('an inline manifest instead of a pointer fails the run with the named message', async () => {
    mockFakes.httpReplies['auth-bills-manifest-pointer'] = {
      status: 200,
      body: JSON.stringify({ generatedAt: '2026-10-07T12:00:00.000Z', count: 2, bills: TWO_BILLS }),
    };
    expect(await failure()).toBe(
      'auth-bills-manifest-pointer: snapshot pointer not served; FetchBillsManifest fell back to the inline manifest',
    );
    expect(mockFakes.executedSteps).toEqual([]);
    expect(stepNames()).not.toContain('auth-processed-bill');
  });

  test.each([
    ['a non-https URL', { snapshotUrl: 'http://example.com/x' }, 'snapshotUrl is missing or not an https URL'],
    ['no URL', { snapshotUrl: undefined }, 'snapshotUrl is missing or not an https URL'],
    ['a bad generatedAt', { generatedAt: 'yesterday' }, 'generatedAt is missing or not an ISO time'],
    ['a zero count', { count: 0 }, 'count is not a positive integer'],
    ['a fractional count', { count: 1.5 }, 'count is not a positive integer'],
    ['no expiresAt', { expiresAt: undefined }, 'expiresAt is missing or not an ISO time'],
  ])('a pointer with %s fails', async (_case, overrides, reason) => {
    mockFakes.httpReplies['auth-bills-manifest-pointer'] = { status: 200, body: pointerBody(overrides) };
    expect(await failure()).toBe(`auth-bills-manifest-pointer: ${reason}`);
    expect(mockFakes.httpsGets).toEqual([]);
  });

  test('a pointer request that does not answer 200 fails', async () => {
    mockFakes.httpReplies['auth-bills-manifest-pointer'] = { status: 500, body: '{"error":"Internal server error"}' };
    expect(await failure()).toBe('auth-bills-manifest-pointer: expected 200, got 500');
  });

  test('a snapshot whose bill count differs from the pointer fails', async () => {
    mockFakes.httpReplies['auth-bills-manifest-pointer'] = { status: 200, body: pointerBody({ count: 3 }) };
    expect(await failure()).toBe('auth-bills-manifest-snapshot: snapshot has 2 bills but the pointer count is 3');
  });

  test('an empty snapshot fails', async () => {
    mockFakes.snapshot = gzipSnapshot([]);
    expect(await failure()).toBe('auth-bills-manifest-snapshot: expected non-empty bills array');
  });

  test('a snapshot 403 fails, naming the status and host only', async () => {
    mockFakes.snapshot = {
      status: 403,
      headers: { 'content-type': 'application/xml' },
      // S3's error body can echo the signed request; it must never surface.
      body: Buffer.from(`<Error><Code>AccessDenied</Code><StringToSign>${SNAPSHOT_URL}</StringToSign></Error>`),
    };
    const message = await failure();
    expect(message).toBe(`auth-bills-manifest-snapshot: expected 200, got 403 from ${SNAPSHOT_HOST}`);
    expect(stepNames()).not.toContain('auth-processed-bill');
  });

  test('a body marked gzip that does not decompress fails without the URL', async () => {
    mockFakes.snapshot = { status: 200, headers: { 'content-encoding': 'gzip' }, body: Buffer.from(snapshotJson(TWO_BILLS)) };
    expect(await failure()).toBe('auth-bills-manifest-snapshot: the snapshot is marked gzip but does not decompress');
  });

  test('a network error fails with its code and host, not its message', async () => {
    mockFakes.snapshot = { error: { code: 'ECONNRESET', message: `socket hang up while fetching ${SNAPSHOT_URL}` } };
    expect(await failure()).toBe(`auth-bills-manifest-snapshot: request failed (ECONNRESET) from ${SNAPSHOT_HOST}`);
  });

  test('the presigned URL never appears in an error or in console output', async () => {
    const failures: Array<() => void> = [
      () => { mockFakes.snapshot = { status: 403, body: Buffer.from(SNAPSHOT_URL) }; },
      () => { mockFakes.snapshot = { status: 200, headers: { 'content-encoding': 'gzip' }, body: Buffer.from(SNAPSHOT_URL) }; },
      () => { mockFakes.snapshot = { status: 200, body: Buffer.from(`not json ${SNAPSHOT_URL}`) }; },
      () => { mockFakes.snapshot = { error: { code: 'ETIMEDOUT', message: SNAPSHOT_URL } }; },
      () => { mockFakes.httpReplies['auth-bills-manifest-pointer'] = { status: 200, body: pointerBody({ count: 9 }) }; },
    ];
    for (const arrange of failures) {
      mockFakes.httpReplies = authenticatedReplies();
      mockFakes.snapshot = gzipSnapshot();
      arrange();
      expectNoSecretIn(await failure());
    }
    expectNoSecretIn(consoleOutput.join('\n'));
  });
});

describe('product health metrics after C1.9', () => {
  test('emits no manifest age metric', async () => {
    await runCanary();
    expect(metricNames()).toEqual([]);
  });

  test('still emits WeeklyDigestAgeSeconds when a digest is returned, and only that', async () => {
    mockFakes.httpReplies['auth-latest-weekly-digest'] = {
      status: 200,
      body: JSON.stringify({ publishedAt: new Date(Date.now() - 3600 * 1000).toISOString() }),
    };
    await runCanary();
    expect(metricNames()).toEqual(['WeeklyDigestAgeSeconds']);
    expect(mockFakes.metrics[0]).toEqual({
      Namespace: 'BillBoard/ProductHealth',
      MetricData: [{ MetricName: 'WeeklyDigestAgeSeconds', Unit: 'Seconds', Value: expect.any(Number) }],
    });
    expect(mockFakes.metrics[0].MetricData[0].Value).toBeGreaterThanOrEqual(3599);
  });

  test('a stale digest still fails the run after emitting its age', async () => {
    mockFakes.httpReplies['auth-latest-weekly-digest'] = {
      status: 200,
      body: JSON.stringify({ publishedAt: new Date(Date.now() - 9 * 86400 * 1000).toISOString() }),
    };
    expect(await failure()).toMatch(/^auth-latest-weekly-digest: freshness age \d+s exceeded 691200s$/);
    expect(metricNames()).toEqual(['WeeklyDigestAgeSeconds']);
  });

  test('the write checks stay off unless enabled', async () => {
    await runCanary();
    expect(mockFakes.httpSteps.map((step) => step.options.method)).toEqual(Array(8).fill('GET'));
  });
});

// The sign-in is the one signed-in step that depends on things kept by hand (the secret and the test
// account), not on the API. When it cannot happen, the run must not fail: a failed run lowers SuccessPercent,
// which is a member of Billboard-Page-AppBroken and of every API deployment group's alarm. The canary says so with
// CanarySmokeSignInFailed instead (a notify-only alarm in MonitoringStack).
describe('a sign-in the test account or its secret cannot complete does not fail the run', () => {
  const FAILED_METRIC = {
    Namespace: 'BillBoard/ProductHealth',
    MetricData: [{ MetricName: 'CanarySmokeSignInFailed', Unit: 'Count', Value: 1 }],
  };
  const SECRET_VALUE_FRAGMENTS = ['smoke@example.com', 'fake-password'];

  /** Runs to the end, then checks the run passed with only the unauthenticated steps and said so. */
  const expectSkippedSignIn = async (): Promise<void> => {
    await runCanary();
    expect(stepNames()).toEqual(['health', 'api-up']);
    expect(mockFakes.executedSteps).toEqual([]);
    expect(mockFakes.httpsGets).toEqual([]);
    expect(mockFakes.metrics).toEqual([FAILED_METRIC]);
    expect(consoleOutput.join('\n')).toContain('authenticated smoke checks skipped');
  };

  const expectNoCredentialsIn = (text: string): void =>
    SECRET_VALUE_FRAGMENTS.forEach((fragment) => expect({ fragment, leaked: text.includes(fragment) }).toEqual({ fragment, leaked: false }));

  test.each(['ResourceNotFoundException', 'AccessDeniedException', 'DecryptionFailure', 'InvalidRequestException'])(
    'a secret read that fails with %s',
    async (name) => {
      mockFakes.secretError = { name, message: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:Billboard/CanarySmokeTestCredentials-AbCdEf' };
      await expectSkippedSignIn();
      const output = consoleOutput.join('\n');
      expect(output).toContain(name);
      // The AWS message names the secret's ARN; only the error class is logged.
      expect(output).not.toContain('123456789012');
    },
  );

  test('a secret that is not JSON', async () => {
    mockFakes.secrets['Billboard/CanarySmokeTestCredentials'] = 'smoke@example.com:fake-password';
    await expectSkippedSignIn();
    expectNoCredentialsIn(consoleOutput.join('\n'));
  });

  test.each([
    ['capitalised keys, as the console key/value editor can leave them', { Username: 'smoke@example.com', Password: 'fake-password' }],
    ['no password', { username: 'smoke@example.com' }],
    ['no username or email', { password: 'fake-password' }],
    ['an empty password', { username: 'smoke@example.com', password: '' }],
    ['a password that is not a string', { username: 'smoke@example.com', password: 12345678 }],
    ['an empty object', {}],
  ])('a secret with %s', async (_case, credentials) => {
    mockFakes.secrets['Billboard/CanarySmokeTestCredentials'] = JSON.stringify(credentials);
    await expectSkippedSignIn();
    expectNoCredentialsIn(consoleOutput.join('\n'));
  });

  test.each([['null', 'null'], ['a string', '"smoke@example.com"'], ['an array', '[]']])(
    'a secret that is JSON but %s',
    async (_case, raw) => {
      mockFakes.secrets['Billboard/CanarySmokeTestCredentials'] = raw;
      await expectSkippedSignIn();
    },
  );

  test('the email key still stands in for username', async () => {
    mockFakes.secrets['Billboard/CanarySmokeTestCredentials'] = JSON.stringify({ email: 'smoke@example.com', password: 'fake-password' });
    await runCanary();
    expect(stepNames()).toContain('auth-me');
    expect(metricNames()).toEqual([]);
  });

  test.each(['SOFTWARE_TOKEN_MFA', 'NEW_PASSWORD_REQUIRED', 'MFA_SETUP'])('a %s challenge instead of tokens', async (challenge) => {
    mockFakes.cognito = { reply: { ChallengeName: challenge, Session: 'SECRETSESSIONabc', ChallengeParameters: {} } };
    await expectSkippedSignIn();
    const output = consoleOutput.join('\n');
    expect(output).toContain(challenge);
    expect(output).not.toContain('SECRETSESSIONabc');
  });

  test('a reply with no tokens and no challenge', async () => {
    mockFakes.cognito = { reply: {} };
    await expectSkippedSignIn();
  });

  test('a reply whose AuthenticationResult has no id token', async () => {
    mockFakes.cognito = { reply: { AuthenticationResult: { AccessToken: 'only-an-access-token' } } };
    await expectSkippedSignIn();
    expect(consoleOutput.join('\n')).not.toContain('only-an-access-token');
  });

  test.each([
    'NotAuthorizedException',
    'PasswordResetRequiredException',
    'UserNotFoundException',
    'UserNotConfirmedException',
  ])('Cognito refusing the account with %s', async (name) => {
    mockFakes.cognito = { error: { name, message: 'Incorrect username or password for smoke@example.com' } };
    await expectSkippedSignIn();
    const output = consoleOutput.join('\n');
    expect(output).toContain(name);
    expectNoCredentialsIn(output);
  });

  test.each(['InternalErrorException', 'TooManyRequestsException', 'InvalidParameterException', 'TimeoutError'])(
    'a Cognito failure of a different kind (%s) still fails the run, and says nothing about the account',
    async (name) => {
      mockFakes.cognito = { error: { name, message: 'service trouble' } };
      expect(await failure()).toBe('service trouble');
      expect(stepNames()).toEqual(['health', 'api-up']);
      expect(metricNames()).toEqual([]);
    },
  );

  test('a failed metric write does not turn the skip into a failed run', async () => {
    mockFakes.secrets['Billboard/CanarySmokeTestCredentials'] = '{';
    mockFakes.metricError = new Error('cloudwatch:PutMetricData denied');
    await runCanary();
    expect(stepNames()).toEqual(['health', 'api-up']);
    expect(consoleOutput.join('\n')).toContain('authenticated smoke checks skipped');
  });

  test('the unauthenticated steps still run first, and still fail the run on their own', async () => {
    mockFakes.secrets['Billboard/CanarySmokeTestCredentials'] = '{';
    mockFakes.httpReplies['api-up'] = { status: 200, body: '{}' };
    expect(await failure()).toBe('api-up: expected one of 401,403, got 200');
    expect(metricNames()).toEqual([]);
  });

  test('once a token is obtained, a failing signed-in step fails the run, with no sign-in metric', async () => {
    mockFakes.httpReplies['auth-me'] = { status: 401, body: '{"message":"Unauthorized"}' };
    expect(await failure()).toBe('auth-me: expected 200, got 401');
    expect(stepNames()).toEqual(['health', 'api-up', 'auth-me']);
    expect(metricNames()).toEqual([]);
  });

  test('a good sign-in emits no CanarySmokeSignInFailed', async () => {
    await runCanary();
    expect(metricNames()).not.toContain('CanarySmokeSignInFailed');
  });
});
