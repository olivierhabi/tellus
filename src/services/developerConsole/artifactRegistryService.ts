import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Knex } from 'knex';
import ts from 'typescript';
import { AppError } from '../../utils/foundryAppError';
import {
  getObjectBuffer,
  headObject,
  objectExists,
  uploadObject,
} from '../storageService';

export interface BuiltSdkArtifact {
  packageName: string;
  version: string;
  tarball: Buffer;
  digest: string;
  files: Record<string, Buffer>;
  manifest: Record<string, unknown>;
}

interface ArtifactPolicyReport {
  status: 'passed';
  scannedFiles: number;
  dependencyCount: number;
  checks: string[];
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function scanSdkSource(sourceFiles: Record<string, string>): ArtifactPolicyReport {
  const packageJson = JSON.parse(sourceFiles['package.json'] ?? '{}') as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  if (packageJson.scripts && Object.keys(packageJson.scripts).length > 0) {
    throw new AppError('Generated SDK packages may not contain lifecycle scripts', 422, 'ARTIFACT_POLICY_REJECTED');
  }
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.peerDependencies ?? {}),
  };
  for (const [name, range] of Object.entries(dependencies)) {
    if (/^(?:file:|git(?:\+|:)|https?:|workspace:|link:)/i.test(range)) {
      throw new AppError(
        `Dependency ${name} uses a prohibited non-registry source`,
        422,
        'ARTIFACT_POLICY_REJECTED',
      );
    }
  }
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:clientSecret|client_secret|password)\s*[:=]\s*["'][^"']{12,}["']/i,
  ];
  for (const [path, source] of Object.entries(sourceFiles)) {
    if (secretPatterns.some((pattern) => pattern.test(source))) {
      throw new AppError(`Potential secret detected in ${path}`, 422, 'ARTIFACT_SECRET_DETECTED');
    }
  }
  return {
    status: 'passed',
    scannedFiles: Object.keys(sourceFiles).length,
    dependencyCount: Object.keys(dependencies).length,
    checks: ['no-lifecycle-scripts', 'registry-dependencies-only', 'generated-source-secret-scan'],
  };
}

function artifactAttestationSignature(payload: string): { algorithm: string; value: string } {
  const configured = process.env.TELLUS_ARTIFACT_SIGNING_KEY?.trim();
  if (process.env.NODE_ENV === 'production' && !configured) {
    throw new AppError(
      'TELLUS_ARTIFACT_SIGNING_KEY is required for production artifact publication',
      503,
      'ARTIFACT_SIGNING_UNAVAILABLE',
    );
  }
  const key = configured ?? 'tellus-development-artifact-signing-key-not-for-production';
  return {
    algorithm: 'hmac-sha256',
    value: crypto.createHmac('sha256', key).update(payload).digest('base64'),
  };
}

function tarOctal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0', 'ascii');
}

function tarHeader(name: string, size: number): Buffer {
  if (!name || name.length > 100 || name.includes('..') || name.startsWith('/')) {
    throw new AppError(`Unsafe artifact path: ${name}`, 500, 'ARTIFACT_PATH_INVALID');
  }
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  tarOctal(0o644, 8).copy(header, 100);
  tarOctal(0, 8).copy(header, 108);
  tarOctal(0, 8).copy(header, 116);
  tarOctal(size, 12).copy(header, 124);
  tarOctal(0, 12).copy(header, 136);
  Buffer.from('        ', 'ascii').copy(header, 148);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('tellus', 265, 6, 'ascii');
  header.write('tellus', 297, 6, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
  return header;
}

function makeTar(files: Record<string, Buffer>): Buffer {
  const chunks: Buffer[] = [];
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    const name = `package/${path}`;
    chunks.push(tarHeader(name, content.length), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function compileSources(sourceFiles: Record<string, string>): Record<string, Buffer> {
  const output: Record<string, Buffer> = {};
  for (const [path, source] of Object.entries(sourceFiles).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.endsWith('.ts')) {
      if (path !== 'package.json') output[path] = Buffer.from(source, 'utf8');
      continue;
    }
    const relative = path.replace(/^src\//, '').replace(/\.ts$/, '');
    const js = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        sourceMap: true,
        inlineSources: true,
      },
      fileName: path,
      reportDiagnostics: true,
    });
    const jsErrors = (js.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (jsErrors.length) {
      throw new AppError(
        `SDK JavaScript compilation failed for ${path}`,
        422,
        'SDK_COMPILE_FAILED',
      );
    }
    output[`dist/${relative}.js`] = Buffer.from(js.outputText, 'utf8');
    if (js.sourceMapText) {
      output[`dist/${relative}.js.map`] = Buffer.from(js.sourceMapText, 'utf8');
    }

    const declaration = ts.transpileDeclaration(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
      fileName: path,
      reportDiagnostics: true,
    });
    const declarationErrors = (declaration.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (declarationErrors.length) {
      throw new AppError(
        `SDK declaration generation failed for ${path}`,
        422,
        'SDK_DECLARATION_FAILED',
      );
    }
    output[`dist/${relative}.d.ts`] = Buffer.from(declaration.outputText, 'utf8');
  }
  return output;
}

export function buildSdkArtifact(
  packageName: string,
  version: string,
  sourceFiles: Record<string, string>,
  provenance: { applicationRid: string; ontologyId: string | null; resourceSnapshotDigest: string },
): BuiltSdkArtifact {
  const policy = scanSdkSource(sourceFiles);
  const compiled = compileSources(sourceFiles);
  const originalManifest = JSON.parse(sourceFiles['package.json'] ?? '{}') as Record<string, unknown>;
  const packageJson: Record<string, unknown> = {
    ...originalManifest,
    name: packageName,
    version,
    private: false,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { import: './dist/index.js', types: './dist/index.d.ts' },
    },
    files: ['dist', 'README.md', 'sbom.cdx.json', 'provenance.json'],
  };
  compiled['package.json'] = Buffer.from(JSON.stringify(packageJson, null, 2) + '\n', 'utf8');

  const dependencyEntries = Object.entries({
    ...((packageJson.dependencies as Record<string, string> | undefined) ?? {}),
    ...((packageJson.peerDependencies as Record<string, string> | undefined) ?? {}),
  }).sort(([a], [b]) => a.localeCompare(b));
  compiled['sbom.cdx.json'] = Buffer.from(
    JSON.stringify(
      {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        version: 1,
        metadata: { component: { type: 'library', name: packageName, version } },
        components: dependencyEntries.map(([name, dependencyVersion]) => ({
          type: 'library',
          name,
          version: dependencyVersion,
        })),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  const attestationPayload = JSON.stringify({
    packageName,
    version,
    sourceDigest: sha256(
      Object.entries(sourceFiles)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, source]) => `${path}\0${source}`)
        .join('\0'),
    ),
    provenance,
    policy,
  });
  compiled['provenance.json'] = Buffer.from(
    JSON.stringify(
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        buildType: 'https://tellus.dev/build-types/osdk/v1',
        subject: { name: packageName, version },
        invocation: provenance,
        policy,
        signature: artifactAttestationSignature(attestationPayload),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const fileDigests = Object.fromEntries(
    Object.entries(compiled)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => [path, { sha256: sha256(content), size: content.length }]),
  );
  // Node emits an mtime of zero for gzip output, so identical inputs produce
  // identical bytes without relying on a version-specific zlib option.
  const tarball = gzipSync(makeTar(compiled), { level: 9 });
  const digest = sha256(tarball);
  return {
    packageName,
    version,
    tarball,
    digest,
    files: compiled,
    manifest: {
      schemaVersion: 1,
      digestAlgorithm: 'sha256',
      digest,
      size: tarball.length,
      files: fileDigests,
      provenance,
      policy,
    },
  };
}

export class DeveloperConsoleArtifactRegistry {
  constructor(private readonly knex: Knex) {}

  async publish(opts: {
    tenantId: string;
    applicationId: string;
    applicationRid: string;
    sdkVersionId: string;
    packageName: string;
    version: string;
    ontologyId: string | null;
    resourceSnapshot: unknown;
    sourceFiles: Record<string, string>;
  }): Promise<BuiltSdkArtifact & { objectKey: string }> {
    const artifact = buildSdkArtifact(opts.packageName, opts.version, opts.sourceFiles, {
      applicationRid: opts.applicationRid,
      ontologyId: opts.ontologyId,
      resourceSnapshotDigest: sha256(JSON.stringify(opts.resourceSnapshot)),
    });
    const objectKey = `developer-console/artifacts/${encodeURIComponent(opts.tenantId)}/${opts.applicationId}/${opts.version}/${artifact.digest}.tgz`;
    if (await objectExists(objectKey)) {
      const existing = await headObject(objectKey);
      if (
        existing.contentLength !== artifact.tarball.length ||
        existing.metadata?.sha256 !== artifact.digest
      ) {
        throw new AppError('Existing artifact failed immutable digest verification', 409, 'ARTIFACT_IMMUTABILITY_VIOLATION');
      }
    } else {
      const artifactSse = process.env.S3_ARTIFACT_SSE?.trim();
      if (process.env.NODE_ENV === 'production' && !artifactSse) {
        throw new AppError(
          'S3_ARTIFACT_SSE must be configured for production artifact publication',
          503,
          'ARTIFACT_ENCRYPTION_UNAVAILABLE',
        );
      }
      await uploadObject(
        objectKey,
        artifact.tarball,
        'application/octet-stream',
        { sha256: artifact.digest, package: opts.packageName, version: opts.version },
        undefined,
        undefined,
        artifactSse
          ? {
              serverSideEncryption: artifactSse === 'aws:kms' ? 'aws:kms' : 'AES256',
              ssekmsKeyId: process.env.S3_ARTIFACT_KMS_KEY_ID,
            }
          : undefined,
      );
    }
    await this.knex('tpa_sdk_versions').where({ id: opts.sdkVersionId }).update({
      artifact_digest: artifact.digest,
      artifact_object_key: objectKey,
      artifact_size_bytes: artifact.tarball.length,
      artifact_manifest: JSON.stringify(artifact.manifest),
      published_at: new Date(),
      status: 'ready',
    });
    return { ...artifact, objectKey };
  }

  async download(applicationId: string, version: string): Promise<{
    packageName: string;
    digest: string;
    tarball: Buffer;
  }> {
    const row = await this.knex('tpa_sdk_versions')
      .where({ application_id: applicationId, version })
      .whereNull('revoked_at')
      .first();
    if (!row?.artifact_object_key || !row?.artifact_digest) {
      throw new AppError('Published artifact not found', 404, 'ARTIFACT_NOT_FOUND');
    }
    const tarball = await getObjectBuffer(row.artifact_object_key);
    const digest = sha256(tarball);
    if (digest !== row.artifact_digest) {
      throw new AppError('Artifact digest verification failed', 502, 'ARTIFACT_DIGEST_MISMATCH');
    }
    return { packageName: row.package_name, digest, tarball };
  }
}
