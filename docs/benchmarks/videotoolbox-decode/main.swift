// Times VideoToolbox's hardware decoder on one file, three ways:
//   sync    one frame at a time, waiting for each (what FFmpeg's hwaccel does)
//   async   every frame handed over at once, waiting at the end
//   discard async, with frames marked "do not output" (a seek's catch-up)
// and Apple's own exact seek (AVAssetImageGenerator, zero tolerance) to the middle.
import AVFoundation
import CoreMedia
import Foundation
import VideoToolbox

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var frames = 0
    private var failures = 0
    func add(image: Bool, status: OSStatus) {
        lock.lock()
        if image { frames += 1 }
        if status != noErr { failures += 1 }
        lock.unlock()
    }
    var value: (Int, Int) {
        lock.lock()
        defer { lock.unlock() }
        return (frames, failures)
    }
}

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }

let path = CommandLine.arguments[1]
let asset = AVURLAsset(url: URL(fileURLWithPath: path))
guard let track = asset.tracks(withMediaType: .video).first else {
    print("no video track")
    exit(1)
}
let format = track.formatDescriptions[0] as! CMFormatDescription
let size = CMVideoFormatDescriptionGetDimensions(format)
let codec = CMFormatDescriptionGetMediaSubType(format)
let fourcc = String(bytes: [24, 16, 8, 0].map { UInt8((codec >> $0) & 0xff) }, encoding: .ascii) ?? "?"

// Every compressed sample, read ahead so file reads are not timed.
var samples: [CMSampleBuffer] = []
do {
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    output.alwaysCopiesSampleData = true
    reader.add(output)
    reader.startReading()
    while let sample = output.copyNextSampleBuffer() {
        if CMSampleBufferGetNumSamples(sample) > 0, CMSampleBufferGetDataBuffer(sample) != nil {
            samples.append(sample)
        }
    }
} catch {
    print("cannot read: \(error)")
    exit(1)
}
let megapixels = Double(size.width) * Double(size.height) / 1e6
print(String(format: "%@ %dx%d %.0f fps, %d frames", fourcc, size.width, size.height, track.nominalFrameRate, samples.count))

func run(_ label: String, flags: VTDecodeFrameFlags, waitEach: Bool) {
    var session: VTDecompressionSession?
    let spec: [CFString: Any] = [
        kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder: true
    ]
    let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
    let created = now()
    let status = VTDecompressionSessionCreate(
        allocator: nil, formatDescription: format, decoderSpecification: spec as CFDictionary,
        imageBufferAttributes: attributes as CFDictionary, outputCallback: nil,
        decompressionSessionOut: &session)
    guard status == noErr, let session else {
        print("  \(label): no hardware session (\(status))")
        return
    }
    let counter = Counter()
    let started = now()
    for sample in samples {
        VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: flags, infoFlagsOut: nil) {
            status, _, image, _, _ in
            counter.add(image: image != nil, status: status)
        }
        if waitEach { VTDecompressionSessionWaitForAsynchronousFrames(session) }
    }
    VTDecompressionSessionWaitForAsynchronousFrames(session)
    let took = now() - started
    let (frames, failures) = counter.value
    VTDecompressionSessionInvalidate(session)
    let fps = Double(samples.count) / took * 1000
    print(String(
        format: "  %@: %4.0f ms, %5.0f fps, %4.2f GP/s (session %2.0f ms, %d pictures, %d failed)",
        label.padding(toLength: 8, withPad: " ", startingAt: 0), took, fps, fps * megapixels / 1000,
        started - created, frames, failures))
}

// Once unmeasured, so the first timed run does not pay for the decoder's start.
run("warm-up", flags: [._EnableAsynchronousDecompression], waitEach: false)
run("sync", flags: [], waitEach: true)
run("async", flags: [._EnableAsynchronousDecompression], waitEach: false)
run("discard", flags: [._EnableAsynchronousDecompression, ._DoNotOutputFrame], waitEach: false)

// Apple's exact seek: the picture at each time, decoded from the keyframe before it.
let generator = AVAssetImageGenerator(asset: asset)
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero
let duration = CMTimeGetSeconds(asset.duration)
var seeks: [String] = []
for share in [0.5, 0.9, 0.3, 0.7, 0.45] {
    let started = now()
    let time = CMTime(seconds: duration * share, preferredTimescale: 600)
    if (try? generator.copyCGImage(at: time, actualTime: nil)) != nil {
        seeks.append(String(format: "%.0f", now() - started))
    } else {
        seeks.append("-")
    }
}
print("  AVAssetImageGenerator exact seeks, ms: " + seeks.joined(separator: " "))
