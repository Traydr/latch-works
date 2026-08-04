import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const packageJsonUrl = new URL('../../package.json', import.meta.url);
const requireFromFrameView = createRequire(packageJsonUrl);

describe('renderer dependencies', () => {
  it('keeps scheduler directly resolvable for React DOM bundling', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.scheduler).toBe('^0.27.0');
    expect(requireFromFrameView.resolve('scheduler')).toContain('scheduler');
  });
});
