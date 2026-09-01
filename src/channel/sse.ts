/**
 * Minimal SSE client for the hub's /events stream.
 *
 * The parser is incremental and pure (chunks in, `data` payloads out) so it
 * is testable without a socket. The subscription wraps it with fetch +
 * exponential-backoff reconnect. The hub stream carries no event ids, so a
 * reconnect cannot replay what was missed — the subscription surfaces every
 * reconnect through `onConnect({ reconnected: true, downMs })` and the caller
 * decides how to compensate.
 */

export type SseChunkParser = (chunk: string) => void;

/** Incremental text/event-stream parser. Only the `data` field is used. */
export function createSseParser(onData: (data: string) => void): SseChunkParser {
  let buffer = "";
  let dataLines: string[] = [];

  const consumeLine = (line: string) => {
    if (line === "") {
      if (dataLines.length > 0) {
        onData(dataLines.join("\n"));
        dataLines = [];
      }
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive
    if (line.startsWith("data:")) {
      // Per spec, a single leading space after the colon is stripped.
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    // Other fields (event:, id:, retry:) — the hub stream never sends them.
  };

  return (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      let line = buffer.slice(0, index);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      buffer = buffer.slice(index + 1);
      consumeLine(line);
      index = buffer.indexOf("\n");
    }
  };
}

/**
 * Pure outage-duration accounting for the reconnect loop. Each outage is
 * measured from ITS OWN first failed moment; a successful connect closes the
 * window. Extracted so the arithmetic is unit-testable without a socket —
 * the inline version shipped with a missing reset and reported time since
 * the FIRST-ever drop on every later reconnect (observed live 2026-09-01:
 * down_ms 1s → 303s → 605s → 907s across ~5-minute idle-cull cycles).
 */
export function createDownTracker(): {
  onDisconnect(nowMs: number): void;
  onConnect(nowMs: number): number;
} {
  let downSinceMs: number | null = null;
  return {
    onDisconnect(nowMs) {
      downSinceMs ??= nowMs;
    },
    onConnect(nowMs) {
      const downMs = downSinceMs === null ? 0 : nowMs - downSinceMs;
      downSinceMs = null;
      return downMs;
    },
  };
}

export interface SseSubscriptionHooks {
  onData: (data: string) => void;
  onConnect: (info: { reconnected: boolean; downMs: number }) => void;
  onError: (error: unknown) => void;
}

export interface SseSubscription {
  close(): void;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** Abort a connection attempt whose response headers never arrive — a
 * half-open socket (e.g. a proxy that accepted but will never answer)
 * otherwise hangs the reconnect loop until the OS TCP timeout. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Abort a stream that has carried no bytes for this long. The hub writes a
 * keepalive comment every 25s, so 90s of silence means the connection is
 * dead even if the socket still looks open. */
const IDLE_TIMEOUT_MS = 90_000;

/**
 * Deadman timer for a byte stream: `onIdle` fires once no `feed()` arrives
 * within `timeoutMs`. Pure timer wiring, extracted for unit testing.
 */
export function createIdleWatchdog(
  timeoutMs: number,
  onIdle: () => void,
): { feed(): void; stop(): void } {
  let timer: NodeJS.Timeout | null = null;
  return {
    feed() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(onIdle, timeoutMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export function subscribeSse(
  url: string,
  hooks: SseSubscriptionHooks,
): SseSubscription {
  const controller = new AbortController();

  const run = async () => {
    let backoffMs = INITIAL_BACKOFF_MS;
    let everConnected = false;
    const downTracker = createDownTracker();

    while (!controller.signal.aborted) {
      // Per-attempt controller: connect/idle timeouts abort THIS attempt and
      // fall through to the retry loop, while an outer close() aborts both.
      const attempt = new AbortController();
      const onOuterAbort = () => attempt.abort();
      controller.signal.addEventListener("abort", onOuterAbort, { once: true });
      const connectTimer = setTimeout(
        () => attempt.abort(new Error(`no response headers within ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS,
      );
      connectTimer.unref?.();
      const watchdog = createIdleWatchdog(IDLE_TIMEOUT_MS, () =>
        attempt.abort(new Error(`no bytes for ${IDLE_TIMEOUT_MS}ms (idle stream)`)),
      );
      try {
        const response = await fetch(url, {
          signal: attempt.signal,
          headers: { Accept: "text/event-stream" },
        });
        clearTimeout(connectTimer);
        if (!response.ok || response.body === null) {
          throw new Error(`SSE endpoint responded ${response.status}`);
        }

        hooks.onConnect({
          reconnected: everConnected,
          downMs: downTracker.onConnect(Date.now()),
        });
        everConnected = true;
        backoffMs = INITIAL_BACKOFF_MS;

        const parse = createSseParser(hooks.onData);
        const decoder = new TextDecoder();
        watchdog.feed();
        for await (const chunk of response.body) {
          watchdog.feed();
          parse(decoder.decode(chunk as Uint8Array, { stream: true }));
        }
        throw new Error("SSE stream ended");
      } catch (error) {
        if (controller.signal.aborted) return;
        downTracker.onDisconnect(Date.now());
        hooks.onError(error);
      } finally {
        clearTimeout(connectTimer);
        watchdog.stop();
        controller.signal.removeEventListener("abort", onOuterAbort);
      }

      await sleep(backoffMs, controller.signal);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  };

  void run();

  return {
    close() {
      controller.abort();
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
