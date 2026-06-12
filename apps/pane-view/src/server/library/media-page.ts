export interface MediaPage {
  hasMore: boolean;
  limit: number;
  nextOffset: number | null;
  offset: number;
}

export function buildMediaPage<T>(rows: readonly T[], limit: number, offset: number): {
  items: T[];
  mediaPage: MediaPage;
} {
  const hasMore = rows.length > limit;
  return {
    items: hasMore ? rows.slice(0, limit) : [...rows],
    mediaPage: {
      hasMore,
      limit,
      nextOffset: hasMore ? offset + limit : null,
      offset,
    },
  };
}
