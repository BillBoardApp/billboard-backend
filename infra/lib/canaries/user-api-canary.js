const https = require('https');
const zlib = require('zlib');
const synthetics = require('@aws/synthetics-puppeteer');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { CognitoIdentityProviderClient, InitiateAuthCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const secrets = new SecretsManagerClient({});
const cognito = new CognitoIdentityProviderClient({});
const cloudwatch = new CloudWatchClient({});

const parseJson = (body, stepName) => {
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new Error(stepName + ': invalid JSON');
  }
};

const readSecretString = async (secretId) => {
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  return result.SecretString || Buffer.from(result.SecretBinary || '', 'base64').toString('utf8');
};

const readJsonSecret = async (secretId) => parseJson(await readSecretString(secretId), 'secret ' + secretId);

// `stepConfig` is passed on to executeHttpStep only when given, so the other steps call it exactly as before.
const httpStep = async (stepName, request, validate, stepConfig) => {
  const body = request.body;
  const headers = Object.assign({}, request.headers || {});
  if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (body) headers['Content-Length'] = Buffer.byteLength(body).toString();

  const callback = (res) =>
    new Promise((resolve, reject) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          Promise.resolve(validate(res.statusCode, responseBody, res.headers || {})).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      });
    });
  const options = Object.assign({}, request, { headers });
  return stepConfig === undefined
    ? synthetics.executeHttpStep(stepName, options, callback)
    : synthetics.executeHttpStep(stepName, options, callback, stepConfig);
};

const expectStatus = (stepName, expected) => (statusCode) => {
  if (statusCode !== expected) throw new Error(stepName + ': expected ' + expected + ', got ' + statusCode);
};

const expectStatusIn = (stepName, expected) => (statusCode) => {
  if (!expected.includes(statusCode)) {
    throw new Error(stepName + ': expected one of ' + expected.join(',') + ', got ' + statusCode);
  }
};

const ageSeconds = (timestamp, stepName) => {
  const millis = Date.parse(timestamp || '');
  if (!Number.isFinite(millis)) throw new Error(stepName + ': missing or invalid freshness timestamp');
  return Math.max(0, Math.floor((Date.now() - millis) / 1000));
};

const emitAgeMetric = async (metricName, seconds) => {
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: 'BillBoard/ProductHealth',
    MetricData: [{
      MetricName: metricName,
      Unit: 'Seconds',
      Value: seconds,
    }],
  }));
};

const assertFresh = async (stepName, metricName, timestamp, maxSeconds) => {
  const seconds = ageSeconds(timestamp, stepName);
  await emitAgeMetric(metricName, seconds);
  if (seconds > maxSeconds) {
    throw new Error(stepName + ': freshness age ' + seconds + 's exceeded ' + maxSeconds + 's');
  }
};

// C1.9: the bills path the R1 app uses. GET /bills-manifest?delivery=snapshot answers with a pointer to the
// gzip snapshot PublishBillsManifest writes to S3; the app then downloads that presigned URL with no headers.
//
// The presigned URL carries a signature and a session token. It never enters a log line, an error message or
// a Synthetics report: the pointer step keeps its response body out of the HTTP report, the download is a
// plain executeStep (not an HTTP step), and every failure names the status code and host only.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SNAPSHOT_DOWNLOAD_TIMEOUT_MS = 30000;
const POINTER_STEP_CONFIG = { includeResponseBody: false };
const SNAPSHOT_STEP_CONFIG = {
  screenshotOnStepStart: false,
  screenshotOnStepSuccess: false,
  screenshotOnStepFailure: false,
};

const isIsoTime = (value) => typeof value === 'string' && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value));

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'an unparseable URL';
  }
};

/** The pointer's fields, or an error naming what is wrong (never the URL itself). */
const readSnapshotPointer = (stepName, json) => {
  if (Array.isArray(json.bills)) {
    throw new Error(stepName + ': snapshot pointer not served; FetchBillsManifest fell back to the inline manifest');
  }
  if (typeof json.snapshotUrl !== 'string' || !json.snapshotUrl.startsWith('https://')) {
    throw new Error(stepName + ': snapshotUrl is missing or not an https URL');
  }
  if (!isIsoTime(json.generatedAt)) throw new Error(stepName + ': generatedAt is missing or not an ISO time');
  if (!Number.isInteger(json.count) || json.count <= 0) throw new Error(stepName + ': count is not a positive integer');
  if (!isIsoTime(json.expiresAt)) throw new Error(stepName + ': expiresAt is missing or not an ISO time');
  return { snapshotUrl: json.snapshotUrl, count: json.count };
};

/** GET with no headers, as the app does; resolves the raw body once the status is 200. */
const downloadSnapshot = (stepName, snapshotUrl) =>
  new Promise((resolve, reject) => {
    const host = hostOf(snapshotUrl);
    const fail = (reason) => reject(new Error(stepName + ': ' + reason + ' from ' + host));
    let request;
    try {
      request = https.get(snapshotUrl, (res) => {
        const chunks = [];
        res.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
        res.on('error', () => fail('response failed'));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            fail('expected 200, got ' + res.statusCode);
            return;
          }
          resolve({ headers: res.headers || {}, body: Buffer.concat(chunks) });
        });
      });
    } catch {
      fail('request could not be sent');
      return;
    }
    request.on('error', (error) => fail('request failed (' + ((error && error.code) || 'error') + ')'));
    request.setTimeout(SNAPSHOT_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(Object.assign(new Error('snapshot download timed out'), { code: 'ETIMEDOUT' }));
    });
  });

/** The snapshot's bills, checked against the pointer's count. The object is stored with Content-Encoding gzip. */
const readSnapshotBills = async (stepName, pointer) => {
  const { headers, body } = await downloadSnapshot(stepName, pointer.snapshotUrl);
  let text;
  try {
    const gzipped = String(headers['content-encoding'] || '').toLowerCase().includes('gzip');
    text = (gzipped ? zlib.gunzipSync(body) : body).toString('utf8');
  } catch {
    throw new Error(stepName + ': the snapshot is marked gzip but does not decompress');
  }
  const json = parseJson(text, stepName);
  if (!Array.isArray(json.bills) || json.bills.length === 0) {
    throw new Error(stepName + ': expected non-empty bills array');
  }
  if (json.bills.length !== pointer.count) {
    throw new Error(stepName + ': snapshot has ' + json.bills.length + ' bills but the pointer count is ' + pointer.count);
  }
  return json.bills;
};

// The sign-in depends on two things kept by hand: the secret and the test account. When either is not
// as the script expects, the sign-in cannot happen, and that says nothing about the API. Failing the run would
// lower SuccessPercent, which is a member of Billboard-Page-AppBroken and of every API deployment group's alarm, so
// the run instead skips the signed-in steps and emits CanarySmokeSignInFailed, which has a notify-only alarm
// (Billboard-Canary-SmokeSignInFailed). Once a token is in hand, a failing signed-in step fails the run as before.
//
// Cognito errors that are not about the account (InternalErrorException, TooManyRequestsException,
// InvalidParameterException, a network error) are rethrown: the canary's own client or Cognito is then broken
// for real, and nothing else would notice.
const SIGN_IN_FAILED_METRIC = 'CanarySmokeSignInFailed';
const ACCOUNT_ERROR_NAMES = new Set([
  'NotAuthorizedException',
  'PasswordResetRequiredException',
  'UserNotFoundException',
  'UserNotConfirmedException',
]);

// An AWS error class or a Cognito challenge name is fixed text from the service. Anything else, such as a
// message (which can echo an ARN or a username), is never logged.
const safeLabel = (value) => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : 'unknown');

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/** Logs why, emits CanarySmokeSignInFailed (a failed write is logged, never thrown) and tells the caller to skip. */
const skipSignedInChecks = async (reason) => {
  console.log('authenticated smoke checks skipped: smoke sign-in unavailable (' + reason + ')');
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'BillBoard/ProductHealth',
      MetricData: [{
        MetricName: SIGN_IN_FAILED_METRIC,
        Unit: 'Count',
        Value: 1,
      }],
    }));
  } catch (error) {
    console.log('could not record ' + SIGN_IN_FAILED_METRIC + ' (' + safeLabel(error && error.name) + ')');
  }
  return null;
};

const signInSmokeUser = async () => {
  const secretId = process.env.SMOKE_TEST_SECRET_NAME;
  if (!secretId) {
    console.log('authenticated smoke checks skipped: SMOKE_TEST_SECRET_NAME is not configured');
    return null;
  }

  let raw;
  try {
    raw = await readSecretString(secretId);
  } catch (error) {
    return skipSignedInChecks('the secret could not be read: ' + safeLabel(error && error.name));
  }
  let credentials;
  try {
    credentials = JSON.parse(raw || '{}');
  } catch {
    return skipSignedInChecks('the secret is not valid JSON');
  }
  const fields = credentials && typeof credentials === 'object' ? credentials : {};
  const username = [fields.username, fields.email].find(isNonEmptyString);
  const password = fields.password;
  if (!username || !isNonEmptyString(password)) {
    return skipSignedInChecks('the secret must be a JSON object with username (or email) and password strings');
  }

  let auth;
  try {
    auth = await cognito.send(new InitiateAuthCommand({
      ClientId: process.env.USER_POOL_CLIENT_ID,
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
      },
    }));
  } catch (error) {
    const name = error && error.name;
    if (ACCOUNT_ERROR_NAMES.has(name)) return skipSignedInChecks('Cognito refused the account: ' + name);
    throw error;
  }
  const idToken = auth && auth.AuthenticationResult && auth.AuthenticationResult.IdToken;
  if (idToken) return idToken;
  if (auth && auth.ChallengeName) {
    return skipSignedInChecks('Cognito asked for a challenge instead of tokens: ' + safeLabel(auth.ChallengeName));
  }
  return skipSignedInChecks('Cognito returned no id token');
};

const loadFixtures = async () => {
  const secretId = process.env.SMOKE_TEST_FIXTURES_SECRET_NAME;
  return secretId ? readJsonSecret(secretId) : {};
};

exports.handler = async () => {
  const apiUrl = process.env.API_URL;
  const url = new URL(apiUrl);
  const hostname = url.hostname;
  const base = url.pathname.replace(/\/$/, '');
  let billGuid;
  let bioguideId;
  const maxWeeklyDigestAgeSeconds = Number(process.env.MAX_WEEKLY_DIGEST_AGE_SECONDS || '691200');

  const requestBase = {
    hostname,
    port: 443,
    protocol: 'https:',
  };

  await httpStep('health', {
    ...requestBase,
    path: base + '/health',
    method: 'GET',
    headers: { Accept: 'application/json' },
  }, (statusCode, body) => {
    expectStatus('health', 200)(statusCode);
    const json = parseJson(body, 'health');
    if (json.status !== 'ok') throw new Error('health status: ' + json.status);
  });

  await httpStep('api-up', {
    ...requestBase,
    path: base + '/bills-manifest',
    method: 'GET',
  }, expectStatusIn('api-up', [401, 403]));

  const token = await signInSmokeUser();
  if (!token) return;

  const fixtures = await loadFixtures();
  const authHeaders = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + token,
  };

  await httpStep('auth-me', {
    ...requestBase,
    path: base + '/me',
    method: 'GET',
    headers: authHeaders,
  }, (statusCode, body) => {
    expectStatus('auth-me', 200)(statusCode);
    const json = parseJson(body, 'auth-me');
    if (!json.userId) throw new Error('auth-me: missing userId');
  });

  // A pointer, never the inline manifest: the inline answer is the fallback when the snapshot cannot be
  // offered, and at production size it may not fit a Lambda response.
  let pointer;
  await httpStep('auth-bills-manifest-pointer', {
    ...requestBase,
    path: base + '/bills-manifest?delivery=snapshot',
    method: 'GET',
    headers: authHeaders,
  }, (statusCode, body) => {
    expectStatus('auth-bills-manifest-pointer', 200)(statusCode);
    pointer = readSnapshotPointer('auth-bills-manifest-pointer', parseJson(body, 'auth-bills-manifest-pointer'));
  }, POINTER_STEP_CONFIG);

  await synthetics.executeStep('auth-bills-manifest-snapshot', async () => {
    const bills = await readSnapshotBills('auth-bills-manifest-snapshot', pointer);
    billGuid = fixtures.billGuid || bills[0].guid;
    if (!billGuid) throw new Error('auth-bills-manifest-snapshot: missing bill guid fixture/discovery');
  }, SNAPSHOT_STEP_CONFIG);

  await httpStep('auth-processed-bill', {
    ...requestBase,
    path: base + '/processed-bill?guid=' + encodeURIComponent(billGuid),
    method: 'GET',
    headers: authHeaders,
  }, (statusCode, body) => {
    expectStatus('auth-processed-bill', 200)(statusCode);
    const json = parseJson(body, 'auth-processed-bill');
    if (!json.guid && !json.bill) throw new Error('auth-processed-bill: missing bill payload identity');
  });

  await httpStep('auth-congress-members-manifest', {
    ...requestBase,
    path: base + '/congress-members-manifest',
    method: 'GET',
    headers: authHeaders,
  }, (statusCode, body) => {
    expectStatus('auth-congress-members-manifest', 200)(statusCode);
    const json = parseJson(body, 'auth-congress-members-manifest');
    if (!Array.isArray(json.members) || json.members.length === 0) {
      throw new Error('auth-congress-members-manifest: expected non-empty members array');
    }
    bioguideId = fixtures.bioguideId || fixtures.congressMemberBioguideId || json.members[0].bioguideId;
    if (!bioguideId) throw new Error('auth-congress-members-manifest: missing bioguide fixture/discovery');
  });

  await httpStep('auth-processed-congress-member', {
    ...requestBase,
    path: base + '/processed-congress-members?bioguideId=' + encodeURIComponent(bioguideId),
    method: 'GET',
    headers: authHeaders,
  }, (statusCode, body) => {
    expectStatus('auth-processed-congress-member', 200)(statusCode);
    const json = parseJson(body, 'auth-processed-congress-member');
    if (!json.member && !json.bioguideId) throw new Error('auth-processed-congress-member: missing member payload identity');
  });

  await httpStep('auth-latest-weekly-digest', {
    ...requestBase,
    path: base + '/weekly-digests/latest',
    method: 'GET',
    headers: authHeaders,
  }, (statusCode, body) => {
    if (statusCode === 204 && !fixtures.requireWeeklyDigest) return;
    expectStatus('auth-latest-weekly-digest', 200)(statusCode);
    const json = parseJson(body, 'auth-latest-weekly-digest');
    const timestamp = fixtures.weeklyDigestFreshnessTimestamp || json.publishedAt || json.generatedAt || json.createdAt;
    return assertFresh(
      'auth-latest-weekly-digest',
      'WeeklyDigestAgeSeconds',
      timestamp,
      maxWeeklyDigestAgeSeconds,
    );
  });

  if (process.env.SMOKE_TEST_WRITE_CHECKS !== 'true') return;
  const feedbackBillId = fixtures.feedbackBillId || billGuid;

  await httpStep('write-preferences', {
    ...requestBase,
    path: base + '/preferences',
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ preferences: [{ type: 'Content Type', preference: 'bill' }] }),
  }, expectStatus('write-preferences', 200));

  await httpStep('read-preferences', {
    ...requestBase,
    path: base + '/preferences',
    method: 'GET',
    headers: authHeaders,
  }, expectStatus('read-preferences', 200));

  await httpStep('write-feedback', {
    ...requestBase,
    path: base + '/feedback',
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ billId: feedbackBillId, feedback: 'Abstain', reasons: [] }),
  }, expectStatus('write-feedback', 200));

  await httpStep('read-feedback', {
    ...requestBase,
    path: base + '/feedback?billId=' + encodeURIComponent(feedbackBillId),
    method: 'GET',
    headers: authHeaders,
  }, expectStatus('read-feedback', 200));
};
