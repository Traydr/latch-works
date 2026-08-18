import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/** Only the runtime dependency list matters for renderer bundling. */
const PackageManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
});

const packageJsonUrl = new URL('../../package.json', import.meta.url);
const requireFromFrameView = createRequire(packageJsonUrl);

describe('renderer dependencies', () => {
  it('keeps scheduler directly resolvable for React DOM bundling', () => {
    const packageJson = PackageManifestSchema.parse(
      JSON.parse(readFileSync(packageJsonUrl, 'utf8')),
    );

    expect(packageJson.dependencies?.scheduler).toBe('^0.27.0');
    expect(requireFromFrameView.resolve('scheduler')).toContain('scheduler');
  });
});
