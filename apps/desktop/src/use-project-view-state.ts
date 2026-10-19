import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { workerScope } from './worker-scope';

/** A late action can persist in its own project without changing another project's view. */
export function useProjectViewState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
export function useProjectViewState<S = undefined>(): [
  S | undefined,
  Dispatch<SetStateAction<S | undefined>>,
];
export function useProjectViewState<S>(initial?: S | (() => S)) {
  const [state, setState] = useState(initial);
  const scope = workerScope();
  const setScopedState: Dispatch<SetStateAction<S | undefined>> = useCallback(
    (value) => {
      const current = workerScope();
      if (
        scope?.projectId !== current?.projectId ||
        scope?.projectSessionId !== current?.projectSessionId
      )
        return;
      setState(value);
    },
    [scope?.projectId, scope?.projectSessionId],
  );
  return [state, setScopedState];
}
