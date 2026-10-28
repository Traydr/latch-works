/*
 * Asks a freshly built libmpv set what it is, for build-libmpv.ts to check and record: each
 * FFmpeg library's licence and configuration, mpv's client API, version and enabled features,
 * and whether the decoders, demuxers and hardware decoding playback needs are there.
 *
 * Prints one "key<TAB>value" line per answer, with any newline in a value turned into a space.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/hwcontext.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
#include <mpv/client.h>

static void put(const char *key, const char *value) {
    printf("%s\t", key);
    for (const char *c = value ? value : ""; *c; c++)
        putchar(*c == '\n' || *c == '\t' ? ' ' : *c);
    putchar('\n');
}

/* Whether FFmpeg has a decoder by this name, and whether it can decode through VideoToolbox. */
static void decoder(const char *name) {
    const AVCodec *codec = avcodec_find_decoder_by_name(name);
    const char *answer = "missing";
    if (codec) {
        answer = "software";
        for (int i = 0;; i++) {
            const AVCodecHWConfig *config = avcodec_get_hw_config(codec, i);
            if (!config)
                break;
            if (config->device_type == AV_HWDEVICE_TYPE_VIDEOTOOLBOX)
                answer = "videotoolbox";
        }
    }
    char key[64];
    snprintf(key, sizeof key, "decoder.%s", name);
    put(key, answer);
}

static void demuxer(const char *name) {
    char key[64];
    snprintf(key, sizeof key, "demuxer.%s", name);
    put(key, av_find_input_format(name) ? "present" : "missing");
}

int main(void) {
    put("avutil_license", avutil_license());
    put("avcodec_license", avcodec_license());
    put("avformat_license", avformat_license());
    put("avfilter_license", avfilter_license());
    put("swscale_license", swscale_license());
    put("swresample_license", swresample_license());
    put("ffmpeg_configuration", avcodec_configuration());
    put("ffmpeg_version", av_version_info());

    const char *decoders[] = {"h264", "hevc", "av1", "libdav1d", "vp9", "vp8", "mpeg4",
                              "mpeg2video", "prores", "flv", "wmv2", "wmv3", "vc1", "aac",
                              "mp3", "opus", "vorbis", "flac", "ac3", "eac3", "pcm_s16le"};
    for (size_t i = 0; i < sizeof decoders / sizeof *decoders; i++)
        decoder(decoders[i]);
    const char *demuxers[] = {"mov", "matroska", "avi", "flv", "asf", "mpegts", "ogg", "mpeg"};
    for (size_t i = 0; i < sizeof demuxers / sizeof *demuxers; i++)
        demuxer(demuxers[i]);
    /* Encoders are left out of the set; none should be found. */
    put("encoder.h264", avcodec_find_encoder(AV_CODEC_ID_H264) ? "present" : "missing");

    unsigned long api = mpv_client_api_version();
    char version[32];
    snprintf(version, sizeof version, "%lu.%lu", api >> 16, api & 0xffff);
    put("mpv_client_api_version", version);

    mpv_handle *mpv = mpv_create();
    if (!mpv) {
        put("mpv_error", "mpv_create failed");
        return 1;
    }
    mpv_set_option_string(mpv, "config", "no");
    mpv_set_option_string(mpv, "terminal", "no");
    mpv_set_option_string(mpv, "idle", "yes");
    mpv_set_option_string(mpv, "vo", "null");
    mpv_set_option_string(mpv, "ao", "null");
    /* mpv prints its configuration and feature list at the verbose level while it starts. */
    mpv_request_log_messages(mpv, "v");
    int status = mpv_initialize(mpv);
    if (status < 0) {
        put("mpv_error", mpv_error_string(status));
        return 1;
    }
    for (;;) {
        mpv_event *event = mpv_wait_event(mpv, 0.5);
        if (event->event_id == MPV_EVENT_NONE)
            break;
        if (event->event_id != MPV_EVENT_LOG_MESSAGE)
            continue;
        mpv_event_log_message *message = event->data;
        const char *features = "List of enabled features: ";
        if (strncmp(message->text, features, strlen(features)) == 0)
            put("mpv_features", message->text + strlen(features));
    }

    const char *properties[] = {"mpv-version", "mpv-configuration", "ffmpeg-version",
                                "libass-version"};
    for (size_t i = 0; i < sizeof properties / sizeof *properties; i++) {
        char *value = mpv_get_property_string(mpv, properties[i]);
        put(properties[i], value);
        mpv_free(value);
    }
    mpv_terminate_destroy(mpv);
    return 0;
}
