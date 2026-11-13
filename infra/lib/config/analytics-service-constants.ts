export const CONGRESS_MEMBERS_STATS_QUEUE_BATCH_SIZE = 5;

// BillStatsAggregator (CAP-04). One invocation recomputes each changed bill from a lean paged query,
// so bigger, less frequent batches cut the recompute cost; stats lag by up to the batching window.
export const BILL_STATS_AGGREGATOR_MEMORY_MB = 1024;
export const BILL_STATS_AGGREGATOR_TIMEOUT_SECONDS = 60;
// Distinct bills recomputed at once within one batch (BILL_STATS_CONCURRENCY).
export const BILL_STATS_AGGREGATOR_CONCURRENCY = 4;
export const BILL_STATS_AGGREGATOR_STREAM_BATCH_SIZE = 1000;
export const BILL_STATS_AGGREGATOR_STREAM_MAX_BATCHING_WINDOW_SECONDS = 30;
export const BILL_STATS_AGGREGATOR_STREAM_PARALLELIZATION_FACTOR = 1;
// The duration alarm fires at three quarters of the timeout.
export const BILL_STATS_AGGREGATOR_DURATION_ALARM_THRESHOLD_MS = 45000;
