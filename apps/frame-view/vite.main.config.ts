import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'ffmpeg-static',
        '@ffprobe-installer/ffprobe',
        'sharp',
        /^@img\/sharp-/,
        /^@img\/sharp-libvips-/,
      ],
    },
  },
});
