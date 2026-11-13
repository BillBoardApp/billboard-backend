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

function extractFirstPemBlock(value, label) {
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (!text) return null;

  const patternsByLabel = {
    CERTIFICATE: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/m,
    PRIVATE_KEY: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/m,
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

// Never log the secret value, only why it was skipped.
function logNotConfigured(reason) {
  console.log(
    'APNs credentials not configured yet (' + reason + '); skipping SNS platform application change'
  );
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

  const principal =
    parsed.PlatformPrincipal ??
    parsed.platformPrincipal ??
    parsed.certPem ??
    parsed.certificatePem ??
    parsed.cert ??
    parsed.certificate;

  const credential =
    parsed.PlatformCredential ??
    parsed.platformCredential ??
    parsed.keyPem ??
    parsed.privateKeyPem ??
    parsed.key ??
    parsed.privateKey;

  const normalizedPrincipal = normalizeApnsCertificate(principal);
  const normalizedCredential = normalizeApnsPrivateKey(credential);

  if (!normalizedPrincipal || !normalizedCredential) {
    const missing = [];
    if (!normalizedPrincipal) missing.push('certificate');
    if (!normalizedCredential) missing.push('private key');
    logNotConfigured('no PEM ' + missing.join(' or '));
    return null;
  }
  return { principal: normalizedPrincipal, credential: normalizedCredential };
}

async function createApp(name, secretId) {
  const creds = await tryLoadCredentials(secretId);
  if (!creds) return null;

  const resp = await sns.send(
    new CreatePlatformApplicationCommand({
      Name: name,
      Platform: 'APNS',
      Attributes: {
        PlatformPrincipal: creds.principal,
        PlatformCredential: creds.credential,
      },
    })
  );

  return resp.PlatformApplicationArn;
}

async function updateApp(arn, secretId) {
  const creds = await tryLoadCredentials(secretId);
  if (!creds) return false;

  await sns.send(
    new SetPlatformApplicationAttributesCommand({
      PlatformApplicationArn: arn,
      Attributes: {
        PlatformPrincipal: creds.principal,
        PlatformCredential: creds.credential,
      },
    })
  );

  return true;
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
