/**
 * Test helpers for App Attest: the synthetic certificate chain (synthetic-chain.json), attestation
 * and assertion builders, and an in-memory AppAttest table that honours the exact condition and
 * update expressions the store sends.
 */

import { X509Certificate, createHash, generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";
import type {
  AttributeValue,
  GetItemCommandInput,
  PutItemCommandInput,
  TransactWriteItemsCommandInput,
  UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { APP_ID_HASH } from "../../../shared/appAttest/config";
import { conditionalCheckFailed, evaluateCondition } from "../dynamoCondition";
import { encodeCbor, type Encodable } from "./cborEncode";
import { SCENARIOS, buildAttestationAuthData, keyIdForPublicKey, type AttestationScenario } from "./scenarios";

interface ChainFile {
  roots: { synthetic: string; other: string };
  intermediates: { ca: string; notCa: string };
  leafPublicKeys: { p256: string; p384: string };
  scenarios: Record<string, { certificate: string; challenge: string; authDataHex: string }>;
}

export const chainFile: ChainFile = require("./synthetic-chain.json");

export const syntheticRoot = new X509Certificate(chainFile.roots.synthetic);
export const otherRoot = new X509Certificate(chainFile.roots.other);
export const intermediates = {
  ca: new X509Certificate(chainFile.intermediates.ca),
  notCa: new X509Certificate(chainFile.intermediates.notCa),
};

export const scenarioByName = (name: string): AttestationScenario => {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  return scenario;
};

export const sha256 = (...parts: (Buffer | string)[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

export const b64u = (bytes: Buffer | string): string => Buffer.from(bytes).toString("base64url");

/** A moment inside every synthetic certificate's validity: one hour after the latest start. */
export const fixtureNow = (name = "production_ios26"): Date => {
  const leaf = new X509Certificate(chainFile.scenarios[name].certificate);
  const starts = [leaf, intermediates.ca, intermediates.notCa, syntheticRoot].map((cert) => Date.parse(cert.validFrom));
  return new Date(Math.max(...starts) + 60 * 60 * 1000);
};

export interface AttestationFixture {
  attestation: Buffer;
  keyId: Buffer;
  keyIdB64: string;
  challenge: string;
  authData: Buffer;
  leafDer: Buffer;
  intermediateDer: Buffer;
  receipt: Buffer;
  now: Date;
}

/** The attestation object for a scenario; `mutate` may change the decoded parts before encoding. */
export const attestationFor = (
  name: string,
  mutate?: (parts: { fmt: Encodable; attStmt: Map<string, Encodable>; authData: Buffer }) => Encodable,
): AttestationFixture => {
  const scenario = scenarioByName(name);
  const stored = chainFile.scenarios[name];
  const authData = buildAttestationAuthData(scenario.authData, chainFile.leafPublicKeys[scenario.leaf]);
  if (authData.toString("hex") !== stored.authDataHex) {
    throw new Error(`synthetic-chain.json is stale for ${name}: rerun scripts/makeAppAttestFixtures.sh`);
  }
  const leafDer = new X509Certificate(stored.certificate).raw;
  const intermediateDer = intermediates[scenario.intermediate].raw;
  const receipt = Buffer.from(`synthetic receipt for ${name}`);
  const attStmt = new Map<string, Encodable>([
    ["x5c", [leafDer, intermediateDer]],
    ["receipt", receipt],
  ]);
  const object = mutate
    ? mutate({ fmt: "apple-appattest", attStmt, authData })
    : new Map<string, Encodable>([
        ["fmt", "apple-appattest"],
        ["attStmt", attStmt],
        ["authData", authData],
      ]);
  const keyId = keyIdForPublicKey(chainFile.leafPublicKeys[scenario.leaf]);
  return {
    attestation: encodeCbor(object),
    keyId,
    keyIdB64: b64u(keyId),
    challenge: stored.challenge,
    authData,
    leafDer,
    intermediateDer,
    receipt,
    now: fixtureNow(name),
  };
};

// ─── Assertions ────────────────────────────────────────────────────────────────

export interface DeviceKey {
  privateKey: KeyObject;
  publicKeySpki: Buffer;
  keyIdBytes: Buffer;
  keyId: string;
}

export const generateDeviceKey = (): DeviceKey => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const keyIdBytes = sha256(
    Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(String(jwk.x), "base64url"),
      Buffer.from(String(jwk.y), "base64url"),
    ]),
  );
  return {
    privateKey,
    publicKeySpki: publicKey.export({ type: "spki", format: "der" }),
    keyIdBytes,
    keyId: b64u(keyIdBytes),
  };
};

/** Assertion authenticator data: RP ID hash, flags, counter, then an extensions map when given. */
export const assertionAuthData = (input: {
  counter: number;
  rpIdHash?: Buffer;
  extensions?: Record<string, number | string | Uint8Array>;
  flags?: number;
}): Buffer => {
  const header = Buffer.alloc(37);
  (input.rpIdHash ?? APP_ID_HASH).copy(header, 0);
  header[32] = input.flags ?? (input.extensions ? 0x80 : 0x00);
  header.writeUInt32BE(input.counter, 33);
  return input.extensions ? Buffer.concat([header, encodeCbor(input.extensions)]) : header;
};

/** An assertion object signed like the device does: ECDSA P-256 over SHA-256 of the nonce. */
export const signAssertion = (input: {
  privateKey: KeyObject;
  authenticatorData: Buffer;
  clientData: Buffer;
}): Buffer => {
  const nonce = sha256(input.authenticatorData, sha256(input.clientData));
  const signature = signBytes("sha256", nonce, input.privateKey);
  return encodeCbor(
    new Map<string, Encodable>([
      ["signature", signature],
      ["authenticatorData", input.authenticatorData],
    ]),
  );
};

export const requestClientData = (input: {
  challenge: string;
  method?: string;
  path?: string;
  body?: string;
  extra?: Record<string, unknown>;
}): Buffer =>
  Buffer.from(
    JSON.stringify({
      v: 1,
      purpose: "request",
      challenge: input.challenge,
      method: input.method ?? "POST",
      path: input.path ?? "/feedback",
      bodySha256: b64u(sha256(Buffer.from(input.body ?? "", "utf8"))),
      ...(input.extra ?? {}),
    }),
    "utf8",
  );

export const signUpClientData = (input: { challenge: string; email: string }): Buffer =>
  Buffer.from(
    JSON.stringify({
      v: 1,
      purpose: "signup",
      challenge: input.challenge,
      emailSha256: b64u(sha256(Buffer.from(input.email.trim().toLowerCase(), "utf8"))),
    }),
    "utf8",
  );

export const assertionMarker = (input: { keyId: string; clientData: Buffer; assertion: Buffer }): string =>
  `v1.a.${input.keyId}.${b64u(input.clientData)}.${b64u(input.assertion)}`;

/** A challenge string like the route issues (43 base64url characters). */
export const challengeOf = (seed: string): string => b64u(sha256(`seed:${seed}`));

// ─── In-memory AppAttest table ─────────────────────────────────────────────────

type Item = Record<string, AttributeValue>;

/** The input of any command the fake table answers, in DynamoDB's own field names. */
export type TableInput = Partial<
  GetItemCommandInput & PutItemCommandInput & UpdateItemCommandInput & TransactWriteItemsCommandInput
>;

/** The update fields applyUpdate reads (an UpdateItem input, or the Update part of a transaction). */
type UpdateInput = Pick<UpdateItemCommandInput, "ExpressionAttributeNames" | "ExpressionAttributeValues"> & {
  UpdateExpression?: string;
};

export interface RecordedCall {
  command: string;
  input: TableInput;
}

const itemKey = (key: Item): string => `${key.pk?.S}|${key.sk?.S}`;

const resolveName = (token: string, names: Record<string, string> | undefined): string =>
  token.startsWith("#") ? (names?.[token] ?? token) : token;

/** Applies "SET a = :x, b = :y" and "ADD a :n" (the forms the store uses). */
const applyUpdate = (item: Item, input: UpdateInput): Item => {
  const updated: Item = { ...item };
  const expression = input.UpdateExpression!;
  const names = input.ExpressionAttributeNames;
  const values = input.ExpressionAttributeValues ?? {};
  const setMatch = /^SET\s+(.+)$/i.exec(expression.trim());
  const addMatch = /^ADD\s+(\S+)\s+(\S+)$/i.exec(expression.trim());
  if (setMatch) {
    for (const assignment of setMatch[1].split(",")) {
      const [left, right] = assignment.split("=").map((part) => part.trim());
      updated[resolveName(left, names)] = values[right]!;
    }
  } else if (addMatch) {
    const name = resolveName(addMatch[1], names);
    const current = Number(updated[name]?.N ?? 0);
    updated[name] = { N: String(current + Number(values[addMatch[2]].N)) };
  } else {
    throw new Error(`unsupported update expression ${expression}`);
  }
  return updated;
};

export class FakeAppAttestTable {
  readonly items = new Map<string, Item>();
  readonly calls: RecordedCall[] = [];
  /** Errors to throw on the next calls of a command, in order. */
  private readonly failures: { command: string; error: unknown }[] = [];
  /** Milliseconds each call waits (honouring the abort signal), to exercise time budgets. */
  delayMs = 0;

  failNext(command: string, error: unknown = Object.assign(new Error("throttled"), { name: "ThrottlingException" })) {
    this.failures.push({ command, error });
  }

  get(key: Item): Item | undefined {
    return this.items.get(itemKey(key));
  }

  put(item: Item): void {
    this.items.set(itemKey(item), item);
  }

  commandNames(): string[] {
    return this.calls.map((call) => call.command);
  }

  async send(command: { constructor: { name: string }; input: TableInput }, options?: { abortSignal?: AbortSignal }) {
    const name = command.constructor.name;
    const input = command.input;
    this.calls.push({ command: name, input });
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        options?.abortSignal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    const failureIndex = this.failures.findIndex((failure) => failure.command === name);
    if (failureIndex >= 0) {
      const [failure] = this.failures.splice(failureIndex, 1);
      throw failure.error;
    }
    switch (name) {
      case "GetItemCommand":
        return { Item: this.get(input.Key!) };
      case "PutItemCommand": {
        const existing = this.get(input.Item!);
        if (input.ConditionExpression && !evaluateCondition(existing, input)) {
          throw conditionalCheckFailed(input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? existing : undefined);
        }
        this.put(input.Item!);
        return {};
      }
      case "UpdateItemCommand": {
        const existing = this.get(input.Key!);
        if (input.ConditionExpression && !evaluateCondition(existing, input)) {
          throw conditionalCheckFailed(input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? existing : undefined);
        }
        const updated = applyUpdate({ ...(existing ?? {}), ...input.Key }, input);
        this.put(updated);
        return input.ReturnValues === "UPDATED_NEW" ? { Attributes: updated } : {};
      }
      case "TransactWriteItemsCommand": {
        // All conditions are checked, then all writes applied, with no await in between: atomic, as in DynamoDB.
        const parts = (input.TransactItems ?? []).map((part) => {
          if (part.Put) return { kind: "Put" as const, operation: part.Put, existing: this.get(part.Put.Item!) };
          if (part.Update)
            return { kind: "Update" as const, operation: part.Update, existing: this.get(part.Update.Key!) };
          throw new Error(`FakeAppAttestTable does not support ${Object.keys(part)[0]}`);
        });
        const reasons = parts.map(({ operation, existing }) =>
          !operation.ConditionExpression || evaluateCondition(existing, operation)
            ? { Code: "None" }
            : {
                Code: "ConditionalCheckFailed",
                ...(operation.ReturnValuesOnConditionCheckFailure === "ALL_OLD" && existing ? { Item: existing } : {}),
              },
        );
        if (reasons.some((reason) => reason.Code !== "None")) {
          throw Object.assign(new Error(`Transaction cancelled [${reasons.map((reason) => reason.Code).join(", ")}]`), {
            name: "TransactionCanceledException",
            CancellationReasons: reasons,
          });
        }
        for (const part of parts) {
          this.put(
            part.kind === "Put"
              ? part.operation.Item!
              : applyUpdate({ ...(part.existing ?? {}), ...part.operation.Key }, part.operation),
          );
        }
        return {};
      }
      default:
        throw new Error(`FakeAppAttestTable does not support ${name}`);
    }
  }
}

/** A stored key row, as the attest route writes it. */
export const keyRow = (input: {
  keyId: string;
  publicKeySpki: Buffer;
  signCount?: number;
  environment?: "production" | "development";
  status?: string;
  accountCount?: number;
  signupCount?: number;
}): Item => ({
  pk: { S: `KEY#${input.keyId}` },
  sk: { S: "META" },
  publicKeySpki: { B: input.publicKeySpki },
  signCount: { N: String(input.signCount ?? 0) },
  environment: { S: input.environment ?? "production" },
  status: { S: input.status ?? "active" },
  accountCount: { N: String(input.accountCount ?? 0) },
  signupCount: { N: String(input.signupCount ?? 0) },
  receipt: { B: Buffer.from("receipt") },
  attestedAt: { S: "2026-10-01T00:00:00.000Z" },
  lastUsedAt: { S: "2026-10-01T00:00:00.000Z" },
  ttl: { N: "1900000000" },
});

/** A challenge row as the challenge route writes it. */
export const challengeRow = (input: { challenge: string; purpose: "attest" | "assert"; expiresAt: Date }): Item => ({
  pk: { S: `CH#${input.challenge}` },
  sk: { S: "CH" },
  purpose: { S: input.purpose },
  createdAt: { S: new Date(input.expiresAt.getTime() - 300_000).toISOString() },
  expiresAt: { N: String(Math.floor(input.expiresAt.getTime() / 1000)) },
  ttl: { N: String(Math.floor(input.expiresAt.getTime() / 1000) + 3600) },
});
