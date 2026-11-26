import type { Notice } from "./FootNotice";
import { formatDaysAgo, formatShortDate, recheckDueDate } from "./link-dates";
import { siteByKey } from "./link-sites";
import type { AddLinksResult, ArchiveLink } from "./to-archive-contract";
import { useLinkActions } from "./to-archive-queries";

const UNSAVED = "That change didn't save.";

function describeAdded(result: AddLinksResult): string {
  const counts = { added: 0, archived: 0, waiting: 0 };

  for (const outcome of result.outcomes) counts[outcome.kind] += 1;

  const parts: string[] = [];

  if (counts.added > 0) parts.push(`Added ${counts.added}`);

  if (counts.waiting > 0) parts.push(`${counts.waiting} already waiting`);

  if (counts.archived > 0) parts.push(`${counts.archived} already archived`);

  if (result.skipped > 0) parts.push(`${result.skipped} not a link`);

  return parts.join(" · ");
}

/**
 * What the page and focus mode do to links, each with the notice that follows it. Archived,
 * Remove and Queue again offer Undo, which puts the link back as it was; Later's move is plain
 * to see, so it has no notice.
 */
export function useLinkCommands({
  notify,
  onShow,
}: {
  notify: (notice: Notice) => void;
  /** Points the page at a link already waiting. */
  onShow: (link: ArchiveLink) => void;
}) {
  const actions = useLinkActions();

  // Server functions reject with an Error whose message is meant for the owner.
  const fail = (error: Error) => notify({ message: error.message, tone: "error" });

  // `mutateAsync` settles every call; `mutate`'s per-call callbacks fire only for the latest
  // call, so a failure behind a quicker second change would pass without a notice.
  const run = <T>(change: Promise<T>) =>
    change.catch((error) => fail(error instanceof Error ? error : new Error(UNSAVED)));

  const undo = (link: ArchiveLink, onUndo?: () => void) => ({
    label: "Undo",
    run: () => {
      onUndo?.();
      void run(actions.restore.mutateAsync(link));
    },
  });

  return {
    add(text: string, { onDone }: { onDone?: () => void } = {}) {
      void actions.add.mutateAsync(text).then(
        (result) => {
          onDone?.();

          const [only, ...others] = result.outcomes;

          if (!only) {
            notify({
              message:
                result.skipped > 0
                  ? "That isn't a link Pane View can open."
                  : "No link found in that text.",
              tone: "error",
            });

            return;
          }

          if (others.length > 0 || result.skipped > 0) {
            notify({ message: describeAdded(result) });

            return;
          }

          const { link } = only;

          switch (only.kind) {
            case "added":
              notify({
                action: {
                  label: "Undo",
                  run: () => void run(actions.remove.mutateAsync(link)),
                },
                message: `Added to ${siteByKey(link.site).label}`,
              });
              break;
            case "waiting":
              notify({
                action: { label: "Show", run: () => onShow(link) },
                message: `Already waiting, added ${formatDaysAgo(new Date(link.addedAt))}`,
              });
              break;
            case "archived":
              notify({
                action: {
                  label: "Queue again",
                  run: () => void run(actions.queueAgain.mutateAsync(link)),
                },
                message: link.archivedAt
                  ? `Archived ${formatDaysAgo(new Date(link.archivedAt))}`
                  : "Already archived",
              });
              break;
            default: {
              const _exhaustive: never = only;

              return _exhaustive;
            }
          }
        },
        (error) => fail(error instanceof Error ? error : new Error(UNSAVED)),
      );
    },
    archive(link: ArchiveLink, { onUndo }: { onUndo?: () => void } = {}) {
      void run(actions.archive.mutateAsync(link));
      notify({ action: undo(link, onUndo), message: "Archived" });
    },
    later(link: ArchiveLink) {
      void run(actions.later.mutateAsync(link));
    },
    remove(link: ArchiveLink) {
      void run(actions.remove.mutateAsync(link));
      notify({ action: undo(link), message: "Removed" });
    },
    queueAgain(link: ArchiveLink) {
      void run(actions.queueAgain.mutateAsync(link));
      notify({ action: undo(link), message: "Back in To archive" });
    },
    setRecheck(link: ArchiveLink, days: number | null) {
      void run(actions.recheck.mutateAsync({ days, link }));

      if (days !== null && link.archivedAt) {
        const due = recheckDueDate(new Date(link.archivedAt), days);

        notify({
          message:
            due.getTime() <= Date.now()
              ? `Rechecks every ${days} days. It's due now, so it goes back to To archive`
              : `Rechecks every ${days} days, next on ${formatShortDate(due)}`,
        });
      }
    },
    isAdding: actions.add.isPending,
  };
}

export type LinkCommands = ReturnType<typeof useLinkCommands>;
