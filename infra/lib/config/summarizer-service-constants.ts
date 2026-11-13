import { parseOptionalReservedConcurrency } from './env';

// The model and its grants: infra/lib/config/bedrock-models.ts (BILL_SUMMARIZER_MODEL).

export const BILL_DIFFER_LAMBDA_TIMEOUT_SECONDS = 30;
export const BILL_DIFFER_LAMBDA_MEMORY_MB = 512;

// With one bill per call, a bill takes at most 2 Bedrock calls per receive: the answer, then a corrective or
// a reduced-input retry after a refusal. Each call is aborted at BILL_SUMMARIZER_BEDROCK_CALL_TIMEOUT_MS
// (sooner when the invocation has less left), and none starts with under 20 s left. Kept at 120 s: it sets
// the visibility timeout below and with it the retry window.
export const BILL_SUMMARIZER_LAMBDA_TIMEOUT_SECONDS = 120;
// LLM-11: one bill per call. A bill's answer then does not depend on the other bills in its batch (s2402's
// `how` was 471 characters in a batch and 662 alone), and a refusal or a max_tokens stop affects one bill.
// The multi-bill path stays, so batching again is a change here only.
export const BILL_SUMMARIZER_LAMBDA_MAX_BILLS_PER_BATCH = 1;
// Per call. On Haiku 5.5 thinking counts toward it; one bill's visible answer is about 1,100 tokens.
export const BILL_SUMMARIZER_LAMBDA_MAX_OUTPUT_TOKENS = 8192;
export const BILL_SUMMARIZER_EVENT_SOURCE_MAX_CONCURRENCY = 2;
// Single-bill calls one invocation runs at once, so at most 2 x 3 = 6 summarizer calls are in flight.
export const BILL_SUMMARIZER_BEDROCK_CONCURRENCY = 3;
export const BILL_SUMMARIZER_BEDROCK_CALL_TIMEOUT_MS = 60000;

export const BILL_SUMMARIZER_RESERVED_CONCURRENCY =
  parseOptionalReservedConcurrency(
    process.env.BILL_SUMMARIZER_RESERVED_CONCURRENCY,
    'BILL_SUMMARIZER_RESERVED_CONCURRENCY'
  );

export const CONGRESS_MEMBER_SUMMARIZER_LAMBDA_TIMEOUT_SECONDS = 10;

export const BILL_SUMMARIZER_QUEUE_BATCH_SIZE = 5;
// REL-38: set on its own instead of reusing the batch size (same value, so the template is unchanged).
// With the 360-second visibility timeout, 5 receives give a failing summary about 30 minutes of
// retries, which switchover U9e step 2 relies on; lowering it shortens that window.
export const BILL_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT = 5;
export const BILL_SUMMARIZER_QUEUE_VISIBILITY_TIMEOUT_SECONDS =
  BILL_SUMMARIZER_LAMBDA_TIMEOUT_SECONDS * 3;
