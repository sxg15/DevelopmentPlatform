import React from 'react';
import { createRoot } from 'react-dom/client';
import 'react-chrono/dist/style.css';
import './styles.css';
import { installGlobalErrorReporting } from './api/clientErrors.js';
import { App } from './ui/App.jsx';
import { AppErrorBoundary } from './ui/AppErrorBoundary.jsx';

installGlobalErrorReporting();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('找不到应用根节点');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
