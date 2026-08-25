import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildSdkArtifact } from '../../../src/services/developerConsole/artifactRegistryService';

const sources = {
  'package.json': JSON.stringify({
    peerDependencies: { '@osdk/client': '^2.0.0' },
  }),
  'src/index.ts': [
    'export interface Taxpayer {',
    '  id: string;',
    '  active?: boolean;',
    '}',
    'export const ontologyId = "ontology-1";',
    '',
  ].join('\n'),
  'README.md': '# Generated SDK\n',
};

const provenance = {
  applicationRid: 'ri.third-party-applications.main.application.test',
  ontologyId: 'ontology-1',
  resourceSnapshotDigest: 'abc123',
};

describe('Developer Console immutable artifact builder', () => {
  it('builds deterministic npm-compatible bytes with declarations and supply-chain metadata', () => {
    const first = buildSdkArtifact('@acme/tax-sdk', '1.2.3', sources, provenance);
    const second = buildSdkArtifact('@acme/tax-sdk', '1.2.3', sources, provenance);

    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.digest).toBe(second.digest);
    expect(first.tarball.equals(second.tarball)).toBe(true);
    expect(Object.keys(first.files)).toEqual(
      expect.arrayContaining([
        'dist/index.js',
        'dist/index.js.map',
        'dist/index.d.ts',
        'package.json',
        'README.md',
        'sbom.cdx.json',
        'provenance.json',
      ]),
    );
    expect(first.files['dist/index.d.ts'].toString()).toContain('interface Taxpayer');
    expect(JSON.parse(first.files['package.json'].toString())).toMatchObject({
      name: '@acme/tax-sdk',
      version: '1.2.3',
      main: './dist/index.js',
      types: './dist/index.d.ts',
    });
    expect(JSON.parse(first.files['sbom.cdx.json'].toString())).toMatchObject({
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
    });
    expect(JSON.parse(first.files['provenance.json'].toString())).toMatchObject({
      predicateType: 'https://slsa.dev/provenance/v1',
      invocation: provenance,
      policy: { status: 'passed' },
      signature: { algorithm: 'hmac-sha256' },
    });
    expect(gunzipSync(first.tarball).subarray(257, 262).toString()).toBe('ustar');
  });

  it('changes the digest whenever published source changes', () => {
    const original = buildSdkArtifact('@acme/tax-sdk', '1.2.3', sources, provenance);
    const changed = buildSdkArtifact(
      '@acme/tax-sdk',
      '1.2.3',
      { ...sources, 'src/index.ts': `${sources['src/index.ts']}export const revision = 2;\n` },
      provenance,
    );
    expect(changed.digest).not.toBe(original.digest);
  });

  it('rejects lifecycle scripts, non-registry dependencies, and embedded secrets', () => {
    expect(() =>
      buildSdkArtifact(
        '@acme/tax-sdk',
        '1.2.3',
        { ...sources, 'package.json': JSON.stringify({ scripts: { postinstall: 'curl bad' } }) },
        provenance,
      ),
    ).toThrow(/lifecycle scripts/);
    expect(() =>
      buildSdkArtifact(
        '@acme/tax-sdk',
        '1.2.3',
        { ...sources, 'package.json': JSON.stringify({ dependencies: { bad: 'git+https://example.test/bad' } }) },
        provenance,
      ),
    ).toThrow(/prohibited non-registry source/);
    expect(() =>
      buildSdkArtifact(
        '@acme/tax-sdk',
        '1.2.3',
        { ...sources, 'src/index.ts': 'const clientSecret = "not-allowed-in-an-artifact";' },
        provenance,
      ),
    ).toThrow(/Potential secret detected/);
  });
});
