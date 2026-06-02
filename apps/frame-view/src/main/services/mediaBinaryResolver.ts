import { existsSync } from 'node:fs';
import path from 'node:path';

interface BinaryResolutionResult {
  checkedPaths: string[];
  error: string | null;
  exists: boolean;
  requestedPath: string | null;
  resolvedPath: string | null;
}

function rewriteAsarPath(candidatePath: string): string {
  return candidatePath.includes('app.asar')
    ? candidatePath.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
    : candidatePath;
}

function toCandidatePaths(requestedPath: string): string[] {
  const candidates = new Set<string>();
  const normalizedRequestedPath = path.normalize(requestedPath);
  candidates.add(normalizedRequestedPath);
  candidates.add(rewriteAsarPath(normalizedRequestedPath));

  const nodeModulesIndex = normalizedRequestedPath.lastIndexOf(`node_modules${path.sep}`);
  if (nodeModulesIndex >= 0) {
    const nodeModulesSuffix = normalizedRequestedPath.slice(nodeModulesIndex);
    if (process.resourcesPath) {
      candidates.add(path.join(process.resourcesPath, 'app.asar.unpacked', nodeModulesSuffix));
      candidates.add(path.join(process.resourcesPath, nodeModulesSuffix));
    }
  }

  return [...candidates];
}

export function resolveBinaryPath(
  requestedPath: string | null | undefined,
): BinaryResolutionResult {
  if (!requestedPath) {
    return {
      checkedPaths: [],
      error: 'Binary path was not provided by the runtime module.',
      exists: false,
      requestedPath: null,
      resolvedPath: null,
    };
  }

  const checkedPaths = toCandidatePaths(requestedPath);
  for (const candidatePath of checkedPaths) {
    if (existsSync(candidatePath)) {
      return {
        checkedPaths,
        error: null,
        exists: true,
        requestedPath,
        resolvedPath: candidatePath,
      };
    }
  }

  return {
    checkedPaths,
    error: `Binary was not found. Checked: ${checkedPaths.join(', ')}`,
    exists: false,
    requestedPath,
    resolvedPath: rewriteAsarPath(path.normalize(requestedPath)),
  };
}
