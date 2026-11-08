import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentDirectoryTitleText } from './DocumentDirectoryTitle';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DocumentDirectoryTitleText', () => {
  function mockTitleMetrics(readWidth: () => number) {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('document-directory-title-text')) return readWidth();
      if (this.classList.contains('document-directory-title-track'))
        return Math.min(readWidth(), 220);
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('document-directory-title-track') ? 220 : 0;
    });
  }

  it('marks overflowing titles and keeps the full title in one row', async () => {
    mockTitleMetrics(() => 100);

    render(<DocumentDirectoryTitleText text="非常长的文档标题" />);
    const title = screen.getByText('非常长的文档标题').parentElement;

    await waitFor(() => expect(title).toHaveClass('is-overflowing'));
    expect(title).toHaveStyle({
      '--directory-title-distance': '120px',
      '--directory-title-duration': '6.1s',
    });
    expect(title).toHaveTextContent('非常长的文档标题');
  });

  it('leaves titles that fit their row static', async () => {
    mockTitleMetrics(() => 240);

    render(<DocumentDirectoryTitleText text="短标题" />);
    const title = screen.getByText('短标题').parentElement;

    await waitFor(() => expect(title).not.toHaveClass('is-overflowing'));
    fireEvent.mouseEnter(title!);
    expect(title).not.toHaveClass('is-marquee-active');
  });

  it('runs a continuous hover animation and clears it when the pointer leaves', async () => {
    mockTitleMetrics(() => 100);

    render(<DocumentDirectoryTitleText text="非常长的文档标题" />);
    const title = screen.getByText('非常长的文档标题').parentElement;

    await waitFor(() => expect(title).toHaveClass('is-overflowing'));
    fireEvent.mouseEnter(title!);
    expect(title).toHaveClass('is-marquee-active');
    fireEvent.mouseLeave(title!);
    expect(title).not.toHaveClass('is-marquee-active');
  });

  it('removes the animation when a directory row grows wide enough for the title', async () => {
    let width = 100;
    mockTitleMetrics(() => width);

    render(<DocumentDirectoryTitleText text="非常长的文档标题" />);
    const title = screen.getByText('非常长的文档标题').parentElement;

    await waitFor(() => expect(title).toHaveClass('is-overflowing'));
    fireEvent.mouseEnter(title!);
    expect(title).toHaveClass('is-marquee-active');

    width = 240;
    fireEvent(window, new Event('resize'));
    await waitFor(() => expect(title).not.toHaveClass('is-overflowing'));
    expect(title).not.toHaveClass('is-marquee-active');
  });
});
