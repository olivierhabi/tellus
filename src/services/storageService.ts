import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  GetBucketVersioningCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// Configuration — all from environment, with safe defaults for local dev
// ---------------------------------------------------------------------------

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Presigned URL expiry in seconds (default 3600 = 1h) */
  presignedUrlExpiry: number;
}

function loadStorageConfig(): StorageConfig {
  return {
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'tellus-uploads',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'minioadmin',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    presignedUrlExpiry: parseInt(process.env.S3_PRESIGNED_URL_EXPIRY || '3600', 10),
  };
}

// ---------------------------------------------------------------------------
// S3 Client Singleton
// ---------------------------------------------------------------------------

let _client: S3Client | null = null;
let _config: StorageConfig | null = null;

function getClient(): S3Client {
  if (!_client) {
    _config = loadStorageConfig();
    _client = new S3Client({
      endpoint: _config.endpoint,
      region: _config.region,
      credentials: {
        accessKeyId: _config.accessKeyId,
        secretAccessKey: _config.secretAccessKey,
      },
      forcePathStyle: _config.forcePathStyle,
    });
  }
  return _client;
}

function getConfig(): StorageConfig {
  if (!_config) {
    getClient(); // initializes _config as side-effect
  }
  return _config!;
}

// ---------------------------------------------------------------------------
// Public API — Production-grade object storage operations
// ---------------------------------------------------------------------------

/**
 * Builds the S3 object key for a dataset file.
 *
 * Key structure: `projects/{projectId}/[folders/{folderId}/]{uuid}_{filename}`
 * or for project-level: `projects/{projectId}/_project_uploads/{uuid}_{filename}`
 */
export function buildObjectKey(
  projectId: string,
  folderId: string | null,
  fileName: string
): string {
  if (folderId) {
    return `projects/${projectId}/folders/${folderId}/${fileName}`;
  }
  return `projects/${projectId}/_project_uploads/${fileName}`;
}

/**
 * Upload a file buffer to object storage.
 * Uses multipart upload for large files (> 5MB) automatically via @aws-sdk/lib-storage.
 */
export async function uploadObject(
  key: string,
  body: Buffer,
  contentType: string,
  metadata?: Record<string, string>
): Promise<{ key: string; bucket: string; size: number }> {
  const config = getConfig();
  const client = getClient();

  const upload = new Upload({
    client,
    params: {
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: metadata,
    },
    // Multipart threshold: 5 MB (files larger than this are split)
    partSize: 5 * 1024 * 1024,
    queueSize: 4,
  });

  await upload.done();

  return { key, bucket: config.bucket, size: body.length };
}

/**
 * Retrieve an object as a readable stream. Suitable for piping to
 * CSV parsers or HTTP responses.
 */
export async function getObjectStream(key: string): Promise<Readable> {
  const config = getConfig();
  const client = getClient();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    })
  );

  if (!response.Body) {
    throw new Error(`Empty response body for key: ${key}`);
  }

  return response.Body as Readable;
}

/**
 * Retrieve the full object as a Buffer (for small files only).
 */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const stream = await getObjectStream(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Get object metadata (size, content-type, etc.) without downloading the body.
 */
export async function headObject(key: string): Promise<{
  contentLength: number;
  contentType: string | undefined;
  lastModified: Date | undefined;
  metadata: Record<string, string> | undefined;
}> {
  const config = getConfig();
  const client = getClient();

  const response = await client.send(
    new HeadObjectCommand({
      Bucket: config.bucket,
      Key: key,
    })
  );

  return {
    contentLength: response.ContentLength ?? 0,
    contentType: response.ContentType,
    lastModified: response.LastModified,
    metadata: response.Metadata,
  };
}

/**
 * PB-B6 — extended head that captures ETag + VersionId so the preview
 * pinning path can read back an exact object revision. The legacy
 * `headObject()` is kept for callers that only need length/type.
 */
export async function headObjectWithVersion(key: string): Promise<{
  contentLength: number;
  contentType: string | undefined;
  lastModified: Date | undefined;
  etag: string | null;
  versionId: string | null;
}> {
  const config = getConfig();
  const client = getClient();
  const response = await client.send(
    new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
  );
  return {
    contentLength: response.ContentLength ?? 0,
    contentType: response.ContentType,
    lastModified: response.LastModified,
    etag: response.ETag ? response.ETag.replace(/^"|"$/g, "") : null,
    versionId: response.VersionId ?? null,
  };
}

/**
 * PB-B6 — read an object by a specific version id (S3 versioning) OR
 * assert the ETag hasn't moved since the preview (strong-consistency
 * fallback for unversioned buckets if the caller chose to live with
 * ETag-only pinning). Throws PREVIEW_SNAPSHOT_EXPIRED when the target
 * version/etag is gone.
 */
export async function getObjectStreamPinned(
  key: string,
  pin: { versionId?: string | null; etag?: string | null },
): Promise<Readable> {
  const config = getConfig();
  const client = getClient();
  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        VersionId: pin.versionId ?? undefined,
        IfMatch: pin.etag ? `"${pin.etag}"` : undefined,
      }),
    );
    return response.Body as Readable;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const notFound =
      e.name === "NoSuchVersion" ||
      e.name === "NotFound" ||
      e.$metadata?.httpStatusCode === 404 ||
      e.$metadata?.httpStatusCode === 412;
    if (notFound) {
      const err2 = new Error(
        `Object revision for key '${key}' is no longer available (version/etag mismatch).`,
      );
      (err2 as Error & { code?: string; httpStatus?: number }).code =
        "PREVIEW_SNAPSHOT_EXPIRED";
      (err2 as Error & { httpStatus?: number }).httpStatus = 410;
      throw err2;
    }
    throw err;
  }
}

/**
 * PB-B6 — is the configured bucket S3-versioning-enabled? Preview
 * creation on non-Iceberg inputs requires this; without it we would
 * only have ETag-based pinning which doesn't defend against overwrites.
 * Returns true on `Enabled`, false on `Suspended` / missing / error.
 */
export async function isBucketVersioningEnabled(): Promise<boolean> {
  const config = getConfig();
  const client = getClient();
  try {
    const res = await client.send(
      new GetBucketVersioningCommand({ Bucket: config.bucket }),
    );
    return res.Status === "Enabled";
  } catch {
    return false;
  }
}

/**
 * Generate a presigned download URL for direct client-side download.
 */
export async function getPresignedDownloadUrl(
  key: string,
  expiresInSeconds?: number
): Promise<string> {
  const config = getConfig();
  const client = getClient();

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }),
    { expiresIn: expiresInSeconds ?? config.presignedUrlExpiry }
  );
}

/**
 * Delete a single object from storage.
 * Silently succeeds if the object does not exist (S3 semantics).
 */
export async function deleteObject(key: string): Promise<void> {
  const config = getConfig();
  const client = getClient();

  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key,
    })
  );
}

/**
 * Delete multiple objects in a single batch request.
 * S3 supports up to 1000 keys per batch. This function handles chunking.
 */
export async function deleteObjects(keys: string[]): Promise<{ deleted: number; errors: number }> {
  if (keys.length === 0) return { deleted: 0, errors: 0 };

  const config = getConfig();
  const client = getClient();

  let deleted = 0;
  let errors = 0;
  const BATCH_SIZE = 1000;

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);

    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: {
          Objects: batch.map((key) => ({ Key: key })),
          Quiet: false,
        },
      })
    );

    deleted += response.Deleted?.length ?? 0;
    errors += response.Errors?.length ?? 0;
  }

  return { deleted, errors };
}

/**
 * List all object keys under a given prefix.
 * Handles pagination automatically for large result sets.
 */
export async function listObjects(prefix: string): Promise<string[]> {
  const config = getConfig();
  const client = getClient();
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      })
    );

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key) keys.push(obj.Key);
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

/**
 * Delete all objects under a prefix (e.g., when deleting an entire project).
 */
export async function deletePrefix(prefix: string): Promise<{ deleted: number; errors: number }> {
  const keys = await listObjects(prefix);
  if (keys.length === 0) return { deleted: 0, errors: 0 };
  return deleteObjects(keys);
}

/**
 * Check whether an object exists in the bucket.
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await headObject(key);
    return true;
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === 'NotFound' || name === 'NoSuchKey') return false;
    throw err;
  }
}

/**
 * Ensure the configured bucket exists. Creates it if necessary.
 * Called once at server startup.
 */
export async function ensureBucket(): Promise<void> {
  const config = getConfig();
  const client = getClient();

  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    console.log(`[storage] Bucket "${config.bucket}" exists`);
  } catch (err: unknown) {
    const statusCode = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (statusCode === 404 || name === 'NotFound' || name === 'NoSuchBucket') {
      console.log(`[storage] Creating bucket "${config.bucket}"...`);
      await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
      console.log(`[storage] Bucket "${config.bucket}" created`);
    } else {
      throw err;
    }
  }
}

/**
 * Health check: verifies S3/MinIO is reachable and the bucket exists.
 */
export async function storageHealthCheck(): Promise<{ status: string; bucket: string; endpoint: string }> {
  const config = getConfig();
  const client = getClient();

  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return { status: 'connected', bucket: config.bucket, endpoint: config.endpoint };
  } catch (err: unknown) {
    return {
      status: 'disconnected',
      bucket: config.bucket,
      endpoint: config.endpoint,
    };
  }
}

/**
 * Graceful shutdown: destroy the S3 client.
 */
export function destroyStorageClient(): void {
  if (_client) {
    _client.destroy();
    _client = null;
    _config = null;
  }
}
