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

export const FONT_SCALE_STORAGE_KEY = 'ai-video.ui-font-scale';
const FONT_SCALE_CHANNEL_NAME = 'ai-video.ui-font-scale';

export const DEFAULT_UI_FONT_SCALE = 1.3;
export const DEFAULT_WORKSPACE_FONT_SCALE = 1.3;
export const FONT_SCALE_MIN = 0.9;
export const FONT_SCALE_MAX = 1.7;
export const FONT_SCALE_STEP = 0.05;

export interface FontScalePreferences {
  global: number;
  workspace: number;
}

interface FontScaleContextValue extends FontScalePreferences {
  setGlobal: (scale: number) => void;
  setWorkspace: (scale: number) => void;
}

const FontScaleContext = createContext<FontScaleContextValue | undefined>(undefined);

function clampScale(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
}

function normalizePreferences(value: Partial<FontScalePreferences> | null | undefined) {
  return {
    global: clampScale(value?.global ?? DEFAULT_UI_FONT_SCALE, DEFAULT_UI_FONT_SCALE),
    workspace: clampScale(
      value?.workspace ?? DEFAULT_WORKSPACE_FONT_SCALE,
      DEFAULT_WORKSPACE_FONT_SCALE,
    ),
  } satisfies FontScalePreferences;
}

export function readStoredFontScales(): FontScalePreferences {
  if (typeof window === 'undefined') return normalizePreferences(undefined);
  try {
    const raw = window.localStorage.getItem(FONT_SCALE_STORAGE_KEY);
    if (!raw) return normalizePreferences(undefined);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return normalizePreferences(undefined);
    const record = parsed as Record<string, unknown>;
    return normalizePreferences({
      global: typeof record.global === 'number' ? record.global : undefined,
      workspace: typeof record.workspace === 'number' ? record.workspace : undefined,
    });
  } catch {
    return normalizePreferences(undefined);
  }
}

export function applyFontScales(preferences: FontScalePreferences): void {
  if (typeof document === 'undefined') return;
  const normalized = normalizePreferences(preferences);
  document.documentElement.style.setProperty('--ui-font-scale', String(normalized.global));
  document.documentElement.style.setProperty(
    '--ui-workspace-font-scale',
    String(normalized.workspace),
  );
}

function persistFontScales(preferences: FontScalePreferences): void {
  const normalized = normalizePreferences(preferences);
  applyFontScales(normalized);
  window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, JSON.stringify(normalized));
}

export function FontScaleProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<FontScalePreferences>(readStoredFontScales);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    applyFontScales(preferences);
  }, [preferences]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== FONT_SCALE_STORAGE_KEY || !event.newValue) return;
      try {
        const parsed: unknown = JSON.parse(event.newValue);
        if (parsed && typeof parsed === 'object') setPreferences(normalizePreferences(parsed));
      } catch {
        // Ignore malformed values from another window.
      }
    };
    window.addEventListener('storage', handleStorage);

    if ('BroadcastChannel' in window) {
      const channel = new BroadcastChannel(FONT_SCALE_CHANNEL_NAME);
      channelRef.current = channel;
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data && typeof event.data === 'object')
          setPreferences(normalizePreferences(event.data as Partial<FontScalePreferences>));
      };
    }

    return () => {
      window.removeEventListener('storage', handleStorage);
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, []);

  const update = useCallback((key: keyof FontScalePreferences, value: number) => {
    setPreferences((current) => {
      const next = normalizePreferences({ ...current, [key]: value });
      persistFontScales(next);
      channelRef.current?.postMessage(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      ...preferences,
      setGlobal: (scale: number) => update('global', scale),
      setWorkspace: (scale: number) => update('workspace', scale),
    }),
    [preferences, update],
  );
  return <FontScaleContext.Provider value={value}>{children}</FontScaleContext.Provider>;
}

export function useFontScale(): FontScaleContextValue {
  const context = useContext(FontScaleContext);
  const [fallback, setFallback] = useState<FontScalePreferences>(readStoredFontScales);

  useEffect(() => {
    if (!context) applyFontScales(fallback);
  }, [context, fallback]);

  const setFallbackScale = useCallback((key: keyof FontScalePreferences, value: number) => {
    setFallback((current) => {
      const next = normalizePreferences({ ...current, [key]: value });
      persistFontScales(next);
      return next;
    });
  }, []);

  return (
    context ?? {
      ...fallback,
      setGlobal: (scale: number) => setFallbackScale('global', scale),
      setWorkspace: (scale: number) => setFallbackScale('workspace', scale),
    }
  );
}
