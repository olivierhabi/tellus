// ---------------------------------------------------------------------------
// B1 — receive-pack ref-update command parser.
//
// A receive-pack request body is shaped:
//
//   <command-pkt>
//   <command-pkt>
//   ...
//   <flush>
//   <packfile bytes>      -- optional; absent when only deletes are requested
//
// Each command-pkt is a pkt-line with payload:
//
//   <old-sha> SP <new-sha> SP <ref-name> [NUL <capability list>] LF
//
// The capability list (after a NUL byte) is present ONLY on the FIRST
// command. Subsequent commands carry just the three space-separated
// fields and the trailing LF.
//
// Special SHAs:
//   - "0000000000000000000000000000000000000000" as old-sha = create
//   - "0000000000000000000000000000000000000000" as new-sha = delete
//   - any other (oldSha != newSha != zero) = update
//
// Spec contracts:
//   B1-C-04  receive-pack control surface — parse commands, classify
//            kind (create/update/delete), extract capabilities.
// ---------------------------------------------------------------------------

import type { Buffer } from "node:buffer";
import { decodeOne, decodeUntilFlush, type PktLine } from "./pktLine";

const ZERO_SHA = "0".repeat(40);
const SHA_REGEX = /^[0-9a-f]{40}$/;
const REF_NAME_REGEX = /^[A-Za-z0-9._/-]{1,255}$/;

export type RefUpdateKind = "create" | "update" | "delete";

export interface RefUpdateCommand {
  readonly kind: RefUpdateKind;
  readonly refName: string;
  readonly oldSha: string;
  readonly newSha: string;
}

export interface ParsedReceivePackRequest {
  readonly commands: readonly RefUpdateCommand[];
  readonly capabilities: readonly string[];
  /** Byte offset of the packfile in the original request body. */
  readonly packfileOffset: number;
  /** Bytes after the commands flush — the packfile body (may be empty). */
  readonly packfileBody: Buffer;
}

export class RefUpdateParseError extends Error {
  readonly code:
    | "MALFORMED_COMMAND"
    | "INVALID_SHA"
    | "INVALID_REF_NAME"
    | "EMPTY_REQUEST"
    | "ZERO_TO_ZERO";
  constructor(code: RefUpdateParseError["code"], message: string) {
    super(message);
    this.name = "RefUpdateParseError";
    this.code = code;
  }
}

/**
 * Parse a receive-pack request body. Throws RefUpdateParseError on any
 * malformed framing or invalid command.
 */
export function parseReceivePackRequest(buf: Buffer): ParsedReceivePackRequest {
  if (buf.length === 0) {
    throw new RefUpdateParseError("EMPTY_REQUEST", "request body is empty");
  }

  const { lines, next } = decodeUntilFlush(buf, 0);
  // Strip the trailing flush from the lines we care about.
  const dataLines = lines.filter((l) => l.kind === "data");
  if (dataLines.length === 0) {
    throw new RefUpdateParseError(
      "EMPTY_REQUEST",
      "no command pkt-lines before flush",
    );
  }

  const { commands, capabilities } = parseCommandLines(dataLines);
  return {
    commands,
    capabilities,
    packfileOffset: next,
    packfileBody: buf.subarray(next),
  };
}

function parseCommandLines(lines: readonly PktLine[]): {
  commands: RefUpdateCommand[];
  capabilities: readonly string[];
} {
  const commands: RefUpdateCommand[] = [];
  let capabilities: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].payload.toString("utf8");
    // Strip the trailing LF if present (the protocol always adds one,
    // but tolerate its absence for robustness).
    const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;

    const isFirst = i === 0;
    let body = trimmed;
    if (isFirst) {
      const nulIdx = trimmed.indexOf("\u0000");
      if (nulIdx === -1) {
        // No capabilities; treat the whole line as the command.
        body = trimmed;
        capabilities = [];
      } else {
        body = trimmed.slice(0, nulIdx);
        capabilities = trimmed
          .slice(nulIdx + 1)
          .split(" ")
          .filter((s) => s.length > 0);
      }
    }

    const cmd = parseSingleCommand(body);
    commands.push(cmd);
  }
  return { commands, capabilities };
}

function parseSingleCommand(body: string): RefUpdateCommand {
  const parts = body.split(" ");
  if (parts.length !== 3) {
    throw new RefUpdateParseError(
      "MALFORMED_COMMAND",
      `expected 3 fields, got ${parts.length}: ${JSON.stringify(body)}`,
    );
  }
  const [oldSha, newSha, refName] = parts;
  if (!SHA_REGEX.test(oldSha)) {
    throw new RefUpdateParseError("INVALID_SHA", `bad old-sha ${oldSha}`);
  }
  if (!SHA_REGEX.test(newSha)) {
    throw new RefUpdateParseError("INVALID_SHA", `bad new-sha ${newSha}`);
  }
  if (!REF_NAME_REGEX.test(refName)) {
    throw new RefUpdateParseError(
      "INVALID_REF_NAME",
      `bad ref-name ${JSON.stringify(refName)}`,
    );
  }
  if (oldSha === ZERO_SHA && newSha === ZERO_SHA) {
    throw new RefUpdateParseError(
      "ZERO_TO_ZERO",
      `command for ${refName} has both zero old-sha and zero new-sha`,
    );
  }
  let kind: RefUpdateKind;
  if (oldSha === ZERO_SHA) {
    kind = "create";
  } else if (newSha === ZERO_SHA) {
    kind = "delete";
  } else {
    kind = "update";
  }
  return { kind, refName, oldSha, newSha };
}

/**
 * Re-export the zero-sha sentinel for callers that need to construct
 * receive-pack requests in tests.
 */
export const RECEIVE_PACK_ZERO_SHA = ZERO_SHA;

/**
 * Build a single receive-pack command pkt-line payload (without the
 * length prefix — pass to encodeDataLine). When `capabilities` is
 * provided, this is the first command of the request.
 */
export function buildCommandPayload(args: {
  oldSha: string;
  newSha: string;
  refName: string;
  capabilities?: readonly string[];
}): string {
  const base = `${args.oldSha} ${args.newSha} ${args.refName}`;
  if (args.capabilities && args.capabilities.length > 0) {
    return `${base}\u0000${args.capabilities.join(" ")}\n`;
  }
  return `${base}\n`;
}

/**
 * Helper for unit tests that need a one-line decode without the flush
 * scan. Returns the {command, capabilities} for the very first
 * pkt-line of a buffer.
 */
export function parseFirstCommand(buf: Buffer): {
  command: RefUpdateCommand;
  capabilities: readonly string[];
} {
  const { line } = decodeOne(buf, 0);
  if (line.kind !== "data") {
    throw new RefUpdateParseError(
      "MALFORMED_COMMAND",
      `expected data pkt-line, got ${line.kind}`,
    );
  }
  const text = line.payload.toString("utf8");
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const nulIdx = trimmed.indexOf("\u0000");
  let body: string;
  let caps: readonly string[];
  if (nulIdx === -1) {
    body = trimmed;
    caps = [];
  } else {
    body = trimmed.slice(0, nulIdx);
    caps = trimmed
      .slice(nulIdx + 1)
      .split(" ")
      .filter((s) => s.length > 0);
  }
  return {
    command: parseSingleCommand(body),
    capabilities: caps,
  };
}
