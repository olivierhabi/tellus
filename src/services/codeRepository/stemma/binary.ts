// ---------------------------------------------------------------------------
// B2 — Binary-file detection (B2-C-11 / F2-C-06).
//
// Pure heuristic; no external dependencies. Two-stage strategy:
//   1. Magic-byte sniff for common formats (PNG, JPEG, GIF, WEBP, PDF, ZIP,
//      ELF, Mach-O). These are unambiguous → fast path.
//   2. Fall back to scanning the first 8 KiB for a NUL byte. NUL in the
//      leading window is the canonical "this is binary" signal git uses.
//
// Spec contract: brief Step 2 — "scan first 8 KB for null bytes; fall back
// to libmagic if available". libmagic is not on the deploy image; the
// magic-byte table here covers everything F2-C-06 cares about (image
// inline rendering + binary placeholder branching).
// ---------------------------------------------------------------------------

const SCAN_BYTES = 8192;

/** Returns `true` iff the buffer is binary by Stemma's heuristic. */
export function detectBinary(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  if (matchesAnyMagic(buf)) return true;
  const n = Math.min(buf.length, SCAN_BYTES);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Returns `true` iff the buffer's leading bytes match a known binary
 * magic-byte signature. Conservative — only matches signatures we
 * actively want to surface as binary in the file viewer.
 */
export function matchesAnyMagic(buf: Uint8Array): boolean {
  for (const sig of SIGNATURES) {
    if (buf.length < sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buf[i] !== sig[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

const SIGNATURES: ReadonlyArray<Uint8Array> = [
  // PNG  : 89 50 4E 47 0D 0A 1A 0A
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  // JPEG : FF D8 FF
  new Uint8Array([0xff, 0xd8, 0xff]),
  // GIF  : "GIF87a" | "GIF89a"
  new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]),
  new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  // WEBP : "RIFF....WEBP" — sniff the first 4 bytes only (RIFF)
  new Uint8Array([0x52, 0x49, 0x46, 0x46]),
  // PDF  : "%PDF-"
  new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
  // ZIP  : "PK\x03\x04"
  new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  // GZIP : 1F 8B
  new Uint8Array([0x1f, 0x8b]),
  // ELF  : 7F 45 4C 46
  new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
  // Mach-O 64 LE : CF FA ED FE  /  64 BE : FE ED FA CF
  new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]),
  new Uint8Array([0xfe, 0xed, 0xfa, 0xcf]),
];
