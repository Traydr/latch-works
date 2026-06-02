import type { FrameViewApi } from './shared/types';

declare global {
  interface Window {
    frameView: FrameViewApi;
  }
}
