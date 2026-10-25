import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $getRoot, $isTextNode, getNearestEditorFromDOMNode, UNDO_COMMAND } from 'lexical';
import type { PromptReference } from './prompt-references';
import { PromptReferenceEditor } from './PromptReferenceEditor';
import { replacePromptText } from './prompt-editor.test-utils';

const references: PromptReference[] = [
  {
    id: 'image:a',
    kind: 'image',
    url: 'https://example.com/a.png',
    label: '图片 1',
    text: '图 1',
    aliases: ['图1', '图 1', '图片 1'],
  },
  {
    id: 'audio:a',
    kind: 'audio',
    url: 'https://example.com/a.wav',
    label: '音频 1',
    text: '音频1',
    aliases: ['音频1', '音频 1'],
  },
];
afterEach(cleanup);
function Controlled({ initial = '图 1 是人物\n音频1 是声音' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PromptReferenceEditor
        value={value}
        references={references}
        label="提示词"
        onChange={setValue}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}
describe('inline prompt editor', () => {
  it.each(['Backspace', 'Delete'])('deletes an adjacent chip atomically with %s', async (key) => {
    render(<Controlled initial="a图 1b" />);
    await screen.findByAltText('图片 1');
    const field = screen.getByRole('textbox');
    const editor = getNearestEditorFromDOMNode(field)!;
    await act(async () => {
      editor.update(
        () => {
          const node =
            key === 'Backspace' ? $getRoot().getLastDescendant() : $getRoot().getFirstDescendant();
          if (!$isTextNode(node)) throw new Error('Expected text next to a reference chip.');
          node.select(key === 'Backspace' ? 0 : 1, key === 'Backspace' ? 0 : 1);
        },
        { discrete: true },
      );
      await Promise.resolve();
    });
    fireEvent.keyDown(field, { key });
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('ab'));
    expect(field.querySelector('.prompt-reference-chip')).toBeNull();
  });
  it('renders thumbnails and audio chips inside editable paragraphs', async () => {
    render(<Controlled />);
    expect(await screen.findByAltText('图片 1')).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: '提示词' }).querySelectorAll('.prompt-reference-chip'),
    ).toHaveLength(2);
    expect(screen.getByRole('textbox').querySelectorAll('p')).toHaveLength(2);
    expect(screen.getByTestId('value')).toHaveTextContent('图 1 是人物 音频1 是声音');
  });
  it('pastes plain text, canonicalizes references and preserves single newlines', async () => {
    render(<Controlled />);
    await screen.findByAltText('图片 1');
    await replacePromptText(screen.getByRole('textbox'), '新段落\n图1 和音频 1\n结尾');
    await waitFor(() =>
      expect(screen.getByTestId('value').textContent).toBe('新段落\n图 1 和音频1\n结尾'),
    );
    expect(screen.getByRole('textbox').querySelectorAll('.prompt-reference-chip')).toHaveLength(2);
  });
  it('inserts at the caret and supports undo without storing UI labels or markup', async () => {
    render(<Controlled initial="镜头跟拍" />);
    const field = screen.getByRole('textbox');
    await waitFor(() => expect(field).toHaveTextContent('镜头跟拍'));
    const editor = getNearestEditorFromDOMNode(field)!;
    await act(async () => {
      editor.update(() => $getRoot().selectEnd(), { discrete: true });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: '插入素材' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: '选择要引用的素材' })).getByRole('button', {
        name: '音频 1',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('镜头跟拍音频1 '));
    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('镜头跟拍'));
  });
  it('deleting a chip edits only the text and keeps the input available for insertion', async () => {
    render(<Controlled />);
    await screen.findByAltText('图片 1');
    await replacePromptText(screen.getByRole('textbox'), '只保留正文');
    expect(screen.getByRole('textbox').querySelector('.prompt-reference-chip')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '插入素材' }));
    expect(within(screen.getByRole('group')).getByAltText('图片 1')).toBeInTheDocument();
  });
  it('uses external text and input changes without publishing a synthetic user edit', async () => {
    const changed = vi.fn();
    const view = render(
      <PromptReferenceEditor
        label="提示词"
        value="图 1是人物"
        references={references}
        onChange={changed}
      />,
    );
    await screen.findByAltText('图片 1');
    view.rerender(
      <PromptReferenceEditor
        label="提示词"
        value="人物已离开"
        references={references.slice(1)}
        onChange={changed}
      />,
    );
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveTextContent('人物已离开'));
    expect(screen.getByRole('textbox').querySelector('.prompt-reference-chip')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });
  it('respects a read-only form', () => {
    render(
      <PromptReferenceEditor
        label="提示词"
        value="图 1"
        references={references}
        onChange={vi.fn()}
        readOnly
      />,
    );
    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'false');
    expect(screen.queryByRole('button', { name: '插入素材' })).not.toBeInTheDocument();
  });
});
