import { useEffect, useReducer } from 'react';
import { viewportFromWindow } from './workspace-geometry';
import { workspaceReducer, createDefaultWorkspaceLayout } from './workspace-reducer';
import { readWorkspaceLayout, writeWorkspaceLayout } from './workspace-storage';

export function useWorkspaceLayout(projectId: string | undefined) {
  const [layout, dispatch] = useReducer(workspaceReducer, undefined, () =>
    createDefaultWorkspaceLayout(projectId, viewportFromWindow()),
  );

  useEffect(() => {
    const viewport = viewportFromWindow();
    dispatch({
      type: 'hydrate',
      state: projectId
        ? (readWorkspaceLayout(projectId) ?? createDefaultWorkspaceLayout(projectId, viewport))
        : createDefaultWorkspaceLayout(undefined, viewport),
    });
  }, [projectId]);

  useEffect(() => {
    if (!layout.projectId) return;
    const timer = window.setTimeout(() => writeWorkspaceLayout(layout), 200);
    return () => window.clearTimeout(timer);
  }, [layout]);

  useEffect(() => {
    const onResize = () => dispatch({ type: 'clamp', viewport: viewportFromWindow() });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return { layout, dispatch };
}
