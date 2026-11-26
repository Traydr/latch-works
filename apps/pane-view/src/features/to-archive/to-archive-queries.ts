import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ArchivedPage, ArchiveLink, ListArchivedInput } from "./to-archive-contract";
import {
  addArchiveLinks,
  getArchived,
  getToArchive,
  markLinkArchived,
  queueLinkAgain,
  removeArchiveLink,
  restoreArchiveLink,
  sendLinkToBack,
  setLinkRecheck,
} from "./to-archive-service";

const LINK_MUTATION = ["to-archive", "change"];

const toArchiveKeys = {
  all: ["to-archive"] as const,
  waiting: () => [...toArchiveKeys.all, "waiting"] as const,
  archived: (search: string) => [...toArchiveKeys.all, "archived", search] as const,
};

export function useToArchiveQuery() {
  return useQuery({ queryKey: toArchiveKeys.waiting(), queryFn: () => getToArchive() });
}

export function useArchivedQuery(search: string) {
  return useInfiniteQuery<
    ArchivedPage,
    Error,
    InfiniteData<ArchivedPage, string | null>,
    ReturnType<typeof toArchiveKeys.archived>,
    string | null
  >({
    queryKey: toArchiveKeys.archived(search),
    queryFn: ({ pageParam }) => {
      const data: ListArchivedInput = {};

      if (pageParam !== null) data.cursor = pageParam;

      if (search) data.search = search;

      return getArchived({ data });
    },
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

/**
 * Every change to a link. The To archive list changes at once (the server agrees a moment
 * later), so archiving a run of links never waits on a round trip.
 */
export function useLinkActions() {
  const queryClient = useQueryClient();

  const editWaiting = (edit: (links: ArchiveLink[]) => ArchiveLink[]) => {
    void queryClient.cancelQueries({ queryKey: toArchiveKeys.waiting() });
    queryClient.setQueryData<ArchiveLink[]>(toArchiveKeys.waiting(), (links) =>
      links ? edit(links) : links,
    );
  };

  const without = (link: ArchiveLink) => (links: ArchiveLink[]) =>
    links.filter((other) => other.id !== link.id);

  // While other changes are still on their way, a refetch would bring back what they removed.
  const settle = () => {
    if (queryClient.isMutating({ mutationKey: LINK_MUTATION }) <= 1) {
      void queryClient.invalidateQueries({ queryKey: toArchiveKeys.all });
    }
  };

  // One scope: each change waits for the one before, so Undo never overtakes what it undoes.
  const ordered = { mutationKey: LINK_MUTATION, scope: { id: "to-archive" } } as const;

  const add = useMutation({
    ...ordered,
    mutationFn: (text: string) => addArchiveLinks({ data: { text } }),
    onSettled: settle,
  });

  const archive = useMutation({
    ...ordered,
    mutationFn: (link: ArchiveLink) => markLinkArchived({ data: { id: link.id } }),
    onMutate: (link) => editWaiting(without(link)),
    onSettled: settle,
  });

  const later = useMutation({
    ...ordered,
    mutationFn: (link: ArchiveLink) => sendLinkToBack({ data: { id: link.id } }),
    onMutate: (link) => editWaiting((links) => [...without(link)(links), link]),
    onSettled: settle,
  });

  const queueAgain = useMutation({
    ...ordered,
    mutationFn: (link: ArchiveLink) => queueLinkAgain({ data: { id: link.id } }),
    onSettled: settle,
  });

  const remove = useMutation({
    ...ordered,
    mutationFn: (link: ArchiveLink) => removeArchiveLink({ data: { id: link.id } }),
    onMutate: (link) => editWaiting(without(link)),
    onSettled: settle,
  });

  const restore = useMutation({
    ...ordered,
    mutationFn: (link: ArchiveLink) => restoreArchiveLink({ data: link }),
    onSettled: settle,
  });

  const recheck = useMutation({
    ...ordered,
    mutationFn: ({ days, link }: { days: number | null; link: ArchiveLink }) =>
      setLinkRecheck({ data: { days, id: link.id } }),
    onSettled: settle,
  });

  return { add, archive, later, queueAgain, recheck, remove, restore };
}
