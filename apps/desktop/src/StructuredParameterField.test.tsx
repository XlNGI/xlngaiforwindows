import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { officialVideoAudioContracts, type AdapterParameterValue } from '@ai-video/contracts';
import { StructuredParameterField } from './StructuredParameterField';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));

function Fixture({
  contractId = 'cn.qwen.wan3-0-video',
  initialValue,
}: {
  contractId?: string;
  initialValue?: AdapterParameterValue;
}) {
  const [value, setValue] = useState<AdapterParameterValue | undefined>(initialValue);
  const contract = officialVideoAudioContracts.find((item) => item.contractId === contractId)!;
  const properties = contract.parameterSchema.properties as Record<string, Record<string, unknown>>;
  return (
    <>
      <StructuredParameterField
        schema={(properties.media ?? properties.content)!}
        value={value}
        onChange={setValue}
        label="媒体"
        projectId="project"
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

describe('official structured parameter form', () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });
  it.each([
    'cn.qwen.wan3-0-video',
    'cn.qwen.wan2-7-i2v',
    'cn.bytedance.seedance2-0.video',
    'cn.minimax.h3.video',
  ])(
    'previews, reorders and replaces images without flattening %s parameters',
    async (contractId) => {
      vi.mocked(callWorker).mockResolvedValue({
        assetId: 'image',
        path: 'D:/image.png',
        contentType: 'image/png',
      });
      const nested = !contractId.includes('qwen');
      const image = (id: string): AdapterParameterValue =>
        nested
          ? {
              type: 'image_url',
              image_url: { url: `project-asset://${id}` },
              role: 'reference_image',
            }
          : { type: 'first_frame', url: `project-asset://${id}` };
      const first = image('first'),
        second = image('second');
      render(<Fixture contractId={contractId} initialValue={[first, second]} />);
      const preview = await screen.findByRole('button', { name: '放大查看媒体 1' });
      expect(within(preview).getByRole('img')).toHaveAttribute(
        'src',
        '/worker-media/first?thumbnail=1',
      );
      expect(screen.queryByDisplayValue(/project-asset:\/\//)).not.toBeInTheDocument();
      expect(callWorker).not.toHaveBeenCalledWith('asset.mediaSource', expect.anything());
      fireEvent.click(preview);
      expect(await within(screen.getByRole('dialog')).findByRole('img')).toHaveAttribute(
        'src',
        '/worker-media/first',
      );
      fireEvent.click(screen.getByRole('button', { name: '关闭图片预览' }));
      fireEvent.click(screen.getByRole('button', { name: '下移媒体 1' }));
      expect(JSON.parse(screen.getByTestId('value').textContent)).toEqual([second, first]);
      await waitFor(() =>
        expect(
          within(screen.getByRole('button', { name: '放大查看媒体 1' })).getByRole('img'),
        ).toHaveAttribute('src', '/worker-media/second?thumbnail=1'),
      );
      fireEvent.click(screen.getByRole('button', { name: '更换图片：媒体 1' }));
      fireEvent.change(screen.getByLabelText('媒体地址'), {
        target: { value: 'project-asset://replacement' },
      });
      fireEvent.click(screen.getByRole('button', { name: '完成图片输入：媒体 1' }));
      expect(JSON.parse(screen.getByTestId('value').textContent)).toEqual([
        image('replacement'),
        first,
      ]);
      fireEvent.click(screen.getByRole('button', { name: '删除媒体 1' }));
      expect(JSON.parse(screen.getByTestId('value').textContent)).toEqual([first]);
    },
  );

  it('renders structured text as an editable prompt alongside media', () => {
    render(
      <Fixture
        contractId="cn.bytedance.seedance2-0.video"
        initialValue={[{ type: 'text', text: '完整场次提示词' }]}
      />,
    );
    const input = screen.getByRole('textbox', { name: '内容' });
    expect(input.tagName).toBe('TEXTAREA');
    fireEvent.change(input, { target: { value: '修改后的提示词' } });
    expect(JSON.parse(screen.getByTestId('value').textContent)).toEqual([
      { type: 'text', text: '修改后的提示词' },
    ]);
  });
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
