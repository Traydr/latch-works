export interface ViewerStateSnapshot {
  page?: number;
  positionMs?: number;
  subjectId: string;
  subjectType: "library_entry" | "collection";
  updatedAt: string;
}

export interface ViewerStateWrite {
  page?: number;
  positionMs?: number;
  subjectId: string;
  subjectType: "library_entry" | "collection";
}
