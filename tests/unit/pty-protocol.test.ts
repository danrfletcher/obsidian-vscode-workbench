import { describe, expect, it } from "vitest";
import {
  FRAME_EXIT,
  FRAME_INPUT,
  FRAME_OUTPUT,
  FRAME_RESIZE,
  FrameDecoder,
  MAX_PAYLOAD,
  ProtocolError,
  decodeExit,
  decodeResize,
  encodeInput,
  encodeResize,
} from "../../src/terminal/pty-protocol";

describe("plugin to helper frames", () => {
  it("frames input as 'I', a 4-byte big-endian length, then the bytes", () => {
    const bytes = encodeInput("ls\n");
    expect([...bytes]).toEqual([0x49, 0, 0, 0, 3, 0x6c, 0x73, 0x0a]);
    expect(FRAME_INPUT).toBe("I".charCodeAt(0));
  });

  it("sends a string as UTF-8, with the length in bytes not characters", () => {
    const bytes = encodeInput("é日");
    expect(bytes.readUInt32BE(1)).toBe(Buffer.byteLength("é日"));
    expect(bytes.subarray(5).toString("utf8")).toBe("é日");
  });

  it("sends raw bytes unchanged, and nothing for empty input", () => {
    const raw = Uint8Array.from([0, 255, 3, 27]);
    expect([...encodeInput(raw).subarray(5)]).toEqual([0, 255, 3, 27]);
    expect(encodeInput("")).toHaveLength(0);
  });

  it("splits input longer than one frame into several frames that decode back to the same bytes", () => {
    const big = Buffer.alloc(MAX_PAYLOAD * 2 + 10, 0x61);
    const frames = new FrameDecoder().push(encodeInput(big));
    expect(frames.map((f) => f.type)).toEqual([FRAME_INPUT, FRAME_INPUT, FRAME_INPUT]);
    expect(Buffer.concat(frames.map((f) => f.payload)).equals(big)).toBe(true);
  });

  it("frames a resize as 'W' with rows then cols, each a big-endian uint16", () => {
    const bytes = encodeResize({ rows: 30, cols: 100 });
    expect([...bytes]).toEqual([0x57, 0, 0, 0, 4, 0, 30, 0, 100]);
    expect(FRAME_RESIZE).toBe("W".charCodeAt(0));
    expect(decodeResize(bytes.subarray(5))).toEqual({ rows: 30, cols: 100 });
  });

  it("keeps a resize inside 1..65535 whatever it is given", () => {
    const decode = (rows: number, cols: number) => decodeResize(encodeResize({ rows, cols }).subarray(5));
    expect(decode(0, -5)).toEqual({ rows: 1, cols: 1 });
    expect(decode(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ rows: 1, cols: 1 });
    expect(decode(1e9, 70000)).toEqual({ rows: 65535, cols: 65535 });
    expect(decode(24.6, 80.4)).toEqual({ rows: 25, cols: 80 });
  });

  it("rejects a resize payload of the wrong size", () => {
    expect(() => decodeResize(Buffer.alloc(3))).toThrow(ProtocolError);
  });
});

describe("helper to plugin frames", () => {
  const frame = (type: number, payload: Buffer) => Buffer.concat([Buffer.from([type, 0, 0, 0, payload.length]), payload]);

  it("decodes output and exit frames", () => {
    const exit = Buffer.alloc(4);
    exit.writeInt32BE(-9);
    const frames = new FrameDecoder().push(Buffer.concat([frame(FRAME_OUTPUT, Buffer.from("hi\r\n")), frame(FRAME_EXIT, exit)]));
    expect(frames.map((f) => f.type)).toEqual([FRAME_OUTPUT, FRAME_EXIT]);
    expect(frames[0].payload.toString()).toBe("hi\r\n");
    expect(decodeExit(frames[1].payload)).toBe(-9);
  });

  it("puts a frame back together from any split of the stream, one byte at a time included", () => {
    const stream = Buffer.concat([frame(FRAME_OUTPUT, Buffer.from("héllo")), frame(FRAME_OUTPUT, Buffer.from("")), frame(FRAME_OUTPUT, Buffer.from("日本"))]);
    for (const size of [1, 2, 3, 5, 7, stream.length]) {
      const decoder = new FrameDecoder();
      const got: string[] = [];
      for (let at = 0; at < stream.length; at += size) for (const f of decoder.push(stream.subarray(at, at + size))) got.push(f.payload.toString());
      expect(got).toEqual(["héllo", "", "日本"]);
    }
  });

  it("waits for the rest of a frame instead of returning half of it", () => {
    const decoder = new FrameDecoder();
    const whole = frame(FRAME_OUTPUT, Buffer.from("abcdef"));
    expect(decoder.push(whole.subarray(0, 3))).toEqual([]);
    expect(decoder.push(whole.subarray(3, 8))).toEqual([]);
    expect(decoder.push(whole.subarray(8))).toHaveLength(1);
  });

  it("rejects a frame whose length is over the limit", () => {
    const head = Buffer.from([FRAME_OUTPUT, 0, 0, 0, 0]);
    head.writeUInt32BE(MAX_PAYLOAD + 1, 1);
    expect(() => new FrameDecoder().push(head)).toThrow(ProtocolError);
  });

  it("rejects an exit frame of the wrong size", () => {
    expect(() => decodeExit(Buffer.alloc(2))).toThrow(ProtocolError);
  });
});
