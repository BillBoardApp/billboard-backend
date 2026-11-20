// Creates and updates the SNS platform application for APNs from the Billboard/ApnsCredentials secret.
//
// The secret is a JSON object in one of two shapes, and the fields present pick the mode.
//
// Token mode (an APNs auth key, which does not expire; UA-08):
//   {
//     "SigningKey": "<the .p8 file's contents: its PEM text, header and footer lines included>",
//     "SigningKeyId": "<the key's 10-character Key ID>",
//     "TeamId": "<the 10-character Apple team ID>",
//     "BundleId": "<the app's bundle ID>"
//   }
//   SNS takes them as PlatformCredential (the signing key), PlatformPrincipal (the signing key ID),
//   ApplePlatformTeamID and ApplePlatformBundleID ("Apple Services using token credentials" in the
//   CreatePlatformApplication and SetPlatformApplicationAttributes API references).
//
// Certificate mode (the rollback path, unchanged):
//   { "PlatformPrincipal": "<certificate PEM>", "PlatformCredential": "<private key PEM>" }
//   The certificate is also read from platformPrincipal, certPem, certificatePem, cert or certificate, and the key
//   from platformCredential, keyPem, privateKeyPem, key or privateKey.
//
// Any token field selects token mode. A secret that has token and certificate fields at once, a token secret with a
// field missing or malformed, and token credentials SNS refuses as invalid are all "not configured": the handler logs
// why, never a value, and leaves the platform application as it is, so pushes keep their current credentials.

const crypto = require('node:crypto');

const {
  SNSClient,
  CreatePlatformApplicationCommand,
  SetPlatformApplicationAttributesCommand,
  DeletePlatformApplicationCommand,
} = require('@aws-sdk/client-sns');

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

const sns = new SNSClient({});
const secrets = new SecretsManagerClient({});

// The certificate-mode aliases, in the order the handler has always read them.
const CERTIFICATE_FIELDS = [
  'PlatformPrincipal', 'platformPrincipal', 'certPem', 'certificatePem', 'cert', 'certificate',
];
const PRIVATE_KEY_FIELDS = [
  'PlatformCredential', 'platformCredential', 'keyPem', 'privateKeyPem', 'key', 'privateKey',
];
const TOKEN_FIELDS = ['SigningKey', 'SigningKeyId', 'TeamId', 'BundleId'];

// Apple's key IDs and team IDs are 10 characters, upper-case letters and digits.
const APPLE_TEN_CHARACTER_ID = /^[A-Z0-9]{10}$/;
// A bundle ID is two or more dot-separated parts of letters, digits and hyphens.
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function extractFirstPemBlock(value, label) {
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (!text) return null;

  const patternsByLabel = {
    CERTIFICATE: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/m,
    PRIVATE_KEY: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/m,
    // Unencrypted PKCS#8 only ("BEGIN PRIVATE KEY"). -{5} keeps secret scanners from reading the pattern as a key.
    PKCS8_PRIVATE_KEY: /-{5}BEGIN PRIVATE KEY-{5}[\s\S]*?-{5}END PRIVATE KEY-{5}/m,
  };

  const pattern = patternsByLabel[label];
  if (!pattern) throw new Error('Unknown PEM label: ' + label);

  const match = text.match(pattern);
  return match ? match[0].trim() : null;
}

function normalizeApnsCertificate(value) {
  // SNS expects the PEM certificate body only.
  return extractFirstPemBlock(value, 'CERTIFICATE');
}

function normalizeApnsPrivateKey(value) {
  // SNS expects the PEM private key body only.
  return extractFirstPemBlock(value, 'PRIVATE_KEY');
}

// A .p8 key from Apple is an unencrypted PKCS#8 PEM of a P-256 key (APNs tokens are ES256). Anything else would be
// refused by SNS or, worse, accepted and fail every push, so it is "not configured" here.
function normalizeApnsSigningKey(value) {
  const pem = extractFirstPemBlock(value, 'PKCS8_PRIVATE_KEY');
  if (!pem) return null;
  try {
    const key = crypto.createPrivateKey({ key: pem, format: 'pem' });
    const details = key.asymmetricKeyDetails;
    if (key.asymmetricKeyType !== 'ec' || !details || details.namedCurve !== 'prime256v1') return null;
  } catch {
    return null;
  }
  return pem;
}

function matchingTrimmed(value, pattern) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return pattern.test(text) ? text : null;
}

// Never log the secret value, only why it was skipped.
function logNotConfigured(reason) {
  console.log(
    'APNs credentials not configured yet (' + reason + '); skipping SNS platform application change'
  );
}

// The first field that is neither null nor undefined, like a ?? chain.
function firstPresent(parsed, fields) {
  for (const field of fields) {
    if (parsed[field] !== undefined && parsed[field] !== null) return parsed[field];
  }
  return undefined;
}

function hasAnyField(parsed, fields) {
  return firstPresent(parsed, fields) !== undefined;
}

function certificateCredentials(parsed) {
  const principal = firstPresent(parsed, CERTIFICATE_FIELDS);
  const credential = firstPresent(parsed, PRIVATE_KEY_FIELDS);

  const normalizedPrincipal = normalizeApnsCertificate(principal);
  const normalizedCredential = normalizeApnsPrivateKey(credential);

  if (!normalizedPrincipal || !normalizedCredential) {
    const missing = [];
    if (!normalizedPrincipal) missing.push('certificate');
    if (!normalizedCredential) missing.push('private key');
    logNotConfigured('no PEM ' + missing.join(' or '));
    return null;
  }
  return {
    mode: 'certificate',
    attributes: { PlatformPrincipal: normalizedPrincipal, PlatformCredential: normalizedCredential },
  };
}

function tokenCredentials(parsed) {
  const signingKey = normalizeApnsSigningKey(parsed.SigningKey);
  const signingKeyId = matchingTrimmed(parsed.SigningKeyId, APPLE_TEN_CHARACTER_ID);
  const teamId = matchingTrimmed(parsed.TeamId, APPLE_TEN_CHARACTER_ID);
  const bundleId = matchingTrimmed(parsed.BundleId, BUNDLE_ID);

  const problems = [];
  if (!signingKey) problems.push('SigningKey is not an unencrypted PKCS#8 P-256 private key (a .p8 file)');
  if (!signingKeyId) problems.push('SigningKeyId is not a 10-character key ID');
  if (!teamId) problems.push('TeamId is not a 10-character team ID');
  if (!bundleId) problems.push('BundleId is not a bundle ID');
  if (problems.length > 0) {
    logNotConfigured('token secret: ' + problems.join('; '));
    return null;
  }
  return {
    mode: 'token',
    attributes: {
      PlatformCredential: signingKey,
      PlatformPrincipal: signingKeyId,
      ApplePlatformTeamID: teamId,
      ApplePlatformBundleID: bundleId,
    },
  };
}

// Returns null when the secret has not been seeded with usable credentials
// yet (for example the random string a fresh stack creates), so the stack
// can deploy first and the credentials can be added later.
async function tryLoadCredentials(secretId) {
  let resp;
  try {
    resp = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretId })
    );
  } catch (e) {
    // The secret exists but has no AWSCURRENT value yet.
    if (e && e.name === 'ResourceNotFoundException') {
      logNotConfigured('secret has no value');
      return null;
    }
    throw e;
  }
  if (!resp || !resp.SecretString) {
    logNotConfigured('secret has no string value');
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(resp.SecretString);
  } catch {
    logNotConfigured('secret value is not JSON');
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logNotConfigured('secret value is not a JSON object');
    return null;
  }

  if (hasAnyField(parsed, TOKEN_FIELDS)) {
    if (hasAnyField(parsed, CERTIFICATE_FIELDS) || hasAnyField(parsed, PRIVATE_KEY_FIELDS)) {
      logNotConfigured('secret has both token and certificate fields; keep only one set');
      return null;
    }
    return tokenCredentials(parsed);
  }
  return certificateCredentials(parsed);
}

// SNS refusing token credentials as invalid leaves the application unchanged, so it is treated like a malformed
// secret instead of failing the deployment (whose rollback would re-run this with the same secret and fail again).
// Only the error's name is logged: SNS's message is not ours to vouch for. Certificate mode still throws, as before.
async function sendCredentials(creds, command) {
  try {
    return await sns.send(command);
  } catch (e) {
    const name = e && (e.name || e.Code || e.code);
    if (creds.mode === 'token' && (name === 'InvalidParameterException' || name === 'InvalidParameter')) {
      logNotConfigured('SNS refused the token credentials: ' + name);
      return null;
    }
    throw e;
  }
}

async function createApp(name, secretId) {
  const creds = await tryLoadCredentials(secretId);
  if (!creds) return null;

  console.log('Creating the SNS platform application with ' + creds.mode + ' credentials');
  const resp = await sendCredentials(
    creds,
    new CreatePlatformApplicationCommand({
      Name: name,
      Platform: 'APNS',
      Attributes: creds.attributes,
    })
  );

  return resp ? resp.PlatformApplicationArn : null;
}

async function updateApp(arn, secretId) {
  const creds = await tryLoadCredentials(secretId);
  if (!creds) return false;

  // The same call switches an existing application between certificate and token credentials.
  console.log('Setting ' + creds.mode + ' credentials on the SNS platform application');
  const resp = await sendCredentials(
    creds,
    new SetPlatformApplicationAttributesCommand({
      PlatformApplicationArn: arn,
      Attributes: creds.attributes,
    })
  );

  return resp !== null;
}

async function deleteApp(arn) {
  if (!arn || arn === 'none') return;

  try {
    await sns.send(
      new DeletePlatformApplicationCommand({ PlatformApplicationArn: arn })
    );
  } catch (e) {
    const name = e && (e.name || e.Code || e.code);
    if (name === 'NotFound' || name === 'NotFoundException') return;
    throw e;
  }
}

exports.handler = async function handler(event) {
  const props = event.ResourceProperties || {};
  const secretId = props.SecretId;
  const appName = props.ApplicationName;

  if (!secretId) throw new Error('Missing ResourceProperties.SecretId');
  if (!appName) throw new Error('Missing ResourceProperties.ApplicationName');

  const requestType = event.RequestType;
  const physicalId = event.PhysicalResourceId;

  if (requestType === 'Create') {
    const arn = await createApp(appName, secretId);
    return {
      PhysicalResourceId: arn ?? 'none',
      Data: { PlatformApplicationArn: arn ?? '' },
    };
  }

  if (requestType === 'Update') {
    const oldName =
      event.OldResourceProperties && event.OldResourceProperties.ApplicationName;

    // If we previously skipped creation (missing credentials), try now.
    if (physicalId === 'none') {
      const arn = await createApp(appName, secretId);
      return {
        PhysicalResourceId: arn ?? 'none',
        Data: { PlatformApplicationArn: arn ?? '' },
      };
    }

    // Name can't be updated; recreate if it changes.
    if (oldName && oldName !== appName) {
      const arn = await createApp(appName, secretId);
      if (arn) {
        await deleteApp(physicalId);
        return {
          PhysicalResourceId: arn,
          Data: { PlatformApplicationArn: arn },
        };
      }

      // If credentials are missing, keep the existing app.
      return {
        PhysicalResourceId: physicalId,
        Data: { PlatformApplicationArn: physicalId },
      };
    }

    await updateApp(physicalId, secretId);
    return {
      PhysicalResourceId: physicalId,
      Data: { PlatformApplicationArn: physicalId },
    };
  }

  if (requestType === 'Delete') {
    await deleteApp(physicalId);
    return {
      PhysicalResourceId: physicalId || 'none',
      Data: { PlatformApplicationArn: '' },
    };
  }

  throw new Error('Unknown RequestType: ' + requestType);
};
