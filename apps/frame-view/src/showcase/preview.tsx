import React from 'react';
import { createRoot } from 'react-dom/client';

import '../index.css';
import { App } from '../renderer/App';
import { installShowcaseFrameViewMock } from './mockFrameView';
import { enableShowcasePreview } from './runtime';

enableShowcasePreview();
installShowcaseFrameViewMock();

document.documentElement.classList.add('dark');
document.body.classList.add('dark');

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
