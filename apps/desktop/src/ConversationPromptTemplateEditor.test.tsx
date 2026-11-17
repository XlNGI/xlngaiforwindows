import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationPromptTemplateEditor } from './ConversationPromptTemplateEditor';
import { readPromptTemplateFile } from './prompt-template-import';
import type { ConversationInfo, PromptTemplateKind } from '@ai-video/contracts';

afterEach(cleanup);
const conversation = { id: 'c', title: '模板测试' } as ConversationInfo;
function Editor() {
  const [kind, setKind] = useState<PromptTemplateKind>('character-image');
  const [drafts, setDrafts] = useState<Record<string, string>>({
    'character-image': '原角色草稿',
    'scene-image': '原场景草稿',
  });
  return (
    <ConversationPromptTemplateEditor
      conversation={conversation}
      writable
      scopeAvailable
      kind={kind}
      onKindChange={setKind}
      value={drafts[kind] ?? ''}
      onChange={(value) => setDrafts((current) => ({ ...current, [kind]: value }))}
      busy={false}
      loading={false}
      dirty
      error=""
    />
  );
}
const open = () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole('button', { name: '本会话要求约束' }));
};
it('offers only dedicated templates and lets a purpose remain empty', () => {
  open();
  expect(screen.getAllByRole('option')).toHaveLength(5);
  expect(screen.queryByRole('option', { name: '通用会话要求' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  fireEvent.click(screen.getByRole('button', { name: '清空当前用途' }));
  expect(screen.getByRole('textbox')).toHaveValue('');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'scene-image' } });
  expect(screen.getByRole('textbox')).toHaveValue('原场景草稿');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'character-image' } });
  expect(screen.getByRole('textbox')).toHaveValue('');
});
it('imports UTF-8 BOM text exactly, edits and reverts only the selected purpose', async () => {
  open();
  const text = '  角色模板\r\n哈哈110\n\n';
  expect(
    await readPromptTemplateFile({
      name: 'x.md',
      size: 100,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('\uFEFF' + text).buffer),
    }),
  ).toBe(text);
  const file = {
    name: '角色.md',
    size: 100,
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode('\uFEFF' + text).buffer),
  };
  fireEvent.change(screen.getByLabelText('导入当前用途模板文件'), { target: { files: [file] } });
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: '本会话要求约束' })).toHaveValue(
      text.replace(/\r\n/g, '\n'),
    ),
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '编辑后的设计模板' } });
  fireEvent.click(screen.getByRole('button', { name: '撤回本次导入' }));
  expect(screen.getByRole('textbox')).toHaveValue('原角色草稿');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'scene-image' } });
  expect(screen.getByRole('textbox')).toHaveValue('原场景草稿');
});
it('cannot import a delayed file into another purpose or over newer typing', async () => {
  open();
  let resolve!: (value: ArrayBuffer) => void;
  const file = {
    name: '角色.txt',
    size: 10,
    arrayBuffer: () =>
      new Promise<ArrayBuffer>((done) => {
        resolve = done;
      }),
  };
  fireEvent.change(screen.getByLabelText('导入当前用途模板文件'), { target: { files: [file] } });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'scene-image' } });
  await act(async () => {
    resolve(new TextEncoder().encode('延迟模板').buffer);
    await Promise.resolve();
  });
  expect(screen.getByRole('textbox')).toHaveValue('原场景草稿');
  fireEvent.change(screen.getByLabelText('导入当前用途模板文件'), { target: { files: [file] } });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '较新的编辑' } });
  await act(async () => {
    resolve(new TextEncoder().encode('延迟模板').buffer);
    await Promise.resolve();
  });
  expect(screen.getByRole('textbox')).toHaveValue('较新的编辑');
});
it('rejects unsupported or invalid text without changing the draft', async () => {
  await expect(
    readPromptTemplateFile({ name: 'a.docx', size: 1, arrayBuffer: vi.fn() }),
  ).rejects.toThrow('TXT');
  await expect(
    readPromptTemplateFile({
      name: 'a.txt',
      size: 1,
      arrayBuffer: () => Promise.resolve(new Uint8Array([0xff]).buffer),
    }),
  ).rejects.toThrow('UTF-8');
  expect(
    await readPromptTemplateFile({
      name: 'empty.md',
      size: 0,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    }),
  ).toBe('');
});
