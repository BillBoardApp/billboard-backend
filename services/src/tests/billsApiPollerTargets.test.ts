// REL-46: the legacy poller cases, run again through POLL_TARGETS (a single 119 target on the same state parameter),
// so CI exercises the multi-Congress path with the same expectations. The cases are billsApiPoller.test.ts's own: it
// reads POLL_TARGETS from the environment it captures when it loads.
process.env.POLL_TARGETS = "119=/test/bills/state";

require("./billsApiPoller.test");

export {};
