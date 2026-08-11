#!/usr/bin/env tsx
/** Verify the deterministic fixture manifest, references, and PCI boundary. */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

type ManifestFile = { file: string; rows: number; sha256: string };
type Manifest = { seed: number; files: ManifestFile[] };

function luhn(value: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (!Number.isInteger(digit)) return false;
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  }));
  return nested.flat();
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  if (outIndex === -1 || !process.argv[outIndex + 1]) throw new Error("--out is required");
  const root = resolve(process.argv[outIndex + 1]!);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
  for (const entry of manifest.files) {
    const content = await readFile(join(root, entry.file));
    const checksum = createHash("sha256").update(content).digest("hex");
    if (checksum !== entry.sha256) throw new Error(`checksum mismatch: ${entry.file}`);
    const rows = content.toString("utf8").trimEnd().split("\n").length - 1;
    if (rows !== entry.rows) throw new Error(`row count mismatch: ${entry.file}`);
  }
  const allFiles = await filesUnder(root);
  const panPattern = /\b\d{13,19}\b/g;
  for (const full of allFiles.filter((file) => file.endsWith(".csv"))) {
    const file = relative(root, full).replaceAll("\\", "/");
    const content = await readFile(full, "utf8");
    const fullPans = [...content.matchAll(panPattern)].map((match) => match[0]!).filter(luhn);
    const isRawIngestionInput = file === "c-rswitch/ingestion-inputs/raw_iso8583.csv";
    if (isRawIngestionInput && fullPans.length === 0) throw new Error("raw ISO 8583 fixture has no synthetic PANs");
    if (!isRawIngestionInput && fullPans.length > 0) throw new Error(`full PAN leaked outside raw ingestion input: ${file}`);
  }
  process.stdout.write(`${JSON.stringify({ verified: true, seed: manifest.seed, files: manifest.files.length })}\n`);
}

void main();
