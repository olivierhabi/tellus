import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { DeveloperConsoleArtifactRegistry } from './artifactRegistryService';

interface ArtifactBuildJob {
  id: string;
  application_id: string;
  sdk_version_id: string;
  attempt_count: number;
  max_attempts: number;
}

/**
 * Retries durable SDK publication jobs after API-process, object-store, or
 * network failures. Claims are horizontally safe through SKIP LOCKED leases.
 * The artifact key is content-addressed, so retrying publication cannot mutate
 * bytes already published for a version.
 */
export async function runDeveloperConsoleArtifactBuildBatch(
  knex: Knex,
  batchSize = 5,
): Promise<{ claimed: number; published: number; failed: number; deadLettered: number }> {
  const leaseOwner = `${process.pid}:${crypto.randomUUID()}`;
  const jobs = await knex.transaction(async (trx) => {
    const claimed = (await trx<ArtifactBuildJob>('tpa_sdk_build_jobs')
      .whereIn('state', ['queued', 'failed'])
      .andWhere('next_attempt_at', '<=', trx.fn.now())
      .where(function availableLease() {
        this.whereNull('lease_expires_at').orWhere('lease_expires_at', '<', trx.fn.now());
      })
      .andWhere('attempt_count', '<', trx.ref('max_attempts'))
      .forUpdate()
      .skipLocked()
      .limit(Math.min(Math.max(batchSize, 1), 25))) as ArtifactBuildJob[];
    if (claimed.length) {
      await trx('tpa_sdk_build_jobs')
        .whereIn('id', claimed.map((job) => job.id))
        .update({
          state: 'running',
          lease_owner: leaseOwner,
          lease_expires_at: trx.raw(`now() + interval '5 minutes'`),
          updated_at: trx.fn.now(),
        });
    }
    return claimed;
  });

  let published = 0;
  let failed = 0;
  let deadLettered = 0;
  const registry = new DeveloperConsoleArtifactRegistry(knex);
  for (const job of jobs) {
    try {
      const version = await knex('tpa_sdk_versions as v')
        .join('third_party_applications as a', 'a.id', 'v.application_id')
        .where('v.id', job.sdk_version_id)
        .select(
          'v.id as sdk_version_id',
          'v.version',
          'v.package_name',
          'v.package_files',
          'v.resource_snapshot',
          'v.ontology_id',
          'a.id as application_id',
          'a.rid as application_rid',
          'a.tenant_id',
        )
        .first();
      if (!version) throw new Error('SDK build source row no longer exists');
      const sourceFiles =
        typeof version.package_files === 'string'
          ? JSON.parse(version.package_files)
          : version.package_files;
      if (!sourceFiles || !Object.keys(sourceFiles).length) {
        throw new Error('SDK build source files are empty');
      }
      const resourceSnapshot =
        typeof version.resource_snapshot === 'string'
          ? JSON.parse(version.resource_snapshot)
          : version.resource_snapshot;
      await registry.publish({
        tenantId: version.tenant_id,
        applicationId: version.application_id,
        applicationRid: version.application_rid,
        sdkVersionId: version.sdk_version_id,
        packageName: version.package_name,
        version: version.version,
        ontologyId: version.ontology_id,
        resourceSnapshot,
        sourceFiles,
      });
      await knex('tpa_sdk_build_jobs').where({ id: job.id, lease_owner: leaseOwner }).update({
        state: 'published',
        attempt_count: job.attempt_count + 1,
        lease_owner: null,
        lease_expires_at: null,
        error_message: null,
        updated_at: knex.fn.now(),
      });
      published += 1;
    } catch (err) {
      const attempts = job.attempt_count + 1;
      const deadLetter = attempts >= job.max_attempts;
      const delaySeconds = Math.min(2 ** Math.min(attempts, 10), 3600);
      await knex('tpa_sdk_build_jobs').where({ id: job.id, lease_owner: leaseOwner }).update({
        state: deadLetter ? 'dead_letter' : 'failed',
        attempt_count: attempts,
        lease_owner: null,
        lease_expires_at: null,
        next_attempt_at: knex.raw(`now() + (? * interval '1 second')`, [delaySeconds]),
        error_message: (err instanceof Error ? err.message : String(err)).slice(0, 4000),
        updated_at: knex.fn.now(),
      });
      await knex('tpa_sdk_versions').where({ id: job.sdk_version_id }).update({ status: 'failed' });
      if (deadLetter) deadLettered += 1;
      else failed += 1;
    }
  }
  return { claimed: jobs.length, published, failed, deadLettered };
}

let interval: NodeJS.Timeout | null = null;

export function startDeveloperConsoleArtifactBuildWorker(knex: Knex): void {
  if (interval || process.env.DEVELOPER_CONSOLE_ARTIFACT_WORKER_DISABLED === 'true') return;
  const tick = async () => {
    try {
      const result = await runDeveloperConsoleArtifactBuildBatch(knex);
      if (result.claimed > 0) {
        console.log(JSON.stringify({ type: 'developer_console.artifact_build', ...result }));
      }
    } catch (err) {
      console.warn(JSON.stringify({
        type: 'developer_console.artifact_build_error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };
  interval = setInterval(() => void tick(), 10_000);
  interval.unref();
  void tick();
}

export function stopDeveloperConsoleArtifactBuildWorker(): void {
  if (interval) clearInterval(interval);
  interval = null;
}
