import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DetachedPanelApp } from './workspace/DetachedPanelApp';
import { parseDetachedPanelConfig } from './workspace/detached-window';
import { applyTheme, readStoredTheme, ThemeProvider } from './theme';
import { applyFontScales, FontScaleProvider, readStoredFontScales } from './font-scale';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Application root was not found.');

const detachedPanel = parseDetachedPanelConfig();
applyTheme(readStoredTheme());
applyFontScales(readStoredFontScales());

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <FontScaleProvider>
        {detachedPanel ? <DetachedPanelApp config={detachedPanel} /> : <App />}
      </FontScaleProvider>
    </ThemeProvider>
  </StrictMode>,
);
