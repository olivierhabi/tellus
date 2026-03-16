import { CleanupService } from '@/services/cleanupService';
import { env } from '@/config/environment';
import db from '@/config/database';

const cleanupService = new CleanupService(db);
let isRunning = false;

export function startCleanupScheduler(): void {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  
  setInterval(async () => {
    if (isRunning) return;
    isRunning = true;
    
    try {
      const fileResult = await cleanupService.cleanOrphanedFiles(env.UPLOAD_DIR);
      const recordResult = await cleanupService.cleanOrphanedRecords();
      console.log('[cleanup] Orphaned files removed:', fileResult.removedFiles, 'Orphaned records removed:', recordResult.removedRecords);
    } catch (error) {
      console.error('[cleanup] Scheduler error:', error);
    } finally {
      isRunning = false;
    }
  }, SIX_HOURS);
}

export { cleanupService };
