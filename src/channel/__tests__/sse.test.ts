import { describe, expect, it } from "vitest";
import { createDownTracker, createSseParser } from "../sse.js";

function collect(): { events: string[]; feed: (chunk: string) => void } {
  const events: string[] = [];
  const feed = createSseParser((data) => events.push(data));
  return { events, feed };
}

describe("createSseParser", () => {
  it("parses a single event", () => {
    const { events, feed } = collect();
    feed('data: {"a":1}\n\n');
    expect(events).toEqual(['{"a":1}']);
  });

  it("handles an event split across arbitrary chunk boundaries", () => {
    const { events, feed } = collect();
    feed("da");
    feed('ta: {"a"');
    feed(":1}\n");
    expect(events).toEqual([]);
    feed("\n");
    expect(events).toEqual(['{"a":1}']);
  });

  it("joins multiple data lines with newlines", () => {
    const { events, feed } = collect();
    feed("data: line1\ndata: line2\n\n");
    expect(events).toEqual(["line1\nline2"]);
  });

  it("ignores comment keep-alives and dispatches nothing for them", () => {
    const { events, feed } = collect();
    feed(": connected\n\n");
    expect(events).toEqual([]);
  });

  it("strips exactly one leading space after the data colon", () => {
    const { events, feed } = collect();
    feed("data:no-space\n\ndata:  two-spaces\n\n");
    expect(events).toEqual(["no-space", " two-spaces"]);
  });

  it("handles CRLF line endings", () => {
    const { events, feed } = collect();
    feed("data: x\r\n\r\n");
    expect(events).toEqual(["x"]);
  });

  it("parses several events in one chunk", () => {
    const { events, feed } = collect();
    feed("data: 1\n\ndata: 2\n\ndata: 3\n\n");
    expect(events).toEqual(["1", "2", "3"]);
  });
});

describe("createDownTracker", () => {
  it("reports 0 for a first connect with no prior disconnect", () => {
    expect(createDownTracker().onConnect(1_000)).toBe(0);
  });

  it("measures an outage from its first failed moment through retries", () => {
    const tracker = createDownTracker();
    tracker.onDisconnect(1_000);
    tracker.onDisconnect(3_000); // later retry failures don't move the start
    expect(tracker.onConnect(6_000)).toBe(5_000);
  });

  it("measures each outage from ITS OWN disconnect, not the first-ever one", () => {
    // Live regression (2026-09-01): down_ms grew 1s → 303s → 605s → 907s
    // across ~5-minute cull cycles because the window was never reset.
    const tracker = createDownTracker();
    tracker.onDisconnect(1_000);
    expect(tracker.onConnect(2_000)).toBe(1_000);
    tracker.onDisconnect(302_000);
    expect(tracker.onConnect(303_000)).toBe(1_000); // not 302_000
    tracker.onDisconnect(604_000);
    expect(tracker.onConnect(607_000)).toBe(3_000); // not 606_000
  });
});
