// ---------------------------------------------------------------------------
// Preview-snapshot pinning for deploys (extracted from
// services/deploymentService.ts during the god-file breakup —
// behavior-preserving move).
//
// PB-B6 — walk every pipeline_node with a saved previewSnapshot and:
//   * detect chain-hash drift (PREVIEW_STALE unless force / ignore)
//   * aggregate the captured input_snapshots into one audit payload
//   * compute a combined chain-hash digest for the deploy row
//
// Kept free of knex: callers pass the already-loaded node rows. The Iceberg
// expiry probe and the chain-hash helper stay as dynamic imports exactly as
// they were at the call site (same lazy-load + best-effort semantics).
// ---------------------------------------------------------------------------

import { AppError } from '../../utils/foundryAppError';

export interface PreviewPinningFlags {
  force: boolean;
  ignorePreviewSnapshot: boolean;
}

export interface PreviewPinningResult {
  inputSnapshots: Record<string, unknown>;
  chainHashDigest: string | null;
  divergenceWarning: boolean;
  staleNodeIds: string[];
}

/**
 * Returns the aggregated envelope. Throws AppError(PREVIEW_STALE) on
 * drift unless the caller explicitly opted out.
 */
export async function collectPreviewPinning(
  _pipelineId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodes: any[],
  flags: PreviewPinningFlags,
): Promise<PreviewPinningResult> {
  const { chainHashFromNodeConfig } = await import('../pipelines/previewSnapshot');
  const inputSnapshots: Record<string, unknown> = {};
  const staleNodeIds: string[] = [];
  const chainHashes: string[] = [];

  for (const n of nodes) {
    const cfg = typeof n.config === 'string'
      ? JSON.parse(n.config)
      : (n.config ?? {});
    const prev = cfg?.previewSnapshot;
    if (!prev) continue;
    // PB-B6 (d) — every previewed node contributes its input snapshot
    // to the audit map (the output node carries the transforms, the
    // dataset nodes carry the upstream pin).
    if (prev.inputSnapshot || prev.upstreamSnapshotId || prev.chainHash) {
      inputSnapshots[n.id] = {
        datasetId: n.dataset_id ?? prev.datasetId ?? null,
        upstreamSnapshotId: prev.upstreamSnapshotId ?? null,
        s3VersionId: prev.s3VersionId ?? null,
        etag: prev.etag ?? null,
        format: prev.format ?? null,
        chainHash: prev.chainHash ?? null,
        schemaFingerprint: prev.schemaFingerprint ?? null,
        capturedAt: prev.savedAt ?? prev.capturedAt ?? null,
        ...(prev.inputSnapshot ?? {}),
      };
    }
    const current = chainHashFromNodeConfig(cfg);
    if (prev.chainHash && prev.chainHash !== current) {
      staleNodeIds.push(n.id);
    }
    if (prev.chainHash) chainHashes.push(prev.chainHash);
  }

  if (staleNodeIds.length > 0 && !flags.force && !flags.ignorePreviewSnapshot) {
    const err = new AppError(
      `Deploy rejected: ${staleNodeIds.length} pipeline node(s) have a previewSnapshot ` +
        `whose chain hash no longer matches the live transforms. ` +
        `Re-preview the affected nodes or pass \`force: true\` in the body.`,
      409,
      'PREVIEW_STALE',
    );
    (err as unknown as { details?: unknown }).details = { staleNodeIds };
    throw err;
  }

  // PB-B6 spec literal: "If the upstream dataset has been deleted or
  // its snapshot expired (PB-B4 retention policy of 30 days), deploy
  // fails with PREVIEW_SNAPSHOT_EXPIRED". For every Iceberg-format
  // input we probe the catalog's snapshot list and confirm the pinned
  // snapshot_id is still present. The probe uses the shared sidecar —
  // same authority path the preview used to capture the pin — so a
  // race with the retention sweeper is caught here.
  if (!flags.ignorePreviewSnapshot) {
    const expiredNodeIds: string[] = [];
    for (const [nodeId, snap] of Object.entries(inputSnapshots)) {
      const s = snap as Record<string, unknown>;
      if (s.format !== 'iceberg') continue;
      const pinnedId = s.upstreamSnapshotId as string | null;
      const icebergRef = s.icebergRef as
        | { namespace: string; table: string; warehouse?: string }
        | undefined;
      if (!pinnedId || !icebergRef) continue;
      try {
        const { icebergSnapshots } = await import('../pipelines/icebergSidecar');
        const probe = await icebergSnapshots({
          namespace: icebergRef.namespace,
          table: icebergRef.table,
          warehouse: icebergRef.warehouse,
        });
        const present = probe.snapshots.some(
          (s2) => String(s2.snapshot_id) === String(pinnedId),
        );
        if (!present) expiredNodeIds.push(nodeId);
      } catch {
        /* probe best-effort; a flaky sidecar shouldn't block all deploys */
      }
    }
    if (expiredNodeIds.length > 0) {
      const err = new AppError(
        `Deploy rejected: ${expiredNodeIds.length} pipeline input(s) reference an ` +
          `Iceberg snapshot that has been expired by the retention sweeper. ` +
          `Re-preview the affected nodes or pass \`?ignorePreviewSnapshot=true\` to ` +
          `deploy against the latest upstream.`,
        409,
        'PREVIEW_SNAPSHOT_EXPIRED',
      );
      (err as unknown as { details?: unknown }).details = { expiredNodeIds };
      throw err;
    }
  }

  // `divergence_warning` on the deploy row means: the caller chose to
  // run against the live upstream rather than the captured pin. That's
  // driven by ?ignorePreviewSnapshot=true — force alone (chain-only
  // override) does NOT trip this flag.
  const divergenceWarning = flags.ignorePreviewSnapshot;

  // Composite chain-hash digest so a single column on the deployment
  // row can be correlated with the per-node chainHashes captured in
  // input_snapshots. We hash the SORTED list of node-level hashes so
  // the deploy of the same pipeline state yields the same digest.
  let chainHashDigest: string | null = null;
  if (chainHashes.length > 0) {
    const { createHash } = await import('crypto');
    chainHashDigest = createHash('sha256')
      .update(chainHashes.slice().sort().join('\n'), 'utf-8')
      .digest('hex');
  }

  return { inputSnapshots, chainHashDigest, divergenceWarning, staleNodeIds };
}
