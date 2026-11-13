import { EventEmitter } from "events";
import {
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import type { AddressInfo } from "net";
import {
  applySocketTimeout,
  fetchWithTimeout,
  isNetworkError,
  isTimeoutError,
  isUpstreamUnavailableStatus,
  networkErrorCode,
  redactUrl,
  TimeoutError,
} from "../shared/http";

type Behaviour = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let behaviour: Behaviour;

// A fresh server (new port) per test so pooled keep-alive sockets from one test are never reused by the next.
beforeEach(async () => {
  server = createServer((req, res) => behaviour(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("TimeoutError / isTimeoutError", () => {
  it("is a named Error carrying the timeout and cause", () => {
    const cause = new Error("inner");
    const error = new TimeoutError("took too long", 250, { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TimeoutError");
    expect(error.timeoutMs).toBe(250);
    expect(error.cause).toBe(cause);
  });

  it("recognises our TimeoutError and the AbortSignal.timeout DOMException", async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal.aborted).toBe(true);

    expect(isTimeoutError(new TimeoutError("x", 1))).toBe(true);
    expect(isTimeoutError(signal.reason)).toBe(true);
  });

  it.each([new Error("x"), new DOMException("aborted", "AbortError"), "TimeoutError", null, undefined, {}])(
    "returns false for %p",
    (value) => {
      expect(isTimeoutError(value)).toBe(false);
    },
  );
});

describe("isNetworkError / networkErrorCode", () => {
  const closedPort = async (): Promise<number> => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    return port;
  };

  it("recognises a refused connection from fetch", async () => {
    const error = await fetch(`http://127.0.0.1:${await closedPort()}/`).catch((e: unknown) => e);

    expect(isNetworkError(error)).toBe(true);
    expect(networkErrorCode(error)).toBe("ECONNREFUSED");
    expect(isTimeoutError(error)).toBe(false);
  });

  it("recognises a connection the server drops before answering", async () => {
    behaviour = (req) => req.socket.destroy();

    const error = await fetch(`${baseUrl}/reset`).catch((e: unknown) => e);

    expect(isNetworkError(error)).toBe(true);
    expect(networkErrorCode(error)).toBe("UND_ERR_SOCKET");
  });

  it("recognises a body cut off mid-read (fetch's 'terminated')", async () => {
    behaviour = (req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      setTimeout(() => req.socket.destroy(), 20);
    };

    const response = await fetch(`${baseUrl}/mid-body`);
    const error = await response.text().catch((e: unknown) => e);

    expect((error as Error).message).toBe("terminated");
    expect(isNetworkError(error)).toBe(true);
  });

  // undici's "fetch failed" also covers failures that are not an unavailable server; without a connection-failure
  // code on its cause it is not a network error, so the poller retries it and then throws.
  it.each<[string, () => string, string]>([
    ["a blocked port", () => "http://127.0.0.1:1/", "bad port"],
    ["a redirect loop", () => `${baseUrl}/loop`, "redirect count exceeded"],
    ["a redirect to another scheme", () => `${baseUrl}/ftp`, "URL scheme must be a HTTP(S) scheme"],
  ])("does not count %s as a network error", async (_label, url, causeMessage) => {
    behaviour = (req, res) => {
      res.writeHead(302, { location: req.url === "/ftp" ? "ftp://127.0.0.1/" : "/loop" });
      res.end();
    };

    const error = await fetch(url()).catch((e: unknown) => e);

    expect(error).toMatchObject({ name: "TypeError", message: "fetch failed", cause: { message: causeMessage } });
    expect(isNetworkError(error)).toBe(false);
  });

  it("does not count headers too large as a network error", async () => {
    behaviour = (_req, res) => {
      res.writeHead(200, { "x-big": "a".repeat(70_000) });
      res.end("x");
    };

    const error = await fetch(`${baseUrl}/big-header`).catch((e: unknown) => e);

    expect(error).toMatchObject({ message: "fetch failed", cause: { code: "UND_ERR_HEADERS_OVERFLOW" } });
    expect(isNetworkError(error)).toBe(false);
  });

  it.each([
    [
      "a fetch failure with no connection code",
      Object.assign(new TypeError("fetch failed"), { cause: new Error("unknown") }),
      false,
    ],
    [
      "a fetch failure with a TLS code",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
      }),
      false,
    ],
    [
      "a fetch failure with a refused connection",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
      true,
    ],
    ["a Node socket error code", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), true],
    [
      "a DNS failure two causes down",
      new Error("outer", { cause: new Error("x", { cause: { code: "EAI_AGAIN" } }) }),
      true,
    ],
    ["our own TypeError", new TypeError("Cannot read properties of undefined"), false],
    ["a JSON parse error", new SyntaxError("Unexpected token <"), false],
    [
      "an AWS SDK error",
      Object.assign(new Error("denied"), { name: "AccessDeniedException", code: "AccessDenied" }),
      false,
    ],
    ["our timeout", new TimeoutError("x", 1), false],
    ["a string", "fetch failed", false],
    ["null", null, false],
  ])("%s -> %p", (_label, error, expected) => {
    expect(isNetworkError(error)).toBe(expected);
  });
});

describe("isUpstreamUnavailableStatus", () => {
  it.each([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])("%i is unavailable", (status) => {
    expect(isUpstreamUnavailableStatus(status)).toBe(true);
  });

  it.each([200, 400, 401, 403, 404, 408, 422, 429, 501, 505, 511, 519, 531, 599])("%i is not", (status) => {
    expect(isUpstreamUnavailableStatus(status)).toBe(false);
  });
});

describe("redactUrl", () => {
  it("masks secret query params and keeps the rest", () => {
    const redacted = redactUrl("https://api.congress.gov/v3/bill/119/hr/1?api_key=SECRET123&format=json");
    expect(redacted).not.toContain("SECRET123");
    expect(redacted).toBe("https://api.congress.gov/v3/bill/119/hr/1?api_key=REDACTED&format=json");
  });

  it("accepts URL objects and leaves URLs without secrets unchanged", () => {
    expect(redactUrl(new URL("https://example.com/a?b=1"))).toBe("https://example.com/a?b=1");
  });

  it("masks secrets in strings that are not absolute URLs", () => {
    expect(redactUrl("/v3/member?format=json&api_key=SECRET123")).toBe("/v3/member?format=json&api_key=REDACTED");
  });
});

describe("fetchWithTimeout", () => {
  it("returns the response and forwards init", async () => {
    behaviour = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ua: req.headers["user-agent"], method: req.method }));
    };

    const response = await fetchWithTimeout(`${baseUrl}/ok`, { headers: { "User-Agent": "BillBoardTest/1.0" } }, 2000);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ua: "BillBoardTest/1.0", method: "GET" });
  });

  it("returns non-2xx responses rather than throwing", async () => {
    behaviour = (_req, res) => {
      res.writeHead(503);
      res.end("down");
    };
    const response = await fetchWithTimeout(`${baseUrl}/down`, {}, 2000);
    expect(response.status).toBe(503);
  });

  it("rejects with a TimeoutError (secrets redacted) when the server stalls", async () => {
    behaviour = () => {
      // never respond
    };

    const started = Date.now();
    const error = await fetchWithTimeout(`${baseUrl}/stall?api_key=SECRET123`, {}, 100).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TimeoutError);
    expect(isTimeoutError(error)).toBe(true);
    expect((error as TimeoutError).timeoutMs).toBe(100);
    expect((error as Error).message).toContain("timed out after 100ms");
    expect((error as Error).message).not.toContain("SECRET123");
    expect((error as Error).cause).toBeInstanceOf(DOMException);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("applies the deadline to a body that stalls after headers", async () => {
    behaviour = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
    };

    const response = await fetchWithTimeout(`${baseUrl}/slow-body`, {}, 150);
    const error = await response.text().catch((e: unknown) => e);
    expect(isTimeoutError(error)).toBe(true);
  });

  it("still honours a caller-supplied signal, which is not reported as a timeout", async () => {
    behaviour = () => {
      // never respond
    };
    const controller = new AbortController();
    const pending = fetchWithTimeout(`${baseUrl}/caller-abort`, { signal: controller.signal }, 5000);
    setTimeout(() => controller.abort(), 20);

    const error = await pending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect((error as Error).name).toBe("AbortError");
  });

  it("passes non-timeout network errors through unchanged", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const error = await fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 2000).catch((e: unknown) => e);
    // fetch errors come from Node's realm, so compare by name rather than instanceof.
    expect((error as Error).name).toBe("TypeError");
    expect(isTimeoutError(error)).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid timeout %p", async (timeoutMs) => {
    await expect(fetchWithTimeout(`${baseUrl}/ok`, {}, timeoutMs)).rejects.toBeInstanceOf(RangeError);
  });
});

describe("applySocketTimeout", () => {
  const run = (path: string, timeoutMs: number, label?: string) =>
    new Promise<{ error?: Error; body?: string; req: ClientRequest }>((resolve) => {
      const req = request(`${baseUrl}${path}`, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ body, req }));
      });
      applySocketTimeout(req, timeoutMs, label);
      req.on("error", (error) => resolve({ error, req }));
      req.end();
    });

  it("returns the same request for chaining", () => {
    behaviour = (_req, res) => res.end();
    const req = request(`${baseUrl}/chain`);
    req.on("error", () => undefined);
    expect(applySocketTimeout(req, 1000)).toBe(req);
    req.destroy();
  });

  it("destroys a request whose server never responds with a TimeoutError", async () => {
    behaviour = () => {
      // never respond
    };
    const started = Date.now();
    const { error, req } = await run("/stall", 100, "Congress API GET /bill");

    expect(error).toBeInstanceOf(TimeoutError);
    expect(error?.message).toBe("Congress API GET /bill timed out after 100ms of socket inactivity");
    expect((error as TimeoutError).timeoutMs).toBe(100);
    expect(req.destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("fires mid-response when the body stalls, through the request's error listener", async () => {
    behaviour = (_req, res) => {
      res.writeHead(200);
      res.write("partial");
    };
    const { error } = await run("/partial", 100);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error?.message).toBe("HTTP request timed out after 100ms of socket inactivity");
  });

  it("does not interfere with a response that completes in time, even after it finishes", async () => {
    behaviour = (_req, res) => {
      res.writeHead(200);
      res.end("hello");
    };
    const errors: Error[] = [];
    const { error, body, req } = await run("/fast", 100);
    req.on("error", (e) => errors.push(e));

    expect(error).toBeUndefined();
    expect(body).toBe("hello");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(errors).toEqual([]);
  });

  it("covers the connect phase by setting the timeout on a socket that is still connecting", () => {
    const req = Object.assign(new EventEmitter(), {
      setTimeout: jest.fn(),
      destroy: jest.fn(),
      socket: null,
    }) as unknown as ClientRequest;

    applySocketTimeout(req, 750);
    const connecting = { connecting: true, setTimeout: jest.fn() };
    req.emit("socket", connecting);
    expect(connecting.setTimeout).toHaveBeenCalledWith(750);
    expect(req.setTimeout).toHaveBeenCalledWith(750, expect.any(Function));
  });

  it("leaves an already-connected socket to req.setTimeout", () => {
    const connected = { connecting: false, setTimeout: jest.fn() };
    const req = Object.assign(new EventEmitter(), {
      setTimeout: jest.fn(),
      destroy: jest.fn(),
      socket: connected,
    }) as unknown as ClientRequest;

    applySocketTimeout(req, 750);
    expect(connected.setTimeout).not.toHaveBeenCalled();
  });

  it("uses an already-assigned connecting socket", () => {
    const connecting = { connecting: true, setTimeout: jest.fn() };
    const req = Object.assign(new EventEmitter(), {
      setTimeout: jest.fn(),
      destroy: jest.fn(),
      socket: connecting,
    }) as unknown as ClientRequest;

    applySocketTimeout(req, 300);
    expect(connecting.setTimeout).toHaveBeenCalledWith(300);
  });

  it("destroys with a TimeoutError when the timeout callback fires", () => {
    const req = Object.assign(new EventEmitter(), {
      setTimeout: jest.fn(),
      destroy: jest.fn(),
      socket: null,
    }) as unknown as ClientRequest;

    applySocketTimeout(req, 500, "Bill XML");
    const onTimeout = (req.setTimeout as jest.Mock).mock.calls[0][1] as () => void;
    onTimeout();

    const destroyError = (req.destroy as jest.Mock).mock.calls[0][0];
    expect(destroyError).toBeInstanceOf(TimeoutError);
    expect(destroyError.message).toBe("Bill XML timed out after 500ms of socket inactivity");
  });

  it("tolerates https.request test doubles that lack setTimeout/destroy", () => {
    const bare = new EventEmitter() as unknown as ClientRequest;
    expect(() => applySocketTimeout(bare, 1000)).not.toThrow();
    expect(applySocketTimeout(bare, 1000)).toBe(bare);
  });

  it.each([0, -5, Number.NaN])("rejects an invalid timeout %p", (timeoutMs) => {
    const bare = new EventEmitter() as unknown as ClientRequest;
    expect(() => applySocketTimeout(bare, timeoutMs)).toThrow(RangeError);
  });
});
