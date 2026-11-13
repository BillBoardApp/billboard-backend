// App Attest (INT-04, decision 8A; C3 3.1 with the integration plan's section 6): the table, secret and function
// names, and the types of the values SetFeedback, PreSignUpCheck and AppAttest read for it (AccountData and
// CleanupOrphanedUsers read only the table name). The values themselves (modes, limits, throttles, the exempt group)
// are anti-abuse values and live in abuse-limits.ts.

// ── The AppAttest table (UserStoreStack; C3 4.1) ─────────────────────────────────────────────────
// `pk`/`sk`, on demand, TTL `ttl`, PITR, deletion protection, retained; no stream and no index. Items:
//   CH#<challenge> / CH        one-time challenges (APP_ATTEST_CHALLENGE_TTL_SECONDS; TTL deletes them an hour later);
//   KEY#<keyId>    / META      one attested key per app install: public key, counter, accountCount, signupCount;
//   USER#<sub>     / KEY#<id>  the binding of an account to an install's key (deleted with the account, X5 (c)).
// Key rows hold no account ID and stay when an account is deleted, so deletion frees no slot (C3 Q3).
export const APP_ATTEST_TABLE_NAME = 'AppAttest';
export const APP_ATTEST_PARTITION_KEY = 'pk';
export const APP_ATTEST_SORT_KEY = 'sk';
export const APP_ATTEST_TTL_ATTRIBUTE = 'ttl';

/** EMF namespace of every App Attest metric (log-based; no PutMetricData grant). services: METRIC_NAMESPACE. */
export const APP_ATTEST_METRIC_NAMESPACE = 'BillBoard/AppAttest';

// ── The AppAttest function: POST /app-attest/challenge and POST /app-attest/attest (C3 3.2, 3.3) ──
// Public routes (no authorizer, no API key): sign-up and first-launch attestation happen signed out. Its reserved
// concurrency and the routes' own stage throttles are in abuse-limits.ts.
export const APP_ATTEST_FUNCTION_NAME = 'AppAttest';
export const APP_ATTEST_MEMORY_MB = 256;
export const APP_ATTEST_TIMEOUT_SECONDS = 10;

/** An API Gateway method throttle: steady requests per second and the bucket size, for all callers together. */
export interface MethodThrottle {
  readonly rateLimit: number;
  readonly burstLimit: number;
}

/** off: no reads, no writes, no metric, no vote-row attribute. watch: verify, record and emit metrics, never
 * block. enforce: block as C3 3.4 (votes) and 3.5 (sign-up) list. */
export type AppAttestMode = 'off' | 'watch' | 'enforce';

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/** The DeviceCheck key's secret ({"keyId", "teamId", "privateKeyPem"}), created by hand. PreSignUpCheck reads it
 * only when DEVICE_CHECK_MODE is not off, so it may be missing while that mode is off. */
export const DEVICE_CHECK_SECRET_NAME = 'Billboard/AppleDeviceCheckKey';
