import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderModelCapabilities } from '@ai-video/contracts';
import { CapabilityEditor } from './ModelManagementView';
afterEach(cleanup);
const capabilities: ProviderModelCapabilities = {
  text: true,
  streaming: true,
  tools: true,
  vision: false,
  reasoning: false,
  structuredOutput: false,
  embeddings: false,
  imageGeneration: false,
  videoGeneration: false,
  imageEditing: false,
};
it('saves separate manual input/output limits, rejects invalid limits and resets on model change', () => {
  const onChange = vi.fn<(value: ProviderModelCapabilities) => void>();
  const view = render(<CapabilityEditor capabilities={capabilities} onChange={onChange} />);
  for (const [label, value] of [
    ['上下文窗口 Token', '1000000'],
    ['最大输入 Token', '900000'],
    ['最大输出 Token', '32768'],
    ['Tokenizer', 'o200k_base'],
  ])
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  fireEvent.click(screen.getByText('保存上下文能力'));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      contextLimits: {
        contextWindow: 1000000,
        maxInputTokens: 900000,
        maxOutputTokens: 32768,
        tokenizer: 'o200k_base',
        capabilitySource: 'manual_config',
      },
    }),
  );
  fireEvent.change(screen.getByLabelText('最大输入 Token'), { target: { value: '1000001' } });
  fireEvent.click(screen.getByText('保存上下文能力'));
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(onChange).toHaveBeenCalledTimes(1);
  view.rerender(
    <CapabilityEditor
      capabilities={{
        ...capabilities,
        contextLimits: { contextWindow: 128000, capabilitySource: 'manual_config' },
      }}
      onChange={onChange}
    />,
  );
  expect(screen.getByLabelText('上下文窗口 Token')).toHaveProperty('value', '128000');
  fireEvent.click(screen.getByText('恢复自动能力'));
  expect(onChange.mock.calls.at(-1)?.[0].contextLimits).toBeUndefined();
});
