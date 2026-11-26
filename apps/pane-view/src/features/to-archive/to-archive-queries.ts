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

  const settle = () => queryClient.invalidateQueries({ queryKey: toArchiveKeys.all });

  const add = useMutation({
    mutationFn: (text: string) => addArchiveLinks({ data: { text } }),
    onSettled: settle,
  });

  const archive = useMutation({
    mutationFn: (link: ArchiveLink) => markLinkArchived({ data: { id: link.id } }),
    onMutate: (link) => editWaiting(without(link)),
    onSettled: settle,
  });

  const later = useMutation({
    mutationFn: (link: ArchiveLink) => sendLinkToBack({ data: { id: link.id } }),
    onMutate: (link) => editWaiting((links) => [...without(link)(links), link]),
    onSettled: settle,
  });

  const queueAgain = useMutation({
    mutationFn: (link: ArchiveLink) => queueLinkAgain({ data: { id: link.id } }),
    onSettled: settle,
  });

  const remove = useMutation({
    mutationFn: (link: ArchiveLink) => removeArchiveLink({ data: { id: link.id } }),
    onMutate: (link) => editWaiting(without(link)),
    onSettled: settle,
  });

  const restore = useMutation({
    mutationFn: (link: ArchiveLink) => restoreArchiveLink({ data: link }),
    onSettled: settle,
  });

  const recheck = useMutation({
    mutationFn: ({ days, link }: { days: number | null; link: ArchiveLink }) =>
      setLinkRecheck({ data: { days, id: link.id } }),
    onSettled: settle,
  });

  return { add, archive, later, queueAgain, recheck, remove, restore };
}
