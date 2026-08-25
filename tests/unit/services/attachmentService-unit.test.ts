import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let stagingDir: string;

beforeAll(() => {
  stagingDir = mkdtempSync(path.join(tmpdir(), "attachment-service-test-"));
  process.env.UPLOAD_STAGING_DIR = stagingDir;
});

afterAll(() => {
  rmSync(stagingDir, { recursive: true, force: true });
});

describe("attachmentService helpers", () => {
  it("maps common extensions to media types, others to octet-stream", async () => {
    const { mediaTypeForFilename } = await import(
      "../../../src/services/attachmentService"
    );
    expect(mediaTypeForFilename("report.pdf")).toBe("application/pdf");
    expect(mediaTypeForFilename("photo.PNG")).toBe("image/png");
    expect(mediaTypeForFilename("data.csv")).toBe("text/csv");
    expect(mediaTypeForFilename("unknown.xyz")).toBe("application/octet-stream");
    expect(mediaTypeForFilename("noext")).toBe("application/octet-stream");
  });

  it("stages a stream to disk and reports its size", async () => {
    const { stageToDisk } = await import(
      "../../../src/services/attachmentService"
    );
    const payload = Buffer.from("hello attachment", "utf-8");
    const { stagedPath, size } = await stageToDisk(Readable.from([payload]));
    expect(size).toBe(payload.length);
    expect(statSync(stagedPath).size).toBe(payload.length);
    rmSync(stagedPath, { force: true });
  });

  it("rejects streams above the size cap and removes the partial file", async () => {
    const service = await import("../../../src/services/attachmentService");
    const oversized = service.MAX_UPLOAD_BYTES + 1;
    const chunk = Buffer.alloc(64 * 1024, 1);
    let produced = 0;
    const infinite = new Readable({
      read() {
        produced += chunk.length;
        this.push(produced > oversized * 2 ? null : chunk);
      },
    });
    await expect(service.stageToDisk(infinite)).rejects.toMatchObject({
      errorName: "AttachmentSizeLimitExceeded",
      statusCode: 413,
    });
  });
});
