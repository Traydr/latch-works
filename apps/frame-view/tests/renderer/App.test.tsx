// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Result } from 'better-result';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '../../src/renderer/store/useAppStore';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { createFrameViewMock } from '../frameViewMock';

vi.mock('../../src/renderer/layouts', () => ({
  PrismLayout: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
    <button type="button" onClick={onOpenSettings}>
      open-settings
    </button>
  ),
}));

vi.mock('../../src/renderer/components/SettingsDrawer', () => ({
  SettingsDrawer: ({ onUpdate }: { onUpdate: (patch: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onUpdate({
          filters: {
            ...DEFAULT_SETTINGS.filters,
            showVideos: false,
          },
        })
      }
    >
      apply-filter
    </button>
  ),
}));

vi.mock('../../src/renderer/components/ViewerModal', () => ({
  ViewerModal: () => null,
}));

describe('App', () => {
  const initialState = useAppStore.getState();

  beforeEach(() => {
    useAppStore.setState(
      {
        ...initialState,
        rootPath: 'C:\\media',
        recursive: false,
      },
      true,
    );

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      })),
    });

    window.frameView = createFrameViewMock();
  });

  afterEach(async () => {
    cleanup();
    useAppStore.setState(initialState, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('rescans exactly once when filters are updated from settings', async () => {
    const user = userEvent.setup();
    const { App } = await import('../../src/renderer/App');

    render(<App />);

    await user.click(screen.getByText('open-settings'));
    await user.click(await screen.findByText('apply-filter'));

    await waitFor(() => {
      expect(window.frameView.updateSettings).toHaveBeenCalledTimes(1);
      expect(window.frameView.startScan).toHaveBeenCalledTimes(1);
    });
  });

  it('bootstraps a remembered folder without restarting bootstrap side effects', async () => {
    const { App } = await import('../../src/renderer/App');

    vi.mocked(window.frameView.getSettings).mockResolvedValue(
      Result.ok({
        ...DEFAULT_SETTINGS,
        lastFolderPath: 'C:\\media',
        rememberLastFolder: true,
      }),
    );

    render(<App />);

    await waitFor(() => {
      expect(window.frameView.getSettings).toHaveBeenCalledTimes(1);
      expect(window.frameView.startScan).toHaveBeenCalledTimes(1);
      expect(window.frameView.startScan).toHaveBeenCalledWith({
        rootPath: 'C:\\media',
        recursive: DEFAULT_SETTINGS.recursiveDefault,
        filters: DEFAULT_SETTINGS.filters,
        excludedRootChildPaths: [],
      });
    });

    expect(window.frameView.cancelScan).not.toHaveBeenCalled();
  });
});
