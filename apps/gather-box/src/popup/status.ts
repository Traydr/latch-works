export type PopupStatus =
  | "idle"
  | "pickingFolder"
  | "collecting"
  | "downloading"
  | "complete"
  | "error";

export function getStatusLabel(status: PopupStatus): string {
  if (status === "pickingFolder") {
    return "PICKING FOLDER";
  }

  if (status === "collecting") {
    return "COLLECTING";
  }

  if (status === "downloading") {
    return "DOWNLOADING";
  }

  return status.toUpperCase();
}
