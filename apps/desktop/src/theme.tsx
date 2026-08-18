import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export const THEME_STORAGE_KEY = 'ai-video.ui-theme';
const THEME_CHANNEL_NAME = 'ai-video.ui-theme';

export type ThemeId = 'dark' | 'light' | 'midnight';

export const THEME_OPTIONS: Array<{ id: ThemeId; label: string }> = [
  { id: 'dark', label: '深色' },
  { id: 'light', label: '浅色' },
  { id: 'midnight', label: '午夜' },
];

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function isThemeId(value: string | null): value is ThemeId {
  return value === 'dark' || value === 'light' || value === 'midnight';
}

export function readStoredTheme(): ThemeId {
  if (typeof window === 'undefined') return 'dark';
  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemeId(storedTheme) ? storedTheme : 'dark';
}

export function applyTheme(theme: ThemeId): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }
}

function persistTheme(theme: ThemeId): void {
  applyTheme(theme);
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY && isThemeId(event.newValue)) {
        setThemeState(event.newValue);
      }
    };
    window.addEventListener('storage', handleStorage);

    if ('BroadcastChannel' in window) {
      const channel = new BroadcastChannel(THEME_CHANNEL_NAME);
      channelRef.current = channel;
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data === 'string' && isThemeId(event.data)) {
          setThemeState(event.data);
        }
      };
    }

    return () => {
      window.removeEventListener('storage', handleStorage);
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, []);

  const setTheme = useCallback((nextTheme: ThemeId) => {
    setThemeState(nextTheme);
    persistTheme(nextTheme);
    channelRef.current?.postMessage(nextTheme);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [setTheme, theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  const [fallbackTheme, setFallbackTheme] = useState<ThemeId>(readStoredTheme);
  const setFallback = useCallback((nextTheme: ThemeId) => {
    setFallbackTheme(nextTheme);
    persistTheme(nextTheme);
  }, []);

  useEffect(() => {
    if (!context) applyTheme(fallbackTheme);
  }, [context, fallbackTheme]);

  return context ?? { theme: fallbackTheme, setTheme: setFallback };
}
