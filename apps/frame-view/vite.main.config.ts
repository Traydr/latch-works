import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'ffmpeg-static',
        'ffprobe-static',
        'sharp',
        /^@img\/sharp-/,
        /^@img\/sharp-libvips-/,
      ],
    },
  },
});
