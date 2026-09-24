/*
 * The ways a sync request can be refused. The store and the routes throw
 * these; route-errors.ts gives each its HTTP status.
 */

/** The sync run id names no run. */
export class SyncRunNotFoundError extends Error {
  constructor() {
    super("Sync run not found.");
    this.name = "SyncRunNotFoundError";
  }
}

/** The sync run's state refuses the request: it has finished, or finished differently. */
export class SyncRunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncRunConflictError";
  }
}

/** The object in storage is missing or differs from the upload the client declared. */
export class UploadMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadMismatchError";
  }
}

/** A logical path the archive cannot hold. */
export class InvalidSyncPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSyncPathError";
  }
}
