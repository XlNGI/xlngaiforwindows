import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import brandLogo from '../brand-logo.png';
import { ProviderEditor } from './ProviderEditor';
import type { ProviderDefinitionInfo, ProviderProfileInfo } from '@ai-video/contracts';

afterEach(cleanup);
it('hides the text protocol when adding a custom provider and exposes it when editing', () => {
  const profile: ProviderProfileInfo = {
    id: 'relay-profile',
    name: 'Relay',
    category: 'multi',
    providerType: 'custom',
    accessType: 'custom',
    protocol: 'openai-responses',
    baseUrl: 'https://relay.example/v1',
    enabled: true,
    connectionStatus: 'ready',
    createdAt: '',
    updatedAt: '',
  };
  const props = {
    definitions: [],
    credentialConfigured: true,
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
  };
  const view = render(<ProviderEditor {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /自定义供应商/ }));
  expect(screen.queryByLabelText('文本接口协议')).not.toBeInTheDocument();

  view.rerender(<ProviderEditor {...props} profile={profile} />);
  expect(screen.getByLabelText('文本接口协议')).toHaveValue('openai-responses');
  expect(screen.getByText('仅影响文本模型请求；图片和视频按各自的接口适配。')).toBeInTheDocument();
});

it('requires the Wan workspace ID and preserves its official endpoint when editing', async () => {
  const wan: ProviderDefinitionInfo = {
    id: 'wan-video',
    name: '万相视频',
    category: 'multi',
    providerType: 'wan-video',
    accessType: 'official',
    protocol: 'dashscope-video',
    baseUrl: 'https://dashscope.aliyuncs.com',
  };
  const onSubmit = vi.fn().mockResolvedValue({ secretStored: true, completed: false });
  const props = { definitions: [wan], credentialConfigured: true, onCancel: vi.fn(), onSubmit };
  const view = render(<ProviderEditor {...props} />);
  expect(screen.getByRole('button', { name: '保存并测试' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('百炼业务空间 ID（北京地域）'), {
    target: { value: 'workspace-123' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存并测试' }));
  const baseUrl = 'https://workspace-123.cn-beijing.maas.aliyuncs.com';
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ providerType: 'wan-video', baseUrl }),
      '',
    ),
  );
  view.rerender(
    <ProviderEditor
      {...props}
      profile={{
        ...wan,
        baseUrl,
        id: 'profile-id',
        enabled: true,
        connectionStatus: 'ready',
        createdAt: '',
        updatedAt: '',
      }}
    />,
  );
  expect(screen.getByLabelText('百炼业务空间 ID（北京地域）')).toHaveValue('workspace-123');
  expect(screen.getByLabelText('Base URL')).toHaveValue(baseUrl);
});

it('renders a local brand icon for every built-in official provider', () => {
  const entries = [
    ['wan-video', '万相视频（百炼官方）', 'wan-video', 'multi', 'dashscope-video'],
    [
      'seedance-video',
      'Seedance 视频（火山方舟官方）',
      'seedance-video',
      'multi',
      'seedance-video',
    ],
    ['minimax-video', 'MiniMax 视频（官方）', 'minimax-video', 'multi', 'minimax-video-v2'],
    ['minimax-speech', 'MiniMax 配音', 'minimax-speech', 'multi', 'minimax-speech'],
    ['sync', 'Sync 口型同步', 'sync', 'multi', 'sync-lipsync'],
    ['openai', 'OpenAI', 'openai', 'llm', 'openai-responses'],
    ['deepseek', 'DeepSeek', 'deepseek', 'llm', 'openai-chat-completions'],
    ['zhipu', '智谱 AI', 'zhipu', 'llm', 'openai-chat-completions'],
    ['qwen', '阿里云百炼', 'qwen', 'multi', 'openai-chat-completions'],
    ['kimi', 'Kimi（月之暗面）', 'kimi', 'llm', 'openai-chat-completions'],
    ['unicompapi', 'UniCompAPI', 'unicompapi', 'multi', 'openai-chat-completions'],
    ['vidu-global', 'Vidu 国际站', 'vidu', 'multi', 'vidu-v2'],
    ['vidu-china', 'Vidu 中国站', 'vidu', 'multi', 'vidu-v2'],
  ] as const;
  const definitions: ProviderDefinitionInfo[] = entries.map(
    ([id, name, providerType, category, protocol]) => ({
      id,
      name,
      providerType,
      category,
      protocol,
      baseUrl: `https://api.example.com/${id}`,
      accessType: 'official',
    }),
  );
  const { container } = render(
    <ProviderEditor
      definitions={definitions}
      credentialConfigured
      onCancel={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );

  const logos = Array.from(
    container.querySelectorAll<HTMLImageElement>('.official-provider-grid .provider-brand-mark'),
  );
  const cards = Array.from(
    container.querySelectorAll<HTMLButtonElement>('.official-provider-grid button'),
  );
  expect(logos).toHaveLength(definitions.length);
  expect(cards[0]?.querySelector('strong')).toHaveTextContent('UniCompAPI');
  expect(cards[0]).toHaveClass('selected', 'recommended');
  expect(cards[0]?.querySelector('.provider-recommendation-tag')).toHaveTextContent('推荐');
  expect(container.querySelectorAll('.official-provider-grid small')).toHaveLength(0);
  expect(
    logos.every((logo) => {
      const src = logo.getAttribute('src') ?? '';
      return src.length > 0 && !/^https?:\/\//i.test(src);
    }),
  ).toBe(true);

  const iconFor = (name: RegExp) =>
    screen.getByRole('button', { name }).querySelector('img')?.getAttribute('src');
  expect(iconFor(/MiniMax 视频/)).toBe(iconFor(/MiniMax 配音/));
  expect(iconFor(/万相视频/)).toBe(iconFor(/阿里云百炼/));
  expect(iconFor(/UniCompAPI/)).toBe(brandLogo);
  expect(iconFor(/Vidu 国际站/)).toBe(iconFor(/Vidu 中国站/));
});
