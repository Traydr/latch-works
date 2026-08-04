import type { JSX, PropsWithChildren } from 'react';

import { useVideoMetadataQueue } from '../hooks/useVideoMetadataQueue';
import { useAppStore } from '../store/useAppStore';
import { VideoMetadataQueueContext } from './videoMetadataQueueContext';

export function VideoMetadataQueueProvider({ children }: PropsWithChildren): JSX.Element {
  const activeScanRunId = useAppStore((state) => state.activeScanRunId);
  const applyVideoMetadata = useAppStore((state) => state.applyVideoMetadata);
  const requestVideoMetadata = useVideoMetadataQueue({ activeScanRunId, applyVideoMetadata });

  return (
    <VideoMetadataQueueContext.Provider value={requestVideoMetadata}>
      {children}
    </VideoMetadataQueueContext.Provider>
  );
}
