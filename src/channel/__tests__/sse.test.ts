import { describe, expect, it } from "vitest";
import { createSseParser } from "../sse.js";

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
