import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { getKeycloakAdminService } from '../keycloakAdminService';

interface ReconciliationJob {
  id: string;
  tenant_id: string;
  application_id: string | null;
  job_type: 'identity_delete';
  attempt_count: number;
  max_attempts: number;
  payload: { keycloakClientUuid?: string };
}

export async function runDeveloperConsoleReconciliationBatch(
  knex: Knex,
  batchSize = 20,
): Promise<{ claimed: number; succeeded: number; failed: number; deadLettered: number }> {
  const leaseOwner = `${process.pid}:${crypto.randomUUID()}`;
  const jobs = await knex.transaction(async (trx) => {
    const claimed = (await trx<ReconciliationJob>('tpa_reconciliation_jobs')
      .whereIn('state', ['pending', 'failed'])
      .andWhere('job_type', 'identity_delete')
      .andWhere('next_attempt_at', '<=', trx.fn.now())
      .where(function availableLease() {
        this.whereNull('lease_expires_at').orWhere('lease_expires_at', '<', trx.fn.now());
      })
      .forUpdate()
      .skipLocked()
      .limit(Math.min(Math.max(batchSize, 1), 100))) as ReconciliationJob[];
    if (claimed.length) {
      await trx('tpa_reconciliation_jobs')
        .whereIn('id', claimed.map((job) => job.id))
        .update({
          state: 'running',
          lease_owner: leaseOwner,
          lease_expires_at: trx.raw("now() + interval '60 seconds'"),
          updated_at: trx.fn.now(),
        });
    }
    return claimed;
  });

  let succeeded = 0;
  let failed = 0;
  let deadLettered = 0;
  for (const job of jobs) {
    try {
      const clientUuid = job.payload?.keycloakClientUuid;
      if (!clientUuid) throw new Error('identity_delete job has no keycloakClientUuid');
      await getKeycloakAdminService().deleteClient(clientUuid);
      await knex.transaction(async (trx) => {
        await trx('tpa_reconciliation_jobs').where({ id: job.id, lease_owner: leaseOwner }).update({
          state: 'succeeded',
          attempt_count: job.attempt_count + 1,
          lease_owner: null,
          lease_expires_at: null,
          last_error: null,
          updated_at: trx.fn.now(),
        });
        if (job.application_id) {
          await trx('third_party_applications').where({ id: job.application_id }).update({
            identity_state: 'ready',
            identity_error: null,
          });
        }
      });
      succeeded += 1;
    } catch (err) {
      const attempts = job.attempt_count + 1;
      const deadLetter = attempts >= job.max_attempts;
      const delaySeconds = Math.min(2 ** Math.min(attempts, 10), 3600);
      await knex('tpa_reconciliation_jobs').where({ id: job.id, lease_owner: leaseOwner }).update({
        state: deadLetter ? 'dead_letter' : 'failed',
        attempt_count: attempts,
        lease_owner: null,
        lease_expires_at: null,
        next_attempt_at: knex.raw(`now() + (? * interval '1 second')`, [delaySeconds]),
        last_error: (err instanceof Error ? err.message : String(err)).slice(0, 4000),
        updated_at: knex.fn.now(),
      });
      if (job.application_id) {
        await knex('third_party_applications').where({ id: job.application_id }).update({
          identity_state: 'delete_pending',
          identity_error: (err instanceof Error ? err.message : String(err)).slice(0, 4000),
        });
      }
      if (deadLetter) deadLettered += 1;
      else failed += 1;
    }
  }
  return { claimed: jobs.length, succeeded, failed, deadLettered };
}

let interval: NodeJS.Timeout | null = null;

export function startDeveloperConsoleReconciliationWorker(knex: Knex): void {
  if (interval || process.env.DEVELOPER_CONSOLE_RECONCILER_DISABLED === 'true') return;
  const tick = async () => {
    try {
      const result = await runDeveloperConsoleReconciliationBatch(knex);
      if (result.claimed > 0) {
        console.log(JSON.stringify({ type: 'developer_console.reconciliation', ...result }));
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          type: 'developer_console.reconciliation_error',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };
  interval = setInterval(() => void tick(), 5_000);
  interval.unref();
  void tick();
}

export function stopDeveloperConsoleReconciliationWorker(): void {
  if (interval) clearInterval(interval);
  interval = null;
}
