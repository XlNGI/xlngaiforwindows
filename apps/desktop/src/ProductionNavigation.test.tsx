import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductionNavigation } from './ProductionNavigation';

describe('ProductionNavigation', () => {
  afterEach(cleanup);

  it('renders image and video as first-level menus with all six production capabilities', () => {
    const onCapabilityChange = vi.fn();
    render(
      <ProductionNavigation capability="TEXT_TO_IMAGE" onCapabilityChange={onCapabilityChange} />,
    );

    expect(screen.getByRole('button', { name: '图片制作' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: '视频制作' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    for (const label of [
      '文生图',
      '参考生图',
      '文生视频',
      '图生视频',
      '参考生视频',
      '首尾帧生视频',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('button', { name: '首尾帧生视频' }));
    expect(onCapabilityChange).toHaveBeenCalledWith('START_END_TO_VIDEO');
  });

  it('supports collapse state and keyboard focus movement', () => {
    render(
      <ProductionNavigation capability="TEXT_TO_IMAGE" onCapabilityChange={() => undefined} />,
    );
    const imageHeading = screen.getByRole('button', { name: '图片制作' });
    fireEvent.click(imageHeading);
    expect(imageHeading).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '文生图' })).not.toBeInTheDocument();

    const videoHeading = screen.getByRole('button', { name: '视频制作' });
    videoHeading.focus();
    fireEvent.keyDown(videoHeading, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: '文生视频' })).toHaveFocus();
  });
});
