import { Menu, type MenuItemConstructorOptions } from 'electron';

import type { AppCommand } from '../shared/types';

export function buildAppMenu(onCommand: (command: AppCommand) => void): void {
  const isMac = process.platform === 'darwin';

  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Open Folder...',
      accelerator: isMac ? 'CmdOrCtrl+O' : 'Ctrl+O',
      click: () => onCommand({ type: 'open-folder-dialog' }),
    },
    {
      label: 'Refresh',
      accelerator: isMac ? 'CmdOrCtrl+R' : 'F5',
      click: () => onCommand({ type: 'refresh-current-folder' }),
    },
    { type: 'separator' },
    isMac ? { role: 'close' } : { role: 'quit' },
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Preferences',
      accelerator: isMac ? 'CmdOrCtrl+,' : 'Ctrl+,',
      click: () => onCommand({ type: 'toggle-settings' }),
    },
    { type: 'separator' },
    { role: 'reload' },
    { role: 'forceReload' },
    { role: 'toggleDevTools' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  const macWindowItems: MenuItemConstructorOptions[] = isMac ? [{ role: 'zoom' }] : [];
  const windowSubmenu: MenuItemConstructorOptions[] = [
    { role: 'minimize' },
    ...macWindowItems,
    { role: 'close' },
  ];

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: 'Frame View',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push(
    {
      label: 'File',
      submenu: fileSubmenu,
    },
    {
      label: 'View',
      submenu: viewSubmenu,
    },
    {
      label: 'Window',
      submenu: windowSubmenu,
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Frame View Help',
          click: () => onCommand({ type: 'toggle-settings' }),
        },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
