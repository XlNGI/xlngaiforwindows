import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptWorkspace } from './ScriptWorkspace';

afterEach(() => {
  cleanup();
});

describe('ScriptWorkspace', () => {
  it('edits script documents without a generation action', () => {
    const onKindChange = vi.fn();
    render(
      <ScriptWorkspace
        title={'\u672c\u96c6\u6574\u4f53\u628a\u63a7'}
        kind="plan"
        content={'\u7b2c\u4e09\u5377\u7b2c 12-13 \u7ae0'}
        stateLabel={'\u8349\u7a3f'}
        stateKey="draft"
        writable
        versions={[]}
        episodeChapterCount={2}
        onTitleChange={vi.fn()}
        onKindChange={onKindChange}
        onContentChange={vi.fn()}
        onRestoreVersion={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: '\u9879\u76ee\u6587\u6863' })).toBeInTheDocument();
    expect(
      screen.getByText(/\u4e0d\u4f1a\u53d1\u7ed9\u751f\u56fe\u6216\u751f\u89c6\u9891/),
    ).toBeInTheDocument();
    expect(screen.getByText(/\u5df2\u6307\u5b9a 2 \u4e2a\u7ae0\u8282/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '\u751f\u6210\u89d2\u8272\u56fe' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('\u6587\u6863\u7c7b\u578b')).toHaveValue('plan');
    fireEvent.change(screen.getByLabelText('\u6587\u6863\u7c7b\u578b'), {
      target: { value: 'outline' },
    });
    expect(onKindChange).toHaveBeenCalledWith('outline');
  });
});
