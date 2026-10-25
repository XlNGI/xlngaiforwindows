import { act, fireEvent } from '@testing-library/react';
import { $getRoot, getNearestEditorFromDOMNode } from 'lexical';

/** Exercise the actual plain-text paste command instead of a textarea-only change event. */
export async function replacePromptText(element: HTMLElement, text: string) {
  const editor = getNearestEditorFromDOMNode(element);
  if (!editor) throw new Error('Prompt editor is not mounted.');
  await act(async () => {
    editor.update(() => $getRoot().select(0, $getRoot().getChildrenSize()), { discrete: true });
    fireEvent.paste(element, {
      clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') },
    });
    await Promise.resolve();
  });
}
