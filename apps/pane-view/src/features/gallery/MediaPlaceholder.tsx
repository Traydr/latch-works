import { FileText, ImageIcon, Play } from "lucide-react";

export function MediaPlaceholder({
  mediaType,
  size = 42,
}: {
  mediaType: "image" | "gif" | "video" | "pdf" | "unknown";
  size?: number;
}) {
  if (mediaType === "video") {
    return <Play size={size} />;
  }

  if (mediaType === "pdf") {
    return <FileText size={size} />;
  }

  return <ImageIcon size={size} />;
}
