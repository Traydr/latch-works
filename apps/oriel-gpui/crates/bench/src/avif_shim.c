// libavif's encoder as the wasm build Tidy uses drives it: jSquash's `avif_enc.cpp`
// (packages/avif/codec/enc), line for line, for 8-bit RGBA input. Rust calls the one function
// below rather than laying out libavif's structs itself, whose fields change between releases.

#include <avif/avif.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// `ARCHIVE_AVIF_OPTIONS` in packages/media-format/src/avif.ts, plus the thread count, which the
// single-threaded wasm build fixes at one.
typedef struct {
  int quality;
  int quality_alpha;
  int tile_rows_log2;
  int tile_cols_log2;
  int speed;
  int subsample;
  int chroma_delta_q;
  int sharpness;
  int tune;
  int denoise_level;
  int enable_sharp_yuv;
  int max_threads;
} bench_avif_options;

const char *bench_avif_version(void) { return avifVersion(); }

void bench_avif_codec_versions(char *out, size_t size) {
  char versions[256] = {0};
  avifCodecVersions(versions);
  snprintf(out, size, "%s", versions);
}

void bench_avif_free(uint8_t *data) { free(data); }

// Encodes `rgba` (width × height × 4 bytes) to AVIF. On success returns 0 and hands back a malloc'd
// copy of the file in `out` and `out_size`; otherwise returns libavif's result code.
int bench_avif_encode(const uint8_t *rgba, uint32_t width, uint32_t height,
                      const bench_avif_options *options, uint8_t **out, size_t *out_size) {
  avifPixelFormat format = AVIF_PIXEL_FORMAT_YUV420;
  switch (options->subsample) {
    case 0: format = AVIF_PIXEL_FORMAT_YUV400; break;
    case 1: format = AVIF_PIXEL_FORMAT_YUV420; break;
    case 2: format = AVIF_PIXEL_FORMAT_YUV422; break;
    case 3: format = AVIF_PIXEL_FORMAT_YUV444; break;
  }

  int lossless = options->quality == AVIF_QUALITY_LOSSLESS &&
                 (options->quality_alpha == -1 ||
                  options->quality_alpha == AVIF_QUALITY_LOSSLESS) &&
                 format == AVIF_PIXEL_FORMAT_YUV444;

  avifImage *image = avifImageCreate(width, height, 8, format);
  if (image == NULL) return AVIF_RESULT_OUT_OF_MEMORY;
  image->matrixCoefficients =
      lossless ? AVIF_MATRIX_COEFFICIENTS_IDENTITY : AVIF_MATRIX_COEFFICIENTS_BT601;

  avifRGBImage rgb;
  avifRGBImageSetDefaults(&rgb, image);
  rgb.pixels = (uint8_t *)rgba;
  rgb.depth = 8;
  rgb.rowBytes = width * 4;
  if (options->enable_sharp_yuv) rgb.chromaDownsampling = AVIF_CHROMA_DOWNSAMPLING_SHARP_YUV;

  avifResult status = avifImageRGBToYUV(image, &rgb);
  if (status != AVIF_RESULT_OK) {
    avifImageDestroy(image);
    return status;
  }

  avifEncoder *encoder = avifEncoderCreate();
  if (encoder == NULL) {
    avifImageDestroy(image);
    return AVIF_RESULT_OUT_OF_MEMORY;
  }

  char number[16];
  if (lossless) {
    encoder->quality = AVIF_QUALITY_LOSSLESS;
    encoder->qualityAlpha = AVIF_QUALITY_LOSSLESS;
  } else {
    snprintf(number, sizeof number, "%d", options->sharpness);
    status = avifEncoderSetCodecSpecificOption(encoder, "sharpness", number);
    encoder->quality = options->quality;
    encoder->qualityAlpha = options->quality_alpha == -1 ? options->quality : options->quality_alpha;
    if (status == AVIF_RESULT_OK && (options->tune == 2 || (options->tune == 0 && options->quality >= 50))) {
      status = avifEncoderSetCodecSpecificOption(encoder, "tune", "ssim");
    }
    if (status == AVIF_RESULT_OK && options->chroma_delta_q) {
      status = avifEncoderSetCodecSpecificOption(encoder, "color:enable-chroma-deltaq", "1");
    }
    if (status == AVIF_RESULT_OK) {
      snprintf(number, sizeof number, "%d", options->denoise_level);
      status = avifEncoderSetCodecSpecificOption(encoder, "color:denoise-noise-level", number);
    }
  }

  encoder->codecChoice = AVIF_CODEC_CHOICE_AOM;
  encoder->maxThreads = options->max_threads;
  encoder->tileRowsLog2 = options->tile_rows_log2;
  encoder->tileColsLog2 = options->tile_cols_log2;
  encoder->speed = options->speed;

  avifRWData output = AVIF_DATA_EMPTY;
  if (status == AVIF_RESULT_OK) status = avifEncoderWrite(encoder, image, &output);

  if (status == AVIF_RESULT_OK) {
    *out = malloc(output.size);
    if (*out == NULL) {
      status = AVIF_RESULT_OUT_OF_MEMORY;
    } else {
      memcpy(*out, output.data, output.size);
      *out_size = output.size;
    }
  }

  avifRWDataFree(&output);
  avifEncoderDestroy(encoder);
  avifImageDestroy(image);
  return status;
}
