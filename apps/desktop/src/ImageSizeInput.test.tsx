import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageSizeInput } from './ImageSizeInput';

afterEach(cleanup);

function Form({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="size">尺寸</label>
      <ImageSizeInput id="size" label="尺寸" value={value} onChange={setValue} />
      <output aria-label="提交尺寸">{value}</output>
    </>
  );
}

describe('ImageSizeInput', () => {
  it('offers common sizes without adding a default and submits raw compatible values', () => {
    render(<Form />);
    const select = screen.getByRole('combobox', { name: '尺寸' });
    expect(select).toHaveValue('');
    expect(screen.getByLabelText('提交尺寸')).toBeEmptyDOMElement();
    fireEvent.change(select, { target: { value: '1792x1008' } });
    expect(screen.getByLabelText('提交尺寸')).toHaveTextContent('1792x1008');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'auto' } });
    expect(screen.getByLabelText('提交尺寸')).toHaveTextContent('auto');
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.getByLabelText('提交尺寸')).toBeEmptyDOMElement();
  });

  it('lets users edit a preset freely and switch back to a common size', () => {
    render(<Form initial="1024x1024" />);
    const select = screen.getByRole('combobox', { name: '尺寸' });
    fireEvent.change(select, { target: { value: 'custom' } });
    const input = screen.getByRole('textbox', { name: '自定义尺寸' });
    expect(input).toHaveValue('1024x1024');
    fireEvent.change(input, { target: { value: '1234x987' } });
    expect(screen.getByLabelText('提交尺寸')).toHaveTextContent('1234x987');
    fireEvent.change(select, { target: { value: '1536x864' } });
    expect(screen.getByLabelText('提交尺寸')).toHaveTextContent('1536x864');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('preserves a loaded custom dimension instead of replacing it with a preset', () => {
    render(<Form initial="1920x1080" />);
    expect(screen.getByRole('combobox', { name: '尺寸' })).toHaveValue('custom');
    expect(screen.getByRole('textbox', { name: '自定义尺寸' })).toHaveValue('1920x1080');
    expect(screen.getByLabelText('提交尺寸')).toHaveTextContent('1920x1080');
  });
});
