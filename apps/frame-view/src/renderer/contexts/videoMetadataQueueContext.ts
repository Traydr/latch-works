import { createContext } from 'react';

import type { MediaItem } from '../../shared/types';

export const VideoMetadataQueueContext = createContext<(item: MediaItem) => void>(() => undefined);
