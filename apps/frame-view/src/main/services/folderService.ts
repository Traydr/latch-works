import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Result, type Result as ResultType } from 'better-result';
import { z } from 'zod';
import type { FolderNode } from '../../shared/types';
import { type FileSystemError, toError, unexpectedFileSystemError } from '../errors';

/** Node's filesystem rejections carry a numeric-ish `code` such as `ENOENT`. */
const ErrnoErrorSchema = z.object({ code: z.string() });

async function canonicalizePath(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function resolveFolderPath(
  candidatePath: string,
): Promise<ResultType<string | null, FileSystemError>> {
  if (!candidatePath) {
    return Result.ok(null);
  }

  const resolvedCandidatePath = path.resolve(candidatePath);

  try {
    const stats = await fs.stat(resolvedCandidatePath);
    if (stats.isDirectory()) {
      return Result.ok(await canonicalizePath(resolvedCandidatePath));
    }

    if (stats.isFile()) {
      return Result.ok(await canonicalizePath(path.dirname(resolvedCandidatePath)));
    }

    return Result.ok(null);
  } catch (cause) {
    const error = toError(cause);
    const errno = ErrnoErrorSchema.safeParse(error);
    if (errno.success && errno.data.code === 'ENOENT') {
      return Result.ok(null);
    }

    return Result.err(
      unexpectedFileSystemError('resolve-folder-path', error, resolvedCandidatePath),
    );
  }
}

export async function listFolderChildren(
  folderPath: string,
): Promise<ResultType<FolderNode[], FileSystemError>> {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());

    const nodes: FolderNode[] = directories.map((entry) => {
      const fullPath = path.join(folderPath, entry.name);
      return {
        path: fullPath,
        name: entry.name,
        hasChildren: true,
      };
    });

    return Result.ok(
      nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    );
  } catch (cause) {
    return Result.err(
      unexpectedFileSystemError('list-folder-children', toError(cause), folderPath),
    );
  }
}
