import { toError } from "../shared/errors";
import {
  COLLECTION_DEADLINE_MS,
  type CollectingGatherQueueJob,
  endDeletedProfileJobs,
  expireStaleCollections,
  type GatherQueueRecovery,
  type GatherQueueState,
  getGatherQueueDisplayRun,
  getNextQueuedGatherJob,
  getPermissionRequiredGatherJob,
  getRetryableGatherQueueResult,
  MAX_GATHER_QUEUE_LENGTH,
  type OutputGatherQueueJob,
  PROFILE_DELETED_MESSAGE,
  recordGatherQueueResult,
  recordHandedBackFile,
  recoverStoppedGatherQueue,
  withdrawGatherQueueResult,
} from "../shared/gather-queue";
import {
  createGatherRunState,
  folderScope,
  type GatherRunCancelOutcome,
  type GatherRunStartOutcome,
  type GatherRunState,
  isAbortablePhase,
  isOutputPhase,
  isTerminalGatherRunPhase,
  outputTotal,
  queueFullMessage,
  RUN_CANCELLED_MESSAGE,
} from "../shared/gather-run";
import { applyGatherRunEvent, type HandedBackFile } from "../shared/gather-run-reducer";
import { failChannel } from "../shared/messaging";
import { getDistinguishingProfileName } from "../shared/profiles";
import {
  type GatherRunEvent,
  type GatherRunEventMessage,
  gatherRunEventMessage,
  releasesGatherQueue,
} from "../shared/protocol/run-events";
import { createSerialQueue } from "../shared/serial-queue";
import { type MatchedPage, matchGatherSource, type SiteKey } from "../shared/source-catalog";
import { prepareGatherOutput } from "../shared/source-policies";
import type { DownloadablePayload } from "../shared/types";
import {
  createChromeCoordinatorDependencies,
  type GatherRunCoordinatorDependencies,
} from "./gather-run-coordinator-dependencies";

const REQUESTED_PROFILE_DELETED_MESSAGE =
  "That profile was deleted. Check the folder for the profile shown and try again.";

/** The tab a gather intent captured. */
interface GatherTarget {
  tabId: number;
  windowId: number;
  url: string;
}

type Reservation =
  | { kind: "collect"; run: CollectingGatherQueueJob["run"]; position: number }
  | { kind: "existing"; runId: string; position: number }
  | { kind: "outcome"; outcome: GatherRunStartOutcome };

type OutputRun = OutputGatherQueueJob["run"];

interface ReservationResult {
  reservation: Reservation;
  /** A paused job was unblocked by this intent and needs dispatching before the new page. */
  resumed: boolean;
}

export class GatherRunCoordinator {
  /** Every read-modify-write of the stored queue runs here, one at a time. */
  private readonly exclusive = createSerialQueue();

  constructor(
    private readonly dependencies: GatherRunCoordinatorDependencies = createChromeCoordinatorDependencies(),
  ) {}

  /** `requestedProfileId` is the profile whose folder the side panel confirmed, if it sent one. */
  async startForTab(
    tab: chrome.tabs.Tab,
    requestedProfileId?: string,
  ): Promise<GatherRunStartOutcome> {
    if (tab.id === undefined || tab.windowId === undefined || !tab.url) {
      return { outcome: "target-unavailable" };
    }

    const page = matchGatherSource(tab.url);

    if (!page) {
      return { outcome: "unsupported-source" };
    }

    const target: GatherTarget = { tabId: tab.id, windowId: tab.windowId, url: tab.url };
    const siteKey = page.source.key;

    // The page keeps the profile it was gathered under, even if another one is chosen while it is
    // collected.
    const profileId = await this.resolveProfileId(requestedProfileId);

    if (!profileId) {
      return { outcome: "failed", message: REQUESTED_PROFILE_DELETED_MESSAGE };
    }

    const { reservation, resumed } = await this.reserve(target, siteKey, profileId);

    if (resumed || reservation.kind === "existing") {
      await this.dispatchNext();
    }

    if (reservation.kind === "outcome") {
      return reservation.outcome;
    }

    if (reservation.kind === "existing") {
      return this.outcomeForJob(reservation.runId, reservation.position);
    }

    return this.finishCollection(page, profileId, reservation);
  }

  async retry(runId: string, requestedProfileId?: string): Promise<GatherRunStartOutcome> {
    const previous = await this.exclusive(async () => {
      const queue = await this.dependencies.loadQueue();
      const result = getRetryableGatherQueueResult(queue);

      return result?.id === runId ? result : null;
    });

    if (!previous) {
      return { outcome: "failed", message: "No retryable Gather Run was found." };
    }

    // Retrying is the explicit way to send failed items to the folder remembered now, in the
    // profile chosen now.
    const [settings, profileId] = await Promise.all([
      this.dependencies.loadSettings(),
      this.resolveProfileId(requestedProfileId),
    ]);

    if (!profileId) {
      return { outcome: "failed", message: REQUESTED_PROFILE_DELETED_MESSAGE };
    }

    const destinationId = await this.dependencies.getDestinationId(
      folderScope(previous.siteKey, settings.useGlobalFolder),
      profileId,
    );

    const payload: DownloadablePayload = {
      ok: true,
      outputKind: "downloadable-files",
      site: previous.siteKey,
      title: previous.title ?? previous.tabUrl,
      pageUrl: previous.tabUrl,
      galleryId: null,
      folderSegments: previous.folderSegments,
      images: previous.retryImages,
    };

    const reservation = await this.exclusive(async () => {
      let queue = await this.dependencies.loadQueue();

      if (queue.jobs.length >= MAX_GATHER_QUEUE_LENGTH) {
        return null;
      }

      const queued = createGatherRunState({
        id: this.dependencies.randomUUID(),
        tabId: previous.tabId,
        windowId: previous.windowId,
        tabUrl: previous.tabUrl,
        siteKey: previous.siteKey,
        phase: "queued",
        message: `Queued "${payload.title}".`,
        log: [{ message: `Queued retry for ${previous.retryImages.length} failed item(s).` }],
        now: this.dependencies.now(),
      });

      const run: OutputRun = {
        ...queued,
        title: previous.title,
        folderSegments: payload.folderSegments,
        progress: { ...queued.progress, total: payload.images.length },
      };

      const position = queue.jobs.length;
      queue = withdrawGatherQueueResult(
        {
          ...queue,
          jobs: [
            ...queue.jobs,
            { kind: "output", run, payload, settings, destinationId, profileId },
          ],
        },
        previous,
      );
      await this.dependencies.saveQueue(queue);

      return { runId: run.id, position };
    });

    if (!reservation) {
      return { outcome: "failed", message: queueFullMessage(MAX_GATHER_QUEUE_LENGTH) };
    }

    await this.dispatchNext();

    return this.outcomeForJob(reservation.runId, reservation.position);
  }

  async cancel(runId: string): Promise<GatherRunCancelOutcome> {
    const decision = await this.exclusive(async () => {
      let queue = await this.dependencies.loadQueue();
      const job = queue.jobs.find((candidate) => candidate.run.id === runId);

      if (!job) {
        return { kind: "idle" } as const;
      }

      if (job.kind === "output" && isAbortablePhase(job.run.phase)) {
        const run: OutputRun = {
          ...job.run,
          phase: "cancelling",
          updatedAt: this.dependencies.now(),
          progress: { ...job.run.progress, message: "Cancelling Gather Run..." },
        };

        queue = replaceJob(queue, { ...job, run });
        await this.dependencies.saveQueue(queue);

        return { kind: "abort", run } as const;
      }

      const cancelled = applyGatherRunEvent(
        job.run,
        { kind: "cancelled", message: RUN_CANCELLED_MESSAGE },
        this.dependencies.now(),
      );

      queue = recordAndRemove(queue, cancelled);
      await this.dependencies.saveQueue(queue);

      return { kind: "done", run: cancelled } as const;
    });

    if (decision.kind === "idle") {
      return { outcome: "idle" };
    }

    if (decision.kind === "done") {
      await this.dispatchNext();

      return { outcome: "cancelled", run: decision.run };
    }

    // An executor that is not running this run will never report it cancelled, so record it here.
    const aborted = await this.dependencies.abort(runId).catch(() => false);

    if (!aborted) {
      await this.handleEvent(
        gatherRunEventMessage(runId, { kind: "cancelled", message: RUN_CANCELLED_MESSAGE }),
      );
    }

    return { outcome: "cancelled", run: decision.run };
  }

  /** Records a blocked file the side panel saved for you; false when its run no longer lists it. */
  async recordHandedBackFile(file: HandedBackFile): Promise<boolean> {
    return this.exclusive(async () => {
      const queue = recordHandedBackFile(await this.dependencies.loadQueue(), file);

      if (!queue) {
        return false;
      }

      await this.dependencies.saveQueue(queue);

      return true;
    });
  }

  async handleEvent(message: GatherRunEventMessage): Promise<void> {
    const profiles =
      message.event.kind === "permission-required" ? await this.dependencies.loadProfiles() : null;

    const shouldDispatch = await this.exclusive(async () => {
      let queue = await this.dependencies.loadQueue();
      const job = queue.jobs.find((candidate) => candidate.run.id === message.runId);

      if (!job) {
        // A redelivered report, or one from a run the queue already recorded (a cancel the
        // executor did not take). The executor has given up the queue either way, and a dispatch
        // it refused as busy is waiting for exactly this.
        return releasesGatherQueue(message.event);
      }

      if (job.kind !== "output") {
        return false;
      }

      if (job.run.phase === "cancelling" && message.event.kind !== "cancelled") {
        return false;
      }

      // A paused report is redelivered until acknowledged. One that lands after the job was
      // resumed or restarted is stale, and pausing the job again would stall real work.
      if (message.event.kind === "permission-required" && job.run.phase !== "preparing") {
        return false;
      }

      // Only a gather under the paused job's own profile can confirm its folder, so name that
      // profile whenever there is more than one to choose from.
      const profileName = profiles ? getDistinguishingProfileName(profiles, job.profileId) : null;

      // A job that was starting when its profile was deleted cannot pause: no gather can confirm
      // a folder for a profile that no longer exists, so the pause would hold up the queue.
      const profileDeleted =
        profiles !== null && !profiles.profiles.some((profile) => profile.id === job.profileId);

      const event: GatherRunEvent = profileDeleted
        ? { kind: "failed", message: PROFILE_DELETED_MESSAGE }
        : message.event.kind === "permission-required" && profileName
          ? { ...message.event, profileName }
          : message.event;

      const updated = applyGatherRunEvent(job.run, event, this.dependencies.now());

      if (isTerminalGatherRunPhase(updated.phase)) {
        queue = recordAndRemove(queue, updated);
        await this.dependencies.saveQueue(queue);

        return true;
      }

      if (isOutputPhase(updated.phase)) {
        queue = replaceJob(queue, { ...job, run: { ...updated, phase: updated.phase } });
        await this.dependencies.saveQueue(queue);
      }

      return false;
    });

    if (shouldDispatch) {
      await this.dispatchNext();
    }
  }

  /** Ends outputs still waiting on a profile that no longer exists, then moves the queue on. */
  async failDeletedProfileJobs(): Promise<void> {
    const ended = await this.exclusive(async () => {
      const [loaded, profiles] = await Promise.all([
        this.dependencies.loadQueue(),
        this.dependencies.loadProfiles(),
      ]);

      const profileIds = new Set(profiles.profiles.map((profile) => profile.id));
      const result = endDeletedProfileJobs(loaded, profileIds, this.dependencies.now());
      await this.saveRecovery(result);

      return result.ended.length;
    });

    if (ended > 0) {
      await this.dispatchNext();
    }
  }

  async recover(): Promise<void> {
    const status = await this.dependencies.getExecutorStatus();

    // An executor that did not answer may still be writing, so its jobs are left as they are.
    if (status !== "unknown") {
      await this.exclusive(async () => {
        const queue = await this.dependencies.loadQueue();
        const { activeRunId } = status;

        if (activeRunId && queue.jobs.some((job) => job.run.id === activeRunId)) {
          return;
        }

        await this.saveRecovery(recoverStoppedGatherQueue(queue, this.dependencies.now()));
      });
    }

    await this.failDeletedProfileJobs();
    await this.dispatchNext();
  }

  private async reserve(
    target: GatherTarget,
    siteKey: SiteKey,
    profileId: string,
  ): Promise<ReservationResult> {
    return this.exclusive(async () => {
      const loaded = await this.dependencies.loadQueue();
      // Confirming folder access unblocks a paused job, but it is not a request to gather that
      // job's page again. The tab in hand still gets collected on its own.
      const permissionJob = getPermissionRequiredGatherJob(loaded, siteKey, profileId);

      let queue = permissionJob
        ? replaceJob(loaded, resumePermissionJob(permissionJob, this.dependencies.now()))
        : loaded;

      const resumed = permissionJob !== null;
      let reservation: Reservation;

      const duplicate = queue.jobs.find((job) => job.run.tabUrl === target.url);

      if (duplicate) {
        reservation = {
          kind: "existing",
          runId: duplicate.run.id,
          position: queue.jobs.indexOf(duplicate),
        };
      } else if (queue.jobs.length >= MAX_GATHER_QUEUE_LENGTH) {
        reservation = {
          kind: "outcome",
          outcome: { outcome: "failed", message: queueFullMessage(MAX_GATHER_QUEUE_LENGTH) },
        };
      } else {
        const run = createGatherRunState({
          id: this.dependencies.randomUUID(),
          tabId: target.tabId,
          windowId: target.windowId,
          tabUrl: target.url,
          siteKey,
          phase: "collecting",
          message: "Collecting content metadata...",
          log: [{ message: "Collecting content metadata..." }],
          now: this.dependencies.now(),
        });

        reservation = { kind: "collect", run, position: queue.jobs.length };
        queue = { ...queue, jobs: [...queue.jobs, { kind: "collecting", run }] };
      }

      if (queue !== loaded) {
        await this.dependencies.saveQueue(queue);
      }

      return { reservation, resumed };
    });
  }

  private async finishCollection(
    page: MatchedPage,
    profileId: string,
    reservation: Extract<Reservation, { kind: "collect" }>,
  ): Promise<GatherRunStartOutcome> {
    try {
      const currentTab = await this.dependencies.getTab(reservation.run.tabId);

      if (!currentTab.url || currentTab.url !== reservation.run.tabUrl) {
        throw new Error("The source tab navigated before collection started.");
      }

      const [collected, settings] = await Promise.all([
        withDeadline(
          this.dependencies.collect(currentTab, page, reservation.run),
          COLLECTION_DEADLINE_MS,
          "The page did not finish collecting in time.",
        ),
        this.dependencies.loadSettings(),
      ]);

      // Pin the folder remembered when the page was gathered, so choosing another one later
      // cannot silently redirect this output.
      const destinationId = await this.dependencies.getDestinationId(
        folderScope(page.source.key, settings.useGlobalFolder),
        profileId,
      );

      const payload = prepareGatherOutput(collected, settings);
      const total = outputTotal(payload);

      const completed = await this.exclusive(async () => {
        let queue = await this.dependencies.loadQueue();
        const index = queue.jobs.findIndex((job) => job.run.id === reservation.run.id);

        if (index < 0 || queue.jobs[index]?.kind !== "collecting") {
          return false;
        }

        // Checked under the same lock as failDeletedProfileJobs, so a profile deleted during
        // collection either ends this output there or is seen deleted here.
        const profiles = await this.dependencies.loadProfiles();

        if (!profiles.profiles.some((profile) => profile.id === profileId)) {
          throw new Error(PROFILE_DELETED_MESSAGE);
        }

        const run: OutputRun = {
          ...reservation.run,
          phase: "queued",
          updatedAt: this.dependencies.now(),
          title: payload.title,
          folderSegments: payload.folderSegments,
          progress: { ...reservation.run.progress, total, message: `Queued "${payload.title}".` },
          log: [
            ...reservation.run.log,
            { message: `Queued ${total} item(s) from "${payload.title}".`, tone: "success" },
          ],
        };

        const jobs = [...queue.jobs];
        jobs[index] = { kind: "output", run, payload, settings, destinationId, profileId };
        queue = { ...queue, jobs };
        await this.dependencies.saveQueue(queue);

        return true;
      });

      if (!completed) {
        return { outcome: "failed", message: "The queued Gather Run was cancelled." };
      }

      await this.dispatchNext();

      return this.outcomeForJob(reservation.run.id, reservation.position);
    } catch (error) {
      const failed = applyGatherRunEvent(
        reservation.run,
        { kind: "failed", message: toError(error).message },
        this.dependencies.now(),
      );

      await this.exclusive(async () => {
        let queue = await this.dependencies.loadQueue();

        if (!queue.jobs.some((job) => job.run.id === reservation.run.id)) {
          return;
        }

        queue = recordAndRemove(queue, failed);
        await this.dependencies.saveQueue(queue);
      });
      await this.dispatchNext();

      return { outcome: "failed", message: failed.error ?? "Gather Run failed." };
    }
  }

  private async dispatchNext(): Promise<void> {
    while (true) {
      const claim = await this.exclusive(async () => {
        let queue = await this.saveRecovery(
          expireStaleCollections(await this.dependencies.loadQueue(), this.dependencies.now()),
        );

        const next = getNextQueuedGatherJob(queue);

        if (!next) {
          return null;
        }

        const run: OutputRun = {
          ...next.run,
          phase: "preparing",
          updatedAt: this.dependencies.now(),
          progress: {
            ...next.run.progress,
            completed: 0,
            message: "Starting queued Gather Output...",
          },
        };

        const claimed = { ...next, run };
        queue = replaceJob(queue, claimed);
        await this.dependencies.saveQueue(queue);

        return { job: claimed, queued: next };
      });

      if (!claim) {
        return;
      }

      const { job } = claim;

      const response = await this.dependencies
        .execute(job)
        .catch((error) => failChannel(toError(error).message));

      if (response.outcome === "accepted") {
        return;
      }

      // The executor is still running a run the queue no longer lists. Its report, once it gives
      // up the slot, dispatches again, so the job waits for it in its place.
      if (response.outcome === "busy") {
        await this.exclusive(async () => {
          const queue = await this.dependencies.loadQueue();
          const current = queue.jobs.find((candidate) => candidate.run.id === job.run.id);

          if (current?.run.phase === "preparing") {
            await this.dependencies.saveQueue(replaceJob(queue, claim.queued));
          }
        });

        return;
      }

      const failed = applyGatherRunEvent(
        job.run,
        {
          kind: "failed",
          message: `The Gather executor did not accept the queued output: ${response.message}`,
        },
        this.dependencies.now(),
      );

      await this.exclusive(async () => {
        let queue = await this.dependencies.loadQueue();

        if (!queue.jobs.some((candidate) => candidate.run.id === job.run.id)) {
          return;
        }

        queue = recordAndRemove(queue, failed);
        await this.dependencies.saveQueue(queue);
      });
    }
  }

  private async outcomeForJob(
    runId: string,
    requestedPosition: number,
  ): Promise<GatherRunStartOutcome> {
    const queue = await this.exclusive(() => this.dependencies.loadQueue());
    const job = queue.jobs.find((candidate) => candidate.run.id === runId);
    const completed = queue.results.find((result) => result.id === runId);

    const restored = completed ?? job?.run;

    if (!restored) {
      return { outcome: "failed", message: "The queued Gather Run could not be restored." };
    }

    const run = getGatherQueueDisplayRun(queue) ?? restored;

    if (job?.kind === "output" && job.run.phase !== "queued") {
      return { outcome: "started", run, queuedRunId: runId, position: 0 };
    }

    return {
      outcome: "queued",
      run,
      queuedRunId: runId,
      position: Math.max(1, requestedPosition),
    };
  }

  /**
   * The requested profile when it still exists, the active one when none was requested, and null
   * when the requested one was deleted: writing to another profile's folder would surprise.
   */
  private async resolveProfileId(requestedProfileId?: string): Promise<string | null> {
    const profiles = await this.dependencies.loadProfiles();

    if (requestedProfileId === undefined) {
      return profiles.activeProfileId;
    }

    return profiles.profiles.some((profile) => profile.id === requestedProfileId)
      ? requestedProfileId
      : null;
  }

  /** Records the runs a recovery ended and saves the queue; a recovery that ended none is a no-op. */
  private async saveRecovery(recovery: GatherQueueRecovery): Promise<GatherQueueState> {
    if (recovery.ended.length === 0) {
      return recovery.queue;
    }

    const queue = recovery.ended.reduce(recordGatherQueueResult, recovery.queue);
    await this.dependencies.saveQueue(queue);

    return queue;
  }
}

function resumePermissionJob(job: OutputGatherQueueJob, now: number): OutputGatherQueueJob {
  return {
    ...job,
    run: {
      ...job.run,
      phase: "queued",
      error: null,
      updatedAt: now,
      progress: { ...job.run.progress, message: "Folder access confirmed. Queued." },
    },
  };
}

function replaceJob(queue: GatherQueueState, job: OutputGatherQueueJob): GatherQueueState {
  return {
    ...queue,
    jobs: queue.jobs.map((candidate) => (candidate.run.id === job.run.id ? job : candidate)),
  };
}

function recordAndRemove(queue: GatherQueueState, run: GatherRunState): GatherQueueState {
  return recordGatherQueueResult(
    { ...queue, jobs: queue.jobs.filter((job) => job.run.id !== run.id) },
    run,
  );
}

/** Rejects with `message` when `work` has not settled within `milliseconds`. */
function withDeadline<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });

  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
