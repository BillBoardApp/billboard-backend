const backfill = require("../../scripts/backfillBillsManifest.cjs");

type Invoke = { metadata: string; response: string };
type InvokeEvent = { Records: Array<{ messageId: string; body: string }>; forward?: unknown };
type Responder = (event: InvokeEvent) => Invoke | Error;

const key = (n: number) => `processed-bills/BILLS-119hr${n}.json`;
const keys = (count: number) => Array.from({ length: count }, (_unused, idx) => key(idx + 1));
const keyOf = (record: { body: string }): string => JSON.parse(record.body).Records[0].s3.object.key;

const invokeOk = (payload: unknown, version = "17"): Invoke => ({
  metadata: JSON.stringify({ StatusCode: 200, ExecutedVersion: version }),
  response: JSON.stringify(payload),
});

const functionError = (): Invoke => ({
  metadata: JSON.stringify({ StatusCode: 200, FunctionError: "Unhandled", ExecutedVersion: "17" }),
  response: JSON.stringify({ errorType: "Error", errorMessage: "Task timed out" }),
});

/** Answers like the C1.5 handler: fails the records of `failKeys` and echoes the forward flag. */
const currentHandler =
  (failKeys: string[] = []): Responder =>
  (event) => {
    const failures = event.Records.filter((record) => failKeys.includes(keyOf(record))).map((record) => ({
      itemIdentifier: record.messageId,
    }));
    return invokeOk({
      batchItemFailures: failures,
      statusCode: 200,
      body: JSON.stringify({
        updated: event.Records.length > 0,
        addedOrUpdated: event.Records.length - failures.length,
        forward: event.forward !== false,
        stats: { upsertsSkipped: 0 },
      }),
    });
  };

/** Answers like the release before C1.5, which ignores the flag and forwards. */
const olderHandler: Responder = (event) =>
  invokeOk({
    batchItemFailures: [],
    statusCode: 200,
    body: JSON.stringify({ updated: event.Records.length > 0, enqueued: event.Records.length, addedOrUpdated: 0 }),
  });

/** In-memory stand-ins for the CLI, the file system, the clock and the console. */
const fakeDeps = (options: { s3Keys?: string[] | null; files?: Record<string, string>; respond?: Responder }) => {
  const files: Record<string, string> = { ...options.files };
  const respond = options.respond ?? currentHandler();
  const invokes: InvokeEvent[] = [];
  const invokeArgs: string[][] = [];
  const execCalls: string[][] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let tempDirs = 0;
  const deps = {
    execFile: (cmd: string, args: string[]) => {
      execCalls.push([cmd, ...args]);
      if (cmd === "aws" && args[0] === "s3api") return JSON.stringify(options.s3Keys ?? null);
      if (cmd === "aws" && args[0] === "lambda" && args[1] === "invoke") {
        invokeArgs.push(args);
        const payloadPath = args[args.indexOf("--payload") + 1].replace(/^file:\/\//, "");
        const event = JSON.parse(files[payloadPath]) as InvokeEvent;
        invokes.push(event);
        const result = respond(event);
        if (result instanceof Error) throw result;
        files[args[args.length - 1]] = result.response;
        return result.metadata;
      }
      throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
    },
    readFile: (file: string) => {
      if (!(file in files)) throw new Error(`ENOENT: no such file, open '${file}'`);
      return files[file];
    },
    writeFile: (file: string, text: string) => {
      files[file] = text;
    },
    makeTempDir: () => `/tmp/backfill-bills-manifest-${++tempDirs}`,
    removeDir: (dir: string) => {
      for (const file of Object.keys(files)) if (file.startsWith(`${dir}/`)) delete files[file];
    },
    sleep: jest.fn(async () => undefined),
    now: () => new Date("2026-10-07T20:30:00.123Z"),
    cwd: () => "/work/services",
    log: (...args: unknown[]) =>
      logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")),
    error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
  };
  const batchInvokes = () => invokes.filter((event) => event.Records.length > 0);
  return { deps, files, invokes, batchInvokes, invokeArgs, execCalls, logs, errors };
};

const FAILED_FILE = "/work/services/backfill-bills-manifest-failed-20261007T203000Z.txt";

describe("backfillBillsManifest (C1.5)", () => {
  describe("parseArgs", () => {
    it("defaults to rows only over every S3 key from batch 1", () => {
      expect(backfill.parseArgs([])).toEqual({
        help: false,
        dryRun: false,
        forward: false,
        keysFile: null,
        startFromBatch: 1,
      });
    });

    it("reads --forward, --keys-file, --dry-run, a batch number and --help", () => {
      expect(backfill.parseArgs(["--forward", "--keys-file", "failed.txt", "--dry-run", "12"])).toEqual({
        help: false,
        dryRun: true,
        forward: true,
        keysFile: "failed.txt",
        startFromBatch: 12,
      });
      expect(backfill.parseArgs(["--help"]).help).toBe(true);
      expect(backfill.parseArgs(["-h"]).help).toBe(true);
    });

    it("refuses an unknown argument, a batch that is not a positive integer and --keys-file without a path", () => {
      expect(() => backfill.parseArgs(["--apply"])).toThrow("Unknown argument: --apply");
      expect(() => backfill.parseArgs(["0"])).toThrow("Unknown argument: 0");
      expect(() => backfill.parseArgs(["1.5"])).toThrow("Unknown argument: 1.5");
      expect(() => backfill.parseArgs(["--forward=true"])).toThrow("Unknown argument: --forward=true");
      expect(() => backfill.parseArgs(["--keys-file"])).toThrow("--keys-file needs a path");
      expect(() => backfill.parseArgs(["--keys-file", "--forward"])).toThrow("--keys-file needs a path");
    });
  });

  describe("parseKeysFile", () => {
    it("keeps processed-bill keys in file order, skipping blank lines and repeats", () => {
      const text = `${key(2)}\r\n\n  ${key(1)}  \n${key(2)}\n`;
      expect(backfill.parseKeysFile(text)).toEqual([key(2), key(1)]);
      expect(backfill.parseKeysFile("")).toEqual([]);
    });

    it("refuses a line that is not a processed-bills/...json key", () => {
      expect(() => backfill.parseKeysFile(`${key(1)}\nraw-bills/BILLS-119hr1.json\n`)).toThrow(
        "Line 2 of the keys file is not a processed-bills/...json key: raw-bills/BILLS-119hr1.json",
      );
      expect(() => backfill.parseKeysFile("processed-bills/BILLS-119hr1.txt")).toThrow("Line 1");
    });
  });

  describe("buildInvokeEvent", () => {
    it("numbers records by overall position and carries the forward flag at the top level", () => {
      const event = backfill.buildInvokeEvent([key(1), key(2)], 10, false);
      expect(event.forward).toBe(false);
      expect(event.Records.map((record: { messageId: string }) => record.messageId)).toEqual([
        "backfill-10",
        "backfill-11",
      ]);
      expect(JSON.parse(event.Records[1].body)).toEqual({ Records: [{ s3: { object: { key: key(2) } } }] });
      expect(backfill.buildInvokeEvent([key(1)], 0, true).forward).toBe(true);
    });
  });

  describe("failedKeysFromInvoke", () => {
    const batch = [key(11), key(12), key(13)];

    it("maps each batchItemFailures identifier back to its key; only the other keys succeed", () => {
      const result = backfill.failedKeysFromInvoke(
        batch,
        10,
        invokeOk({ batchItemFailures: [{ itemIdentifier: "backfill-11" }], body: '{"forward":false}' }),
      );
      expect(result).toEqual({ failedKeys: [key(12)], error: null, body: { forward: false } });
    });

    it("reports no failed key when the batch succeeded", () => {
      expect(backfill.failedKeysFromInvoke(batch, 10, invokeOk({ batchItemFailures: [] })).failedKeys).toEqual([]);
    });

    it("fails the whole batch on a FunctionError", () => {
      const result = backfill.failedKeysFromInvoke(batch, 10, functionError());
      expect(result.failedKeys).toEqual(batch);
      expect(result.error).toContain("function error (Unhandled)");
      expect(result.error).toContain("Task timed out");
    });

    it("fails the whole batch when the status is not 200 or the output cannot be read", () => {
      const status = { metadata: JSON.stringify({ StatusCode: 500 }), response: "{}" };
      expect(backfill.failedKeysFromInvoke(batch, 10, status).failedKeys).toEqual(batch);
      const cli = { metadata: "Traceback", response: "{}" };
      expect(backfill.failedKeysFromInvoke(batch, 10, cli).error).toContain("unreadable CLI output");
      const response = { metadata: JSON.stringify({ StatusCode: 200 }), response: "not json" };
      expect(backfill.failedKeysFromInvoke(batch, 10, response).error).toContain("unreadable function response");
    });

    it("fails the whole batch when the response does not say which records failed", () => {
      expect(backfill.failedKeysFromInvoke(batch, 10, invokeOk({ statusCode: 200 })).failedKeys).toEqual(batch);
      const unknown = backfill.failedKeysFromInvoke(
        batch,
        10,
        invokeOk({ batchItemFailures: [{ itemIdentifier: "backfill-3" }] }),
      );
      expect(unknown.failedKeys).toEqual(batch);
      expect(unknown.error).toBe('unknown itemIdentifier "backfill-3"');
    });
  });

  describe("preflightCheck", () => {
    it("accepts a response body that says forward false, and reports the version", () => {
      const invoke = currentHandler()(backfill.PREFLIGHT_EVENT) as Invoke;
      expect(backfill.preflightCheck(invoke)).toEqual({ accepted: true, reason: null, version: "17" });
      expect(backfill.PREFLIGHT_EVENT).toEqual({ Records: [], forward: false });
    });

    it("refuses an older release's body, forward true, a function error and an unreadable response", () => {
      expect(backfill.preflightCheck(olderHandler(backfill.PREFLIGHT_EVENT)).accepted).toBe(false);
      expect(backfill.preflightCheck(olderHandler(backfill.PREFLIGHT_EVENT)).reason).toContain(
        'does not say "forward":false',
      );
      expect(backfill.preflightCheck(invokeOk({ body: '{"forward":true}' })).accepted).toBe(false);
      expect(backfill.preflightCheck(invokeOk({ body: '{"forward":"false"}' })).accepted).toBe(false);
      expect(backfill.preflightCheck(functionError()).accepted).toBe(false);
      expect(backfill.preflightCheck({ metadata: "", response: "" }).accepted).toBe(false);
    });
  });

  it("default dependencies use real temporary files and return a command's trimmed output", async () => {
    const fs = require("fs");
    const path = require("path");
    const deps = backfill.defaultDeps;
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const dir = deps.makeTempDir();
    try {
      expect(path.basename(dir)).toMatch(/^backfill-bills-manifest-/);
      const file = path.join(dir, "keys.txt");
      deps.writeFile(file, `${key(1)}\n`);
      expect(deps.readFile(file)).toBe(`${key(1)}\n`);
      expect(deps.execFile(process.execPath, ["-e", "process.stdout.write(' out \\n')"])).toBe("out");
      await deps.sleep(0);
      expect(deps.now()).toBeInstanceOf(Date);
      expect(deps.cwd()).toBe(process.cwd());
      deps.log("logged");
      deps.error("errored");
      expect(logSpy).toHaveBeenCalledWith("logged");
      expect(errorSpy).toHaveBeenCalledWith("errored");
    } finally {
      deps.removeDir(dir);
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("names the failed-keys file by the run's UTC start time", () => {
    expect(backfill.failedKeysFileName(new Date("2026-10-07T20:30:00.123Z"))).toBe(
      "backfill-bills-manifest-failed-20261007T203000Z.txt",
    );
  });

  describe("run", () => {
    it("exits 0 when every key succeeds: preflight first, rows only, response read from a file", async () => {
      const fake = fakeDeps({ s3Keys: [...keys(12), "processed-bills/notes.txt"] });

      await expect(backfill.run([], fake.deps)).resolves.toBe(backfill.EXIT_CODES.ok);

      expect(fake.invokes[0]).toEqual({ Records: [], forward: false });
      expect(fake.batchInvokes()).toHaveLength(3);
      expect(fake.batchInvokes().every((event) => event.forward === false)).toBe(true);
      expect(fake.batchInvokes().flatMap((event) => event.Records.map(keyOf))).toEqual(keys(12));
      expect(fake.batchInvokes()[2].Records.map((record) => record.messageId)).toEqual(["backfill-10", "backfill-11"]);
      for (const args of fake.invokeArgs) {
        expect(args).toEqual(
          expect.arrayContaining(["--function-name", "CreateBillsManifest:prod", "--output", "json"]),
        );
        expect(args[args.indexOf("--payload") + 1]).toMatch(
          /^file:\/\/\/tmp\/backfill-bills-manifest-\d+\/payload\.json$/,
        );
        expect(args[args.indexOf("--cli-read-timeout") + 1]).toBe("180");
        expect(args[args.length - 1]).toMatch(/^\/tmp\/backfill-bills-manifest-\d+\/response\.json$/);
        expect(args).not.toContain("/dev/stdout");
      }
      // Temporary payload and response files are removed; no failed-keys file is written.
      expect(Object.keys(fake.files)).toEqual([]);
      expect(fake.deps.sleep).toHaveBeenCalledTimes(2);
      expect(fake.logs).toEqual(expect.arrayContaining(["  Successfully processed: 12 keys", "  Failed: 0 keys"]));
      expect(fake.logs.join("\n")).toContain(
        "Preflight passed: CreateBillsManifest:prod (version 17) writes rows only.",
      );
    });

    it("exits 1 and writes the failed keys, counting only the others as successes", async () => {
      let batch = 0;
      const partial = currentHandler([key(3)]);
      const fake = fakeDeps({
        s3Keys: keys(12),
        respond: (event) => {
          if (event.Records.length === 0) return partial(event);
          batch += 1;
          if (batch === 2) return functionError();
          if (batch === 3) return new Error("Command failed: aws lambda invoke (ExpiredToken)");
          return partial(event);
        },
      });

      await expect(backfill.run([], fake.deps)).resolves.toBe(backfill.EXIT_CODES.failed);

      const expectedFailed = [key(3), ...keys(12).slice(5)];
      expect(fake.files[FAILED_FILE]).toBe(`${expectedFailed.join("\n")}\n`);
      expect(fake.logs).toEqual(expect.arrayContaining(["  Successfully processed: 4 keys", "  Failed: 8 keys"]));
      expect(fake.logs.join("\n")).toContain(`npm run backfill:bills-manifest -- --keys-file "${FAILED_FILE}"`);
      expect(fake.errors.join("\n")).toContain("1 of 5 keys failed: processed-bills/BILLS-119hr3.json");
      expect(fake.errors.join("\n")).toContain("Batch 2 failed (function error (Unhandled)");
      expect(fake.errors.join("\n")).toContain("Batch 3 failed (invoke failed: Command failed");
    });

    it("reruns exactly the failed keys from the failed-keys file, without listing S3", async () => {
      const first = fakeDeps({ s3Keys: keys(7), respond: currentHandler([key(2), key(6)]) });
      await expect(backfill.run([], first.deps)).resolves.toBe(backfill.EXIT_CODES.failed);

      const rerun = fakeDeps({ files: { [FAILED_FILE]: first.files[FAILED_FILE] } });
      await expect(backfill.run(["--keys-file", FAILED_FILE], rerun.deps)).resolves.toBe(backfill.EXIT_CODES.ok);

      expect(rerun.execCalls.some((call) => call[1] === "s3api")).toBe(false);
      expect(rerun.batchInvokes().flatMap((event) => event.Records.map(keyOf))).toEqual([key(2), key(6)]);
      expect(rerun.invokes[0]).toEqual({ Records: [], forward: false });
    });

    it("exits 2 and invokes no batch when the preflight answer lacks forward false", async () => {
      const fake = fakeDeps({ s3Keys: keys(6), respond: olderHandler });

      await expect(backfill.run([], fake.deps)).resolves.toBe(backfill.EXIT_CODES.preflightRefused);

      expect(fake.invokes).toEqual([{ Records: [], forward: false }]);
      expect(fake.errors.join("\n")).toContain('Preflight refused: the response body does not say "forward":false');
      expect(Object.keys(fake.files)).toEqual([]);
    });

    it("exits 2 when the preflight invoke itself fails", async () => {
      const fake = fakeDeps({ s3Keys: keys(6), respond: () => new Error("Unable to locate credentials") });

      await expect(backfill.run([], fake.deps)).resolves.toBe(backfill.EXIT_CODES.preflightRefused);

      expect(fake.batchInvokes()).toEqual([]);
      expect(fake.errors.join("\n")).toContain("invoke failed: Unable to locate credentials");
    });

    it("stops with exit 2 when a batch is answered without forward false after the preflight passed", async () => {
      let batch = 0;
      const current = currentHandler();
      const fake = fakeDeps({
        s3Keys: keys(15),
        respond: (event) => {
          if (event.Records.length === 0) return current(event);
          batch += 1;
          return batch >= 2 ? olderHandler(event) : current(event);
        },
      });

      await expect(backfill.run([], fake.deps)).resolves.toBe(backfill.EXIT_CODES.preflightRefused);

      expect(fake.batchInvokes()).toHaveLength(2);
      expect(fake.logs.join("\n")).toContain("Backfill STOPPED at batch 2.");
      expect(fake.logs.join("\n")).toContain("npm run backfill:bills-manifest -- 3");
      expect(fake.errors.join("\n")).toContain('Batch 2 was answered without "forward":false');
    });

    it("with --forward skips the preflight, sends forward true and is not stopped by an older release", async () => {
      const fake = fakeDeps({ s3Keys: keys(7), respond: olderHandler });

      await expect(backfill.run(["--forward"], fake.deps)).resolves.toBe(backfill.EXIT_CODES.ok);

      expect(fake.invokes).toHaveLength(2);
      expect(fake.invokes.every((event) => event.forward === true && event.Records.length > 0)).toBe(true);
      expect(fake.logs.join("\n")).toContain("quiet notifications first (docs/RUNBOOK.md section 4.1)");
    });

    it("with --forward puts --forward in the rerun command for failed keys", async () => {
      const fake = fakeDeps({ s3Keys: keys(3), respond: currentHandler([key(1)]) });

      await expect(backfill.run(["--forward"], fake.deps)).resolves.toBe(backfill.EXIT_CODES.failed);

      expect(fake.logs.join("\n")).toContain(
        `npm run backfill:bills-manifest -- --forward --keys-file "${FAILED_FILE}"`,
      );
    });

    it("with --dry-run lists the batches and invokes nothing, not even the preflight", async () => {
      const fake = fakeDeps({ s3Keys: keys(6) });

      await expect(backfill.run(["--dry-run"], fake.deps)).resolves.toBe(backfill.EXIT_CODES.ok);

      expect(fake.invokes).toEqual([]);
      expect(fake.logs.filter((line) => line.includes("[dry-run] would invoke"))).toHaveLength(2);
    });

    it("resumes at a batch number, keeping the overall record numbering", async () => {
      const fake = fakeDeps({ s3Keys: keys(12) });

      await expect(backfill.run(["2"], fake.deps)).resolves.toBe(backfill.EXIT_CODES.ok);

      expect(fake.batchInvokes()[0].Records[0].messageId).toBe("backfill-5");
      expect(fake.batchInvokes().flatMap((event) => event.Records.map(keyOf))).toEqual(keys(12).slice(5));
      expect(fake.logs).toEqual(expect.arrayContaining(["  Skipped (resume): 5 keys"]));
    });

    it("prints each batch's kept dates (the Freeze B gate of RUNBOOK 4.9), and 0 from a release without them", async () => {
      const answering =
        (upsertsKeptDate?: number): Responder =>
        (event) =>
          invokeOk({
            batchItemFailures: [],
            statusCode: 200,
            body: JSON.stringify({
              updated: event.Records.length > 0,
              addedOrUpdated: event.Records.length,
              forward: false,
              stats: { upsertsSkipped: 0, ...(upsertsKeptDate === undefined ? {} : { upsertsKeptDate }) },
            }),
          });
      const files = { "keys.txt": `${key(9641)}\n` };
      const kept = fakeDeps({ files, respond: answering(1) });
      const older = fakeDeps({ files, respond: answering() });

      await expect(backfill.run(["--keys-file", "keys.txt"], kept.deps)).resolves.toBe(backfill.EXIT_CODES.ok);
      await expect(backfill.run(["--keys-file", "keys.txt"], older.deps)).resolves.toBe(backfill.EXIT_CODES.ok);

      expect(kept.logs).toContain("  ✓ Added: 1, Skipped: 0, Kept date: 1");
      expect(older.logs).toContain("  ✓ Added: 1, Skipped: 0, Kept date: 0");
    });

    it("exits 0 without invoking when there is nothing to backfill", async () => {
      const fake = fakeDeps({ s3Keys: null });

      await expect(backfill.run([], fake.deps)).resolves.toBe(backfill.EXIT_CODES.ok);

      expect(fake.invokes).toEqual([]);
      expect(fake.logs).toContain("Nothing to backfill.");
    });

    it("exits 1 on a usage error or an unreadable keys file, before any invoke", async () => {
      const usage = fakeDeps({ s3Keys: keys(3) });
      await expect(backfill.run(["--apply"], usage.deps)).resolves.toBe(backfill.EXIT_CODES.failed);
      expect(usage.errors.join("\n")).toContain("Unknown argument: --apply");

      const missing = fakeDeps({});
      await expect(backfill.run(["--keys-file", "absent.txt"], missing.deps)).resolves.toBe(backfill.EXIT_CODES.failed);
      const bad = fakeDeps({ files: { "bad.txt": "raw-bills/x.json\n" } });
      await expect(backfill.run(["--keys-file", "bad.txt"], bad.deps)).resolves.toBe(backfill.EXIT_CODES.failed);

      expect([...usage.invokes, ...missing.invokes, ...bad.invokes]).toEqual([]);
    });

    it("prints the usage, which names the forward option's quiet window, and exits 0", async () => {
      const fake = fakeDeps({});

      await expect(backfill.run(["--help"], fake.deps)).resolves.toBe(backfill.EXIT_CODES.ok);

      const usage = fake.logs.join("\n");
      expect(usage).toContain("--forward");
      expect(usage).toContain("--keys-file <path>");
      expect(usage).toContain("notifications first (docs/RUNBOOK.md section 4.1)");
      expect(fake.execCalls).toEqual([]);
    });
  });
});

export {};
