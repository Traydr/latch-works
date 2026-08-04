import React from 'react';
import { createRoot } from 'react-dom/client';
// Keep React DOM's CommonJS dependency inside Vite's browser bundle.
import 'scheduler';

import './index.css';
import { App } from './renderer/App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
