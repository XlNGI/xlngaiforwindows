import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ImagePreview } from './ImagePreview';

afterEach(cleanup);

describe('ImagePreview', () => {
  it('opens the same full image in a modal, traps focus and returns it on Escape', () => {
    render(<ImagePreview src="/worker-media/image-1" alt="庭院全景" />);
    const trigger = screen.getByRole('button', { name: '放大查看庭院全景' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '图片预览：庭院全景' });
    expect(within(dialog).getByRole('img')).toHaveAttribute('src', '/worker-media/image-1');
    const close = within(dialog).getByRole('button', { name: '关闭图片预览' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes with the close button or backdrop and removes the modal when the image changes', () => {
    const view = render(<ImagePreview src="/worker-media/image-1" alt="庭院" />);
    const trigger = screen.getByRole('button', { name: '放大查看庭院' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '关闭图片预览' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    view.rerender(<ImagePreview src="/worker-media/image-2" alt="书房" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', '/worker-media/image-2');
  });
});
