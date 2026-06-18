// ---------------------------------------------------------------------------
// B2 — MIME inference for tree/blob entries (B2-C-11 / F2-C-07).
//
// Extension-driven mapping. Pure; deterministic. Falls back to either
// `text/plain` (text) or `application/octet-stream` (binary) when the
// extension is unknown.
//
// Scope: only the extensions F2 needs to render correctly are listed.
// Adding a new extension is a one-line patch — keep the table sorted by
// kind so reviewers can spot collisions.
// ---------------------------------------------------------------------------

const EXTENSION_TO_MIME: Readonly<Record<string, string>> = Object.freeze({
  // ---- text -------------------------------------------------------------
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  scss: "text/x-scss",
  // ---- code -------------------------------------------------------------
  ts: "text/typescript",
  tsx: "text/typescript",
  mts: "text/typescript",
  cts: "text/typescript",
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  py: "text/x-python",
  rb: "text/x-ruby",
  rs: "text/x-rust",
  go: "text/x-go",
  java: "text/x-java",
  kt: "text/x-kotlin",
  scala: "text/x-scala",
  swift: "text/x-swift",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  cs: "text/x-csharp",
  php: "text/x-php",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  // ---- structured -------------------------------------------------------
  json: "application/json",
  jsonc: "application/json",
  yml: "text/yaml",
  yaml: "text/yaml",
  toml: "application/toml",
  xml: "application/xml",
  sql: "application/sql",
  proto: "text/x-protobuf",
  // ---- images (rendered inline by F2-C-06 image branch) -----------------
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/vnd.microsoft.icon",
  bmp: "image/bmp",
});

/**
 * Infer a MIME type from a file path.
 *
 * The `isBinary` flag is consulted only when the extension is unknown —
 * if a known extension says `text/markdown`, that wins even if the
 * binary detector flagged the buffer (corrupt markdown is still
 * markdown for content-type purposes).
 */
export function mimeForPath(path: string, isBinary: boolean): string {
  const ext = extensionOf(path);
  if (ext) {
    const m = EXTENSION_TO_MIME[ext];
    if (m) return m;
  }
  return isBinary ? "application/octet-stream" : "text/plain";
}

/** Lower-cased file extension (without dot), or `null`. */
export function extensionOf(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const tail = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = tail.lastIndexOf(".");
  if (dot <= 0 || dot === tail.length - 1) return null;
  return tail.slice(dot + 1).toLowerCase();
}
