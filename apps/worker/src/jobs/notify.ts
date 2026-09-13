import type { Job } from "bullmq";
import type { Logger } from "pino";

/**
 * No-op until T5. Completes successfully so the notify queue does not
 * accumulate failed jobs for the rest of the sprint.
 */
export function createNotifyProcessor(log: Logger) {
  return async function processNotify(job: Job): Promise<void> {
    log.debug({ queue: "notify", jobId: job.id }, "notify not implemented until T5");
  };
}
