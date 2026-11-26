import type { Notice } from "./FootNotice";
import { formatDaysAgo, formatShortDate, recheckDueDate } from "./link-dates";
import { siteByKey } from "./link-sites";
import type { AddLinksResult, ArchiveLink } from "./to-archive-contract";
import { useLinkActions } from "./to-archive-queries";

function describeAdded(result: AddLinksResult): string {
  const counts = { added: 0, archived: 0, waiting: 0 };

  for (const outcome of result.outcomes) counts[outcome.kind] += 1;

  const parts: string[] = [];

  if (counts.added > 0) parts.push(`Added ${counts.added}`);

  if (counts.waiting > 0) parts.push(`${counts.waiting} already waiting`);

  if (counts.archived > 0) parts.push(`${counts.archived} already archived`);

  return parts.join(" · ");
}

/**
 * What the page and focus mode do to links, each with the notice that follows it. Archived,
 * Later and Remove offer Undo, which puts the link back as it was.
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
  const fail = (error: Error) => notify({ message: error.message, tone: "error" });

  const undo = (link: ArchiveLink) => ({
    label: "Undo",
    run: () => actions.restore.mutate(link, { onError: fail }),
  });

  return {
    add(text: string, { onDone }: { onDone?: () => void } = {}) {
      actions.add.mutate(text, {
        onError: fail,
        onSuccess: (result) => {
          onDone?.();

          if (result.nothingFound) {
            notify({ message: "No link found in that text.", tone: "error" });

            return;
          }

          const [only, ...others] = result.outcomes;

          if (!only || others.length > 0) {
            notify({ message: describeAdded(result) });

            return;
          }

          const { link } = only;

          switch (only.kind) {
            case "added":
              notify({
                action: {
                  label: "Undo",
                  run: () => actions.remove.mutate(link, { onError: fail }),
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
                  run: () => actions.queueAgain.mutate(link, { onError: fail }),
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
      });
    },
    archive(link: ArchiveLink) {
      actions.archive.mutate(link, { onError: fail });
      notify({ action: undo(link), message: "Archived" });
    },
    later(link: ArchiveLink) {
      actions.later.mutate(link, { onError: fail });
    },
    remove(link: ArchiveLink) {
      actions.remove.mutate(link, { onError: fail });
      notify({ action: undo(link), message: "Removed" });
    },
    queueAgain(link: ArchiveLink) {
      actions.queueAgain.mutate(link, { onError: fail });
      notify({ action: undo(link), message: "Back in To archive" });
    },
    setRecheck(link: ArchiveLink, days: number | null) {
      actions.recheck.mutate({ days, link }, { onError: fail });

      if (days !== null && link.archivedAt) {
        const due = recheckDueDate(new Date(link.archivedAt), days);

        notify({ message: `Rechecks every ${days} days, next on ${formatShortDate(due)}` });
      }
    },
    isAdding: actions.add.isPending,
  };
}

export type LinkCommands = ReturnType<typeof useLinkCommands>;
