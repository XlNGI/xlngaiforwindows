import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DetachedPanelApp } from './workspace/DetachedPanelApp';
import { parseDetachedPanelConfig } from './workspace/detached-window';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Application root was not found.');

const detachedPanel = parseDetachedPanelConfig();

createRoot(root).render(
  <StrictMode>{detachedPanel ? <DetachedPanelApp config={detachedPanel} /> : <App />}</StrictMode>,
);
