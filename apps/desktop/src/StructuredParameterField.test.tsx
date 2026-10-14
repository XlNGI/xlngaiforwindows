import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { officialVideoAudioContracts, type AdapterParameterValue } from '@ai-video/contracts';
import { StructuredParameterField } from './StructuredParameterField';

function Fixture() {
  const [value, setValue] = useState<AdapterParameterValue>();
  const contract = officialVideoAudioContracts.find(
    (item) => item.contractId === 'cn.qwen.wan3-0-video',
  )!;
  const properties = contract.parameterSchema.properties as Record<string, Record<string, unknown>>;
  return (
    <>
      <StructuredParameterField
        schema={properties.media!}
        value={value}
        onChange={setValue}
        label="媒体"
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

describe('official structured parameter form', () => {
  afterEach(cleanup);
  it('edits a reference audio object without turning it into a string', () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: '添加媒体' }));
    fireEvent.change(screen.getByRole('combobox', { name: '媒体 1类型' }), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByLabelText('媒体地址'), {
      target: { value: 'https://example.com/voice.wav' },
    });
    expect(JSON.parse(screen.getByTestId('value').textContent ?? 'null')).toEqual([
      { type: 'reference_audio', url: 'https://example.com/voice.wav' },
    ]);
  });

  it('clears fields from the old media variant when switching types', () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: '添加媒体' }));
    fireEvent.change(screen.getByLabelText('媒体地址'), {
      target: { value: 'https://example.com/frame.png' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '媒体 1类型' }), {
      target: { value: '4' },
    });
    expect(JSON.parse(screen.getByTestId('value').textContent ?? 'null')).toEqual([
      { type: 'reference_audio' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: '删除媒体 1' }));
    expect(JSON.parse(screen.getByTestId('value').textContent ?? 'null')).toEqual([]);
  });
});
