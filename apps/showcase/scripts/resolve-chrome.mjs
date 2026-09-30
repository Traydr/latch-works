import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, detectBrowserPlatform, getInstalledBrowsers } from "@puppeteer/browsers";

/** `screenshots:install-browser` runs in apps/showcase, which is where the CLI installs. */
const cacheDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function compareBuildIds(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

/**
 * Returns `CHROME_PATH` when set, otherwise the newest Chrome for Testing that
 * `pnpm --filter @latch-works/showcase screenshots:install-browser` installed for this platform.
 */
export async function resolveChromePath() {
  const override = process.env.CHROME_PATH;

  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CHROME_PATH points at ${override}, which does not exist.`);
    }

    return override;
  }

  const platform = detectBrowserPlatform();

  const [newest] = (await getInstalledBrowsers({ cacheDir }))
    .filter(
      (installed) =>
        installed.browser === Browser.CHROME &&
        installed.platform === platform &&
        existsSync(installed.executablePath),
    )
    .sort((left, right) => compareBuildIds(right.buildId, left.buildId));

  if (!newest) {
    throw new Error(
      `No Chrome for Testing for ${platform} under ${join(cacheDir, "chrome")}. Run ` +
        "`pnpm --filter @latch-works/showcase screenshots:install-browser` or set CHROME_PATH.",
    );
  }

  return newest.executablePath;
}
