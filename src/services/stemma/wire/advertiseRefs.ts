// ---------------------------------------------------------------------------
// B1 — smart-HTTP advertise-refs encoder.
//
// On `GET /<repo>/info/refs?service=git-upload-pack`, the server emits:
//
//   001e# service=git-upload-pack\n
//   0000
//   <pktline> <sha> SP <ref-name> NUL <capabilities> LF      -- first ref
//   <pktline> <sha> SP <ref-name> LF                          -- subsequent refs
//   ...
//   0000                                                      -- trailing flush
//
// When the repo has zero refs (a freshly-initialised empty repo), the
// first "ref" is replaced by a synthetic capability advertisement on
// the zero-sha:
//
//   <pktline> 000...0000 SP capabilities^{} NUL <capabilities> LF
//
// per Git's "capabilities^{}" convention.
//
// Spec contracts:
//   B1-C-01  GET /info/refs?service=git-upload-pack
//   B1-C-02  GET /info/refs?service=git-receive-pack
// ---------------------------------------------------------------------------

import { Buffer } from "node:buffer";
import {
  encodeDataLine,
  encodeServiceAdvertisement,
  encodeSentinel,
} from "./pktLine";

const ZERO_SHA = "0".repeat(40);

export type AdvertisedService = "git-upload-pack" | "git-receive-pack";

/** Capabilities advertised for `git-upload-pack` (clone/fetch). */
export const UPLOAD_PACK_CAPABILITIES: readonly string[] = [
  "multi_ack_detailed",
  "no-done",
  "side-band-64k",
  "thin-pack",
  "ofs-delta",
  "agent=tellus-stemma/1.0.0",
];

/** Capabilities advertised for `git-receive-pack` (push). */
export const RECEIVE_PACK_CAPABILITIES: readonly string[] = [
  "report-status",
  "delete-refs",
  "ofs-delta",
  "agent=tellus-stemma/1.0.0",
  // We also advertise the atomic capability so clients can opt-in to
  // multi-ref atomic push semantics that match `applyRefUpdates`.
  "atomic",
];

export interface AdvertisedRef {
  readonly name: string;
  readonly sha: string;
}

/**
 * Encode the full smart-HTTP advertisement for a service.
 *
 * The HEAD ref, if present, MUST be advertised first. By Git
 * convention `HEAD` is followed by the ref it currently points to, but
 * the wire format itself only requires HEAD to come first.
 */
export function encodeRefAdvertisement(args: {
  service: AdvertisedService;
  refs: readonly AdvertisedRef[];
}): Buffer {
  const { service, refs } = args;
  const caps =
    service === "git-upload-pack"
      ? UPLOAD_PACK_CAPABILITIES
      : RECEIVE_PACK_CAPABILITIES;

  const preamble = encodeServiceAdvertisement(service);
  const chunks: Buffer[] = [preamble];

  if (refs.length === 0) {
    // Empty repo — emit the capabilities^{} advertisement.
    const payload = `${ZERO_SHA} capabilities^{}\u0000${caps.join(" ")}\n`;
    chunks.push(encodeDataLine(payload));
  } else {
    // First ref carries the capability list.
    const first = refs[0];
    const firstPayload = `${first.sha} ${first.name}\u0000${caps.join(" ")}\n`;
    chunks.push(encodeDataLine(firstPayload));
    for (let i = 1; i < refs.length; i++) {
      const r = refs[i];
      chunks.push(encodeDataLine(`${r.sha} ${r.name}\n`));
    }
  }

  chunks.push(encodeSentinel("flush"));
  return Buffer.concat(chunks);
}

/** Smart-HTTP service advertisement Content-Type per Git protocol. */
export function advertiseContentType(service: AdvertisedService): string {
  return `application/x-${service}-advertisement`;
}

/** Receive-pack response Content-Type. */
export function receivePackResultContentType(): string {
  return "application/x-git-receive-pack-result";
}
