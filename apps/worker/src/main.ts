// Session 1: BullMQ. Queues: poll:<sourceId> (repeatable), notify. Runs adapters via core's HttpClient.
// The poll job: list() → diff against listings table → detail() for new → toCanonical → normalize → dedup → match → enqueue notify.
console.log("worker: not yet");
