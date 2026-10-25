import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_FONT_SCALE,
  DEFAULT_WORKSPACE_FONT_SCALE,
  FONT_SCALE_STORAGE_KEY,
  FontScaleProvider,
  useFontScale,
} from './font-scale';

function FontScaleProbe() {
  const { global, workspace, setGlobal, setWorkspace } = useFontScale();
  return (
    <div>
      <span data-testid="global">{global}</span>
      <span data-testid="workspace">{workspace}</span>
      <button type="button" onClick={() => setGlobal(1.5)}>
        调整全局
      </button>
      <button type="button" onClick={() => setWorkspace(1.1)}>
        调整工作区
      </button>
    </div>
  );
}

describe('font scale provider', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.style.removeProperty('--ui-font-scale');
    document.documentElement.style.removeProperty('--ui-workspace-font-scale');
  });

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('applies and persists the two independent font scales', () => {
    render(
      <FontScaleProvider>
        <FontScaleProbe />
      </FontScaleProvider>,
    );

    expect(screen.getByTestId('global')).toHaveTextContent(String(DEFAULT_UI_FONT_SCALE));
    expect(screen.getByTestId('workspace')).toHaveTextContent(String(DEFAULT_WORKSPACE_FONT_SCALE));
    expect(document.documentElement.style.getPropertyValue('--ui-font-scale')).toBe('1.3');
    expect(document.documentElement.style.getPropertyValue('--ui-workspace-font-scale')).toBe(
      '1.3',
    );

    act(() => {
      screen.getByRole('button', { name: '调整全局' }).click();
      screen.getByRole('button', { name: '调整工作区' }).click();
    });

    expect(screen.getByTestId('global')).toHaveTextContent('1.5');
    expect(screen.getByTestId('workspace')).toHaveTextContent('1.1');
    expect(document.documentElement.style.getPropertyValue('--ui-font-scale')).toBe('1.5');
    expect(document.documentElement.style.getPropertyValue('--ui-workspace-font-scale')).toBe(
      '1.1',
    );
    expect(JSON.parse(window.localStorage.getItem(FONT_SCALE_STORAGE_KEY)!)).toEqual({
      global: 1.5,
      workspace: 1.1,
    });
  });

  it('restores stored scales and clamps invalid values', () => {
    window.localStorage.setItem(
      FONT_SCALE_STORAGE_KEY,
      JSON.stringify({ global: 2, workspace: 0.5 }),
    );

    render(
      <FontScaleProvider>
        <FontScaleProbe />
      </FontScaleProvider>,
    );

    expect(screen.getByTestId('global')).toHaveTextContent('1.7');
    expect(screen.getByTestId('workspace')).toHaveTextContent('0.9');
  });
});
