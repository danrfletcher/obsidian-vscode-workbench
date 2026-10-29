/**
 * The framing between the plugin and the Python PTY helper (`pty_helper.py`), which
 * talk only over the helper's stdin and stdout pipes (F4).
 *
 * A frame is one type byte, a 4-byte big-endian payload length, then the payload.
 *
 *   plugin -> helper   "I"  input bytes for the shell
 *                      "W"  resize: rows (uint16 BE) then cols (uint16 BE)
 *   helper -> plugin   "O"  output bytes from the shell
 *                      "X"  the shell has exited: exit code (int32 BE; minus the
 *                           signal number when a signal ended it)
 *
 * `pty_helper.py` implements the same format; keep the two in step.
 */

export const FRAME_INPUT = 0x49; // "I"
export const FRAME_RESIZE = 0x57; // "W"
export const FRAME_OUTPUT = 0x4f; // "O"
export const FRAME_EXIT = 0x58; // "X"

/** The most payload bytes one frame carries; longer input is sent as several frames. */
export const MAX_PAYLOAD = 1 << 20;

export interface Frame {
  type: number;
  payload: Buffer;
}

export class ProtocolError extends Error {}

function frame(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/** Input for the shell as one or more input frames (a string is sent as UTF-8). */
export function encodeInput(data: string | Uint8Array): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  if (bytes.length === 0) return Buffer.alloc(0);
  const frames: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += MAX_PAYLOAD) frames.push(frame(FRAME_INPUT, bytes.subarray(at, at + MAX_PAYLOAD)));
  return Buffer.concat(frames);
}

function dimension(n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 0xffff) : 1;
}

/** A resize frame: the helper sets the pseudo-terminal's window size (TIOCSWINSZ) to `rows` x `cols`. */
export function encodeResize(size: { rows: number; cols: number }): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(dimension(size.rows), 0);
  payload.writeUInt16BE(dimension(size.cols), 2);
  return frame(FRAME_RESIZE, payload);
}

/** The window size in a resize frame's payload. */
export function decodeResize(payload: Buffer): { rows: number; cols: number } {
  if (payload.length !== 4) throw new ProtocolError(`a resize frame holds 4 bytes, not ${payload.length}`);
  return { rows: payload.readUInt16BE(0), cols: payload.readUInt16BE(2) };
}

/** The exit code in an exit frame's payload. */
export function decodeExit(payload: Buffer): number {
  if (payload.length !== 4) throw new ProtocolError(`an exit frame holds 4 bytes, not ${payload.length}`);
  return payload.readInt32BE(0);
}

/** Reassembles frames from a byte stream that arrives in arbitrary pieces. */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  /** Add bytes; returns every frame now complete. Throws ProtocolError on a frame longer than MAX_PAYLOAD. */
  push(chunk: Uint8Array): Frame[] {
    this.pending = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    const out: Frame[] = [];
    for (;;) {
      if (this.pending.length < 5) break;
      const length = this.pending.readUInt32BE(1);
      if (length > MAX_PAYLOAD) throw new ProtocolError(`a frame of ${length} bytes is over the limit of ${MAX_PAYLOAD}`);
      if (this.pending.length < 5 + length) break;
      out.push({ type: this.pending[0], payload: Buffer.from(this.pending.subarray(5, 5 + length)) });
      this.pending = this.pending.subarray(5 + length);
    }
    return out;
  }
}
