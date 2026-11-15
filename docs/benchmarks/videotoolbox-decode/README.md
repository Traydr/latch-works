# VideoToolbox decode benchmark

`main.swift` times the hardware video decoder on one file, without FFmpeg or mpv. It answers one
question: is an exact seek slow because the hardware is slow, or because of how FFmpeg drives
the hardware?

It decodes every frame of the file three ways through a `VTDecompressionSession`:

- `sync`: one frame at a time, with a wait for each picture. FFmpeg's `videotoolbox.c` decodes
  this way.
- `async`: every frame handed over with `kVTDecodeFrame_EnableAsynchronousDecompression`, and
  one wait at the end.
- `discard`: as `async`, with `kVTDecodeFrame_DoNotOutputFrame`, as a seek does for the frames
  before its target.

It then times five exact seeks with `AVAssetImageGenerator` at zero tolerance. That part reads
MP4 and MOV only, and it printed no times for the AV1 fixture.

## Run it

macOS only. The Swift compiler comes with the Xcode command line tools.

```sh
cd docs/benchmarks/videotoolbox-decode
swiftc -O -swift-version 5 main.swift -o /tmp/vtbench
/tmp/vtbench ~/.latch-works/oriel-fixtures/spike-fixture/videos/h264/VID_2.mp4
```

## Results

Apple M5 Pro, macOS 27.0.1, 2026-11-14. Frames decoded a second:

| File | `sync` | `async` | `discard` |
| --- | ---: | ---: | ---: |
| `h264/VID_2.mp4`, 2560x1440 | 389 | 1,086 | 1,092 |
| `hevc/VID_3.mp4`, 2560x1440 | 655 | 1,602 | 1,607 |
| `av1/VID_4.mp4`, 2560x1440 | 769 | 1,539 | 1,557 |
| `h264/VID_1.mp4`, 1280x720 | 1,608 | 5,416 | 5,609 |

For comparison, `ffmpeg -i <file> -an -f null -` decodes the three 1440p files in software at
about 830, 570, and 500 frames a second. With `-hwaccel videotoolbox` the same command reaches
260 to 390.

The hardware is not the limit. FFmpeg's one-frame-at-a-time decoding is. `docs/runbooks/oriel.md`
("Video through libmpv") describes what Oriel does about it.
