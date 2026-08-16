import type { LayoutStorage } from 'react-resizable-panels';

export const safePanelLayoutStorage: LayoutStorage = {
  getItem(key) {
    try {
      return window.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      window.localStorage?.setItem(key, value);
    } catch {
      // Panel proportions remain available for the current session.
    }
  },
};

export function matchesViewport(query: string, fallbackWidth: number): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : window.innerWidth <= fallbackWidth;
}
