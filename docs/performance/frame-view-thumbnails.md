# Frame View thumbnail performance

Measured on 2026-09-23 with an Apple M5 Pro, 18 available logical CPUs, 48 GiB RAM,
Electron 44.3.0, and Sharp 0.35.4. The main target was AVIF thumbnails appearing after
scrolling. Thumbnail dimensions and AVIF encoding settings remain unchanged.

## AVIF results

The benchmark used 80 AVIF files sampled at evenly spaced positions from a local archive.
It copied them into a temporary directory and renamed them before launching Frame View.
The source archive was read only. No source images, names, or paths are in this report or PR.

Each run launched Electron with fresh user data and an empty thumbnail cache, hardware
acceleration enabled, and a 1280 × 900 window. The benchmark measured opening the folder
until every visible image loaded, then four scrollbar jumps 40 ms apart and a final jump
to the bottom. Scroll time includes those deliberate delays. OS filesystem caches were
not flushed, so these are cold thumbnail-cache measurements, not cold disk measurements.

| configuration | open viewport, ms | rapid scroll, ms |
| --- | ---: | ---: |
| Two workers, initial run 1 | 2449 | 2303 |
| Two workers, initial run 2 | 3264 | 1419 |
| Two workers, initial run 3 | 2415 | 2371 |
| Two workers, final confirmation | 3114 | 1570 |
| Adaptive pool, final run 1 | 1580 | 585 |
| Adaptive pool, final run 2 | 1629 | 572 |
| Adaptive pool, final run 3 | 1603 | 523 |

The final median scroll time was 572 ms. That is 2.7× faster than the confirmation
baseline and 4.0× faster than the initial baseline median. The confirmation baseline
failed a 1000 ms scroll limit; all three final runs passed it. Opening the first viewport
was about 1.9× faster against the confirmation baseline.

After each final run, 45 loaded thumbnails were fetched through Electron's media protocol
and compared against the previous Sharp pipeline. All 135 comparisons were byte-identical.
The representative portrait thumbnail remained 380 × 440. The test also asserts that the
longest thumbnail dimension remains 440, the default 220 setting at the existing 2x scale.

## Retained changes and costs

The image worker pool now uses half the available logical CPUs, capped at six workers and
one worker per 2 GiB of system RAM, with the previous two-worker floor. This machine uses
six workers. Four logical CPUs still select two; eight CPUs with 8 GiB select four.
Workers start on demand. Video concurrency remains one.

This is a resource heuristic, not a hard memory limit. In the final confirmation, the sum
of Electron-reported process working sets rose from about 1.38 GiB with two workers to
1.97 GiB with six. This sum includes shared process memory and is neither a peak measurement
nor a measurement of unique physical memory. AVIF decoding itself allocates substantial
memory, so smaller machines retain a lower worker count.

PNG, GIF, and BMP thumbnails retain lossless WebP encoding but use effort 0 instead of 5.
A separate textured 2048 × 1536 PNG test reduced 640-pixel thumbnail generation from about
280 ms to 43 ms. Its cache file grew from 439,476 to 542,596 bytes, about 23%. The initial
Electron test with two workers reduced a cold scroll jump from a median 4678 ms to 521 ms.
This benefit does not apply to AVIF. Lossless tests check visible RGB, alpha, and dimensions;
WebP may discard invisible RGB under fully transparent pixels at either effort.

Shared random sorting now computes each path hash once. A 30,000-item experiment fell from
107–111 ms to 9–13 ms with identical seeded ordering. Tests pin ordering, tie handling,
input immutability, and Windows-style paths. Frame View and other media-domain consumers
receive this improvement.

## Experiments not retained

- Disabling Sharp's operation cache did not meaningfully reduce memory or scrolling time.
- Waiting for cancelled jobs before reusing worker slots did not establish a causal gain.
  Electron reported zero aborted requests during these scrollbar jumps.
- Thumbnail URL priorities were left intact. Removing priority information without a
  replacement scheduler could delay visible thumbnails behind overscan requests.
- Lower resolution, lower quality, and changes to AVIF/JPEG/video encoding were excluded.

Node's [availableParallelism](https://nodejs.org/api/os.html#osavailableparallelism) supplies
CPU capacity on both macOS and Windows. Sharp documents
[WebP effort and lossless mode](https://sharp.pixelplumbing.com/api-output/#webp) separately.
The implementation uses existing Electron workers and codecs, with no native OS-specific
thumbnail APIs. Windows timings and packaged builds still need validation on Windows.

## Reproduction

Use the same build mode for both revisions. The measurements above used a Forge development
build for AVIF. Start it with a disposable `--user-data-dir`, or have a packaged build ready.
The agent did not run `package` or `make`, which this repository reserves for the user.

Point `FRAME_PERF_FIXTURE_DIR` at a directory containing at least 80 AVIF files. The script
reads the first 80 sorted filenames and copies them into its own temporary archive. It writes
only temporary archive copies, app settings, catalog state, and thumbnail caches, then removes
them. The input directory is never written. No server, database, or object storage is involved.

```sh
FRAME_PERF_FIXTURE_DIR=/path/to/avif-fixtures FRAME_PERF_RAPID_SCROLL=1 \
  FRAME_PERF_MAX_SCROLL_MS=1000 \
  pnpm --filter @latch-works/e2e exec tsx scripts/frame-performance.ts current
```

The time limit is optional and machine-specific. On Windows, set the same environment
variables in PowerShell before running the `pnpm` command. The script selects `electron.exe`.
Without a fixture directory, it creates the synthetic PNG workload instead. Without rapid
scroll enabled, it measures a single jump to the bottom.

To check interactively, open an AVIF folder, scroll or drag to uncached rows, then revisit
those rows. Check that thumbnails retain their detail and that settings, video hover,
viewer navigation, and Comic mode still work. Repeat on a smaller Windows machine to assess
the resource limit before release.
