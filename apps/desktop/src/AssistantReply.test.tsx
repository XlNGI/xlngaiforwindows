import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantReply } from './AssistantReply';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AssistantReply', () => {
  it('coalesces rapid updates every 40ms without postponing the timer', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<AssistantReply content="" streaming />);
    rerender(<AssistantReply content="first" streaming />);
    await act(() => vi.advanceTimersByTime(20));
    rerender(<AssistantReply content="latest" streaming />);
    expect(screen.queryByText('latest')).toBeNull();
    await act(() => vi.advanceTimersByTime(20));
    expect(screen.getByText('latest')).toBeTruthy();
    rerender(<AssistantReply content="complete" />);
    expect(screen.getByText('complete')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders Markdown and GFM while rejecting executable links and raw HTML', () => {
    const { container } = render(
      <AssistantReply
        content={
          '# Title\n\n**Bold**\n\n- Item\n\n```js\nconst n = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[unsafe](javascript:alert(1))\n\n<script>alert(1)</script>'
        }
      />,
    );
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    expect(container.querySelector('li')?.textContent).toBe('Item');
    expect(container.querySelector('pre code')?.textContent).toContain('const n = 1;');
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).not.toContain('javascript:');
  });
});
