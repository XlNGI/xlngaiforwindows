import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptWorkspace } from './ScriptWorkspace';

afterEach(() => {
  cleanup();
});

describe('ScriptWorkspace', () => {
  it('opens in preview and returns to preview when editing ends', () => {
    const onContentChange = vi.fn();
    render(
      <ScriptWorkspace
        content="# 场景和对白"
        writable
        versions={[]}
        onContentChange={onContentChange}
        onRestoreVersion={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: '场景和对白' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '文档内容' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑正文' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '归档' })).not.toBeInTheDocument();
    expect(screen.queryByText('预览', { exact: true })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('region', { name: '文档内容预览' }));
    const editor = screen.getByRole('textbox', { name: '文档内容' });
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: '# 新的场景' } });
    expect(onContentChange).toHaveBeenCalledWith('# 新的场景');
    fireEvent.blur(editor);
    expect(screen.getByRole('heading', { name: '场景和对白' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '文档内容' })).not.toBeInTheDocument();
  });

  it('omits duplicate document metadata while retaining episode scope context', () => {
    render(
      <ScriptWorkspace
        content={'\u7b2c\u4e09\u5377\u7b2c 12-13 \u7ae0'}
        writable
        versions={[]}
        episodeChapterCount={2}
        onContentChange={vi.fn()}
        onRestoreVersion={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('heading', { name: '\u9879\u76ee\u6587\u6863' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/\u76f4\u63a5\u751f\u6210\u53ef\u7f16\u8f91\u8d44\u6599/),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/\u5df2\u6307\u5b9a 2 \u4e2a\u7ae0\u8282/)).toBeInTheDocument();
    expect(screen.queryByLabelText('\u6587\u6863\u7c7b\u578b')).not.toBeInTheDocument();
  });
});
