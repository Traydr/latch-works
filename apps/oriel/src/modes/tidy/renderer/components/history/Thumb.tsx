import { File } from "lucide-react";
import { useState } from "react";

import { thumbnailUrl } from "../../lib/api";

/**
 * A file's thumbnail, cropped to fill its box, or whole inside it with `fit="contain"` (for a
 * letterbox well). Files with no picture (junk, documents) show a file icon instead.
 */
export function Thumb({
  path,
  size = 256,
  fit = "cover",
  className = "",
}: {
  path: string | null;
  size?: number;
  fit?: "cover" | "contain";
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);

  if (path === null || failed === path) {
    return (
      <span
        className={`lw-well flex items-center justify-center text-zinc-400 dark:text-zinc-500 ${className}`}
      >
        <File className="size-[30%] max-h-8 max-w-8" />
      </span>
    );
  }

  return (
    <img
      src={thumbnailUrl(path, size)}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(path)}
      className={`${
        fit === "contain"
          ? "object-contain"
          : "lw-media-edge bg-zinc-100 object-cover dark:bg-zinc-800"
      } ${className}`}
    />
  );
}
