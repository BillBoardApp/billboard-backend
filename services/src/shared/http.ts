import type { ClientRequest } from "http";

/**
 * The User-Agent our congress.gov and GovInfo requests send (REL-45): who we are, why we fetch, and the project's
 * public contact address, so a site operator who blocks or challenges us can tell what the traffic is and reach us.
 * FetchRawBill sends it on every request; the other congress.gov callers still send BillBoardFetcher/1.0.
 */
export const BILLBOARD_FETCHER_USER_AGENT =
  "BillBoardFetcher/1.1 (BillBoard civic app; bill text; +https://billboard-project.com/privacy.html; contact@billboard-project.com)";

export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** True for our TimeoutError and for the DOMException that AbortSignal.timeout produces. */
export const isTimeoutError = (error: unknown): boolean =>
  error instanceof TimeoutError ||
  (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError");

// Codes of a connection that could not be made or broke off: DNS, refused, reset, unreachable, closed mid-response.
// Node puts them on the error itself; fetch (undici) on the cause of its TypeError.
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * True when a request failed below HTTP, on the far side or the network: the error, or one of its causes, carries a
 * connection-failure code (fetch's "fetch failed" TypeError with an ECONNREFUSED, ENOTFOUND or UND_ERR_SOCKET cause; a
 * body cut off mid-read is fetch's "terminated" with an UND_ERR_SOCKET cause). A "fetch failed" without such a code is
 * not one: undici raises it too for a blocked port ("bad port"), a redirect loop ("redirect count exceeded"), a
 * redirect to or a URL with another scheme, headers too large (UND_ERR_HEADERS_OVERFLOW) and TLS failures (bad
 * certificate, CA bundle), which a bad URL, a runtime change or a misbehaving server can cause and an error should
 * report. Compared by code, not instanceof: fetch errors come from Node's own realm. Our own deadline is
 * isTimeoutError, not this.
 */
export const isNetworkError = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
    current = cause;
  }
  return false;
};

/** The first connection-failure code (ECONNRESET, UND_ERR_SOCKET, ...) on the error or its causes, for logs. */
export const networkErrorCode = (error: unknown): string | null => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && code.length > 0) return code;
    current = cause;
  }
  return null;
};

/**
 * HTTP statuses that say the server, or the proxy in front of it, is down or overloaded, not that our request was
 * refused: 500, 502, 503, 504, and Cloudflare's 520 to 530 (unknown error, origin down, unreachable or timed out, TLS
 * handshake, origin DNS). congress.gov sits behind Cloudflare. 501, 505 to 519 and the other 5xx are not in it: they
 * say the request itself is not served.
 */
export const isUpstreamUnavailableStatus = (status: number): boolean =>
  status === 500 || status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);

const SECRET_QUERY_PARAMS = ["api_key", "apikey", "key", "token", "access_token"];

/** Returns the URL with secret-bearing query params (e.g. congress.gov api_key) masked, for logs and errors. */
export const redactUrl = (url: string | URL): string => {
  let parsed: URL;
  try {
    parsed = new URL(url.toString());
  } catch {
    return String(url).replace(/([?&](?:api_key|apikey|key|token|access_token)=)[^&#]*/gi, "$1REDACTED");
  }
  for (const name of SECRET_QUERY_PARAMS) {
    if (parsed.searchParams.has(name)) parsed.searchParams.set(name, "REDACTED");
  }
  return parsed.toString();
};

const assertTimeout = (timeoutMs: number): void => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive finite number (got ${timeoutMs})`);
  }
};

/**
 * fetch() with a deadline. The deadline covers the whole exchange, including
 * reading the body later; a caller-supplied init.signal still works.
 * A timeout before headers arrive rejects with TimeoutError; one during a
 * later body read rejects with a DOMException named "TimeoutError" (both
 * satisfy isTimeoutError).
 */
export const fetchWithTimeout = async (
  url: string | URL,
  init: RequestInit = {},
  timeoutMs: number,
): Promise<Response> => {
  assertTimeout(timeoutMs);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (timeoutSignal.aborted && isTimeoutError(error)) {
      throw new TimeoutError(`Request to ${redactUrl(url)} timed out after ${timeoutMs}ms`, timeoutMs, {
        cause: error,
      });
    }
    throw error;
  }
};

/**
 * Destroys `req` with a TimeoutError when its socket is idle for `timeoutMs`,
 * including while the TCP/TLS connection is still being established (which
 * req.setTimeout alone does not cover). The error surfaces through the
 * request's existing 'error' listener, even mid-response.
 * `label` appears in the error message; do not include secrets (see redactUrl).
 */
export const applySocketTimeout = <T extends ClientRequest>(req: T, timeoutMs: number, label = "HTTP request"): T => {
  assertTimeout(timeoutMs);
  // Test doubles for https.request are often bare EventEmitters without these methods.
  if (typeof req.setTimeout !== "function" || typeof req.destroy !== "function") return req;

  req.setTimeout(timeoutMs, () => {
    req.destroy(new TimeoutError(`${label} timed out after ${timeoutMs}ms of socket inactivity`, timeoutMs));
  });

  const coverConnect = (socket: { connecting?: boolean; setTimeout?: (ms: number) => unknown }): void => {
    if (socket.connecting && typeof socket.setTimeout === "function") socket.setTimeout(timeoutMs);
  };
  if (req.socket) {
    coverConnect(req.socket);
  } else {
    req.once("socket", coverConnect);
  }

  return req;
};
