import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownEditor } from './MarkdownEditor';

afterEach(() => {
  cleanup();
});

describe('MarkdownEditor', () => {
  it('switches between editing and a GFM preview without changing the document', () => {
    const onChange = vi.fn();
    const content = '# 标题\n\n- 第一项\n- 第二项\n\n| 名称 | 数量 |\n| --- | ---: |\n| 镜头 | 2 |';
    render(<MarkdownEditor label="文档内容" value={content} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(screen.getByRole('heading', { name: '标题' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.getByRole('textbox', { name: '文档内容' })).toHaveValue(content);
    fireEvent.change(screen.getByRole('textbox', { name: '文档内容' }), {
      target: { value: '# 修改后的标题' },
    });
    expect(onChange).toHaveBeenCalledWith('# 修改后的标题');
  });

  it('does not render embedded HTML in preview mode', () => {
    const { container } = render(
      <MarkdownEditor
        label="提示词"
        value={'<img src="x" onerror="alert(1)" />\n\n[外部链接](https://example.com)'}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '外部链接' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: '外部链接' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
  });

  it('starts in preview and returns to preview when focus leaves the editor', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MarkdownEditor label="文档内容" value="# 初稿" onChange={onChange} autoPreviewOnBlur />,
    );

    expect(screen.getByRole('heading', { name: '初稿' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '文档内容' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('region', { name: '文档内容预览' }));
    const editor = screen.getByRole('textbox', { name: '文档内容' });
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: '# 已修改' } });
    expect(onChange).toHaveBeenCalledWith('# 已修改');

    rerender(
      <MarkdownEditor label="文档内容" value="# 已修改" onChange={onChange} autoPreviewOnBlur />,
    );
    fireEvent.blur(screen.getByRole('textbox', { name: '文档内容' }));
    expect(screen.getByRole('heading', { name: '已修改' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '文档内容' })).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('returns a prompt-reference editor to preview when focus leaves it', () => {
    render(
      <MarkdownEditor
        label="镜头提示词"
        value="角色和声音"
        onChange={vi.fn()}
        autoPreviewOnBlur
        references={[
          {
            id: 'audio:voice',
            kind: 'audio',
            url: 'https://example.com/voice.wav',
            text: '音频1',
            label: '音频 1',
            aliases: ['音频1'],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('region', { name: '镜头提示词预览' }));
    const editor = screen.getByRole('textbox', { name: '镜头提示词' });
    expect(editor).toHaveFocus();
    fireEvent.blur(editor);

    expect(screen.getByRole('region', { name: '镜头提示词预览' })).toHaveTextContent('角色和声音');
    expect(screen.queryByRole('textbox', { name: '镜头提示词' })).not.toBeInTheDocument();
  });
});
