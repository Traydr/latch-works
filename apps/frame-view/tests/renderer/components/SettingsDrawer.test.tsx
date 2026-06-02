// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SettingsDrawer } from '../../../src/renderer/components/SettingsDrawer';
import { DEFAULT_SETTINGS } from '../../../src/shared/types';

describe('SettingsDrawer', () => {
  it('switches tabs and reports copied diagnostics status', async () => {
    const user = userEvent.setup();
    const onCopyDiagnostics = vi.fn(async () => undefined);

    render(
      <SettingsDrawer
        currentFolderSummary={{
          folderName: 'media',
          itemCount: 12,
          recursive: false,
          scanState: 'done',
        }}
        diagnosticsSnapshot={null}
        isOpen={true}
        mediaIndexStats={null}
        mediaToolsStatus={null}
        onClearMediaIndex={vi.fn()}
        onClearThumbnailCache={vi.fn()}
        onClose={vi.fn()}
        onCopyDiagnostics={onCopyDiagnostics}
        onRefreshDiagnostics={vi.fn(async () => undefined)}
        onUpdate={vi.fn()}
        settings={DEFAULT_SETTINGS}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Debug' }));
    await user.click(screen.getByRole('button', { name: 'Copy Diagnostics' }));

    await waitFor(() => {
      expect(onCopyDiagnostics).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('Diagnostics copied to clipboard')).toBeTruthy();
  });
});
