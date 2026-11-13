import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Structured JSON-lines logger for the Lambda handlers (OBS-10). No dependency.
 *
 * Each call writes one JSON object on one line:
 *   {"timestamp","level","message","service","fn","awsRequestId", ...keys, ...data}
 * `fn` is AWS_LAMBDA_FUNCTION_NAME, so a line can be traced to its function from any log group.
 * `keys` are the correlation keys in scope (correlationId, guid, bioguideId, userId, sqsMessageId):
 * `appendKeys` adds them for the rest of the invocation (or of the current `withKeys` scope), and
 * `withKeys` scopes them to one piece of async work, which keeps concurrent records apart.
 *
 * Lines go through console.log/warn/error, so the Lambda runtime adds its usual prefix and
 * CloudWatch Logs Insights discovers the JSON fields after it. Errors anywhere in the data are
 * written as { name, message, stack } (plus code/statusCode when present). Keys that carry
 * secrets or personal data (tokens, emails, addresses, passwords, request bodies) are replaced
 * with "[redacted]" at any depth; callers still must not put such values into messages.
 *
 * LOG_LEVEL (debug, info, warn, error) sets the lowest level written; the default is info.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogKeys {
  correlationId?: string;
  guid?: string;
  bioguideId?: string;
  /** Cognito sub. Never an email or other identifying detail. */
  userId?: string;
  sqsMessageId?: string;
  [key: string]: unknown;
}

/** The part of the Lambda context the logger reads. */
export interface LambdaContextLike {
  awsRequestId?: string;
}

export type LogData = Record<string, unknown>;

export const SERVICE_NAME = "billboard-services";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Fields the logger owns; data with these names is dropped rather than overwriting them.
const RESERVED_FIELDS = new Set(["timestamp", "level", "message", "service", "fn", "awsRequestId"]);

// Compared after lower-casing and removing everything but letters and digits, so
// "push_token", "pushToken" and "Push-Token" all match.
const REDACTED_KEYS = new Set([
  "token",
  "accesstoken",
  "idtoken",
  "refreshtoken",
  "devicetoken",
  "pushtoken",
  "apnstoken",
  "authorization",
  "password",
  "secret",
  "secretstring",
  "apikey",
  "congressapikey",
  "email",
  "emailaddress",
  "address",
  "streetaddress",
  "homeaddress",
  "body",
  "requestbody",
]);

export const REDACTED = "[redacted]";

const normalizeKeyName = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

export const isRedactedKey = (key: string): boolean => REDACTED_KEYS.has(normalizeKeyName(key));

/** An error as plain data: name, message and stack, plus code, statusCode and cause when present. */
export const serializeError = (error: unknown): LogData => {
  if (!(error instanceof Error)) return { message: String(error) };
  const candidate = error as Error & {
    code?: unknown;
    Code?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  // Reading `stack` can throw (a lazy source-map remap that overflows, or a throwing getter);
  // losing the stack must not lose the rest of the log line.
  let stack: string | undefined;
  try {
    stack = candidate.stack;
  } catch {
    stack = undefined;
  }
  const serialized: LogData = { name: candidate.name, message: candidate.message, stack };
  const code = candidate.code ?? candidate.Code;
  if (typeof code === "string" || typeof code === "number") serialized.code = code;
  const statusCode = candidate.$metadata?.httpStatusCode ?? candidate.statusCode;
  if (typeof statusCode === "number") serialized.statusCode = statusCode;
  if (candidate.cause !== undefined) serialized.cause = candidate.cause;
  return serialized;
};

const replaceValue = (key: string, value: unknown): unknown => {
  if (key && isRedactedKey(key)) return REDACTED;
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "bigint") return value.toString();
  return value;
};

const stringifyEntry = (entry: LogData): string => {
  try {
    return JSON.stringify(entry, (key, value) => replaceValue(key, value));
  } catch {
    // A circular reference (or a throwing getter): write repeated objects as a marker instead.
    try {
      const seen = new WeakSet<object>();
      return JSON.stringify(entry, (key, value) => {
        const replaced = replaceValue(key, value);
        if (replaced && typeof replaced === "object") {
          if (seen.has(replaced)) return "[Circular]";
          seen.add(replaced);
        }
        return replaced;
      });
    } catch {
      return JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        service: entry.service,
        fn: entry.fn,
        awsRequestId: entry.awsRequestId,
        logError: "log data could not be serialized",
      });
    }
  }
};

const definedKeys = (keys: LogKeys | undefined): LogKeys => {
  const out: LogKeys = {};
  if (!keys) return out;
  for (const [name, value] of Object.entries(keys)) {
    if (value === undefined || value === null || value === "") continue;
    out[name] = value;
  }
  return out;
};

const parseLevel = (value: string | undefined): LogLevel => {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized in LEVEL_RANK ? (normalized as LogLevel) : "info";
};

// Resolved on every call so test spies on console see the lines.
const writeLine = (level: LogLevel, line: string): void => {
  switch (level) {
    case "debug":
      console.debug(line);
      return;
    case "info":
      console.log(line);
      return;
    case "warn":
      console.warn(line);
      return;
    case "error":
      console.error(line);
      return;
  }
};

export class Logger {
  private readonly scopes = new AsyncLocalStorage<LogKeys>();

  private invocationKeys: LogKeys = {};

  private awsRequestId: string | undefined;

  /**
   * Starts a new invocation: records the request id and drops keys appended during the previous
   * one (a warm container reuses this module). Call it first in every handler.
   */
  resetContext(context?: LambdaContextLike | null): void {
    this.invocationKeys = {};
    const requestId = context?.awsRequestId;
    this.awsRequestId = typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
  }

  /** Adds keys to every later line of the current `withKeys` scope, or of the invocation outside one. */
  appendKeys(keys: LogKeys): void {
    Object.assign(this.scopes.getStore() ?? this.invocationKeys, definedKeys(keys));
  }

  /** Stops writing the named keys in the current scope (or the invocation outside one). */
  removeKeys(...names: string[]): void {
    const scope = this.scopes.getStore();
    for (const name of names) {
      if (scope) scope[name] = undefined;
      else delete this.invocationKeys[name];
    }
  }

  /** Runs `fn` with `keys` added to every line it logs, including from async work it starts. */
  withKeys<T>(keys: LogKeys, fn: () => T): T {
    return this.scopes.run({ ...(this.scopes.getStore() ?? {}), ...definedKeys(keys) }, fn);
  }

  /** The keys lines would carry right now. */
  currentKeys(): LogKeys {
    return definedKeys({ ...this.invocationKeys, ...(this.scopes.getStore() ?? {}) });
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[parseLevel(process.env.LOG_LEVEL)];
  }

  debug(message: string, data?: LogData | Error): void {
    this.write("debug", message, data);
  }

  info(message: string, data?: LogData | Error): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: LogData | Error): void {
    this.write("warn", message, data);
  }

  error(message: string, data?: LogData | Error): void {
    this.write("error", message, data);
  }

  private write(level: LogLevel, message: string, data?: LogData | Error): void {
    if (!this.isLevelEnabled(level)) return;

    const entry: LogData = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      service: SERVICE_NAME,
      fn: process.env.AWS_LAMBDA_FUNCTION_NAME || undefined,
      awsRequestId: this.awsRequestId,
      ...this.currentKeys(),
    };

    const fields = data instanceof Error ? { error: data } : data;
    if (fields && typeof fields === "object") {
      for (const [name, value] of Object.entries(fields)) {
        if (!RESERVED_FIELDS.has(name)) entry[name] = value;
      }
    }

    writeLine(level, stringifyEntry(entry));
  }
}

/** The process-wide logger. Handlers call `logger.resetContext(context)` on entry. */
export const logger = new Logger();
