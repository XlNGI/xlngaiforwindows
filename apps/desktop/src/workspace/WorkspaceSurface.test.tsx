import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useReducer, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultWorkspaceLayout, workspaceReducer } from './workspace-reducer';
import { WorkspaceSurface } from './WorkspaceSurface';

interface WorkspaceFixtureProps {
  productionOpen?: boolean;
  productionContent?: ReactNode;
  documentActive?: boolean;
  editorTitle?: string;
  detachedPanels?: Partial<Record<'document' | 'conversation', string>>;
  children?: ReactNode;
  onDetachDocument?: () => void;
  onDetachConversation?: () => void;
}

function WorkspaceFixture({
  productionOpen = false,
  productionContent = <div>生产内容</div>,
  documentActive = true,
  editorTitle,
  detachedPanels = {},
  children = <div>文档内容</div>,
  onDetachDocument = () => undefined,
  onDetachConversation = () => undefined,
}: WorkspaceFixtureProps) {
  const [layout, dispatch] = useReducer(
    workspaceReducer,
    createDefaultWorkspaceLayout('project', { width: 1200, height: 800 }),
  );
  return (
    <>
      <button type="button" onClick={() => dispatch({ type: 'open', panelId: 'conversation' })}>
        测试打开会话
      </button>
      <button type="button" onClick={() => dispatch({ type: 'float', panelId: 'document' })}>
        测试浮动文档
      </button>
      <button type="button" onClick={() => dispatch({ type: 'open', panelId: 'assets' })}>
        测试打开素材库
      </button>
      <button type="button" onClick={() => dispatch({ type: 'open', panelId: 'document' })}>
        测试打开资料
      </button>
      <WorkspaceSurface
        layout={layout}
        dispatch={dispatch}
        documentTitle="文档"
        conversationContent={<div>会话内容</div>}
        productionContent={productionContent}
        assetsContent={<input aria-label="素材搜索" defaultValue="" />}
        productionOpen={productionOpen}
        documentActive={documentActive}
        editorTitle={editorTitle}
        onOpenConversation={() => undefined}
        onOpenDocument={() => undefined}
        onCloseDocument={() => dispatch({ type: 'close', panelId: 'document' })}
        onDetachDocument={onDetachDocument}
        onDetachConversation={onDetachConversation}
        detachedPanels={detachedPanels}
      >
        {children}
      </WorkspaceSurface>
    </>
  );
}

describe('WorkspaceSurface', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    window.localStorage?.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  });

  it('opens the document in a system window from its pane header', () => {
    const onDetachDocument = vi.fn();
    render(<WorkspaceFixture onDetachDocument={onDetachDocument} />);

    fireEvent.click(screen.getByLabelText('文档在独立窗口打开'));

    expect(onDetachDocument).toHaveBeenCalledOnce();
  });

  it('closes document and conversation panels from their pane headers', () => {
    const { container } = render(<WorkspaceFixture />);

    fireEvent.click(within(container).getByLabelText('关闭文档面板'));
    expect(container.querySelector('.workspace-editor-page')).not.toBeInTheDocument();

    fireEvent.click(within(container).getByLabelText('关闭会话面板'));
    expect(container.querySelector('.workspace-conversation-page')).not.toBeInTheDocument();
  });

  it('closes a non-document project page from the pane header', () => {
    const { container } = render(
      <WorkspaceFixture documentActive={false} editorTitle="场次与镜头">
        <div>镜头工作区</div>
      </WorkspaceFixture>,
    );

    expect(container.querySelector('.workspace-base-content')).toHaveTextContent('镜头工作区');
    fireEvent.click(within(container).getByLabelText('关闭场次与镜头'));
    expect(container.querySelector('.workspace-editor-page')).not.toBeInTheDocument();
  });

  it('keeps a non-document page visible while the document is in a system window', () => {
    const { container } = render(
      <WorkspaceFixture
        documentActive={false}
        editorTitle="素材库"
        detachedPanels={{ document: 'document-window' }}
      >
        <div>素材库内容</div>
      </WorkspaceFixture>,
    );

    expect(container.querySelector('.workspace-editor-page')).toBeInTheDocument();
    expect(container.querySelector('.workspace-base-content')).toHaveTextContent('素材库内容');
    expect(within(container).queryByLabelText('文档在独立窗口打开')).not.toBeInTheDocument();
  });

  it('keeps a reopen placeholder when the document is the last docked page', () => {
    const { container } = render(<WorkspaceFixture />);

    fireEvent.click(within(container).getByLabelText('关闭会话面板'));
    fireEvent.click(within(container).getByLabelText('关闭文档面板'));

    expect(container.querySelector('.workspace-editor-page')).toBeInTheDocument();
    expect(container.querySelector('.workspace-closed-panel')).toBeInTheDocument();
    expect(container.querySelector('.workspace-base-content')).not.toBeInTheDocument();
    expect(within(container).getByRole('button', { name: '打开文档编辑器' })).toBeInTheDocument();
  });

  it('keeps a reopen placeholder when a non-document page is the last docked page', () => {
    const { container } = render(
      <WorkspaceFixture documentActive={false} editorTitle="小说章节" />,
    );

    fireEvent.click(within(container).getByLabelText('关闭会话面板'));
    fireEvent.click(within(container).getByLabelText('关闭小说章节'));

    expect(container.querySelector('.workspace-editor-page')).toBeInTheDocument();
    expect(container.querySelector('.workspace-closed-panel')).toBeInTheDocument();
    expect(within(container).getByRole('button', { name: '打开小说章节' })).toBeInTheDocument();
  });

  it('ignores a persisted 0% conversation layout and still opens a usable pane', () => {
    window.localStorage.setItem(
      'react-resizable-panels:ai-video.workspace-docks.v5:project:editor:conversation',
      JSON.stringify({ editor: 100, conversation: 0 }),
    );
    const { container } = render(<WorkspaceFixture />);

    expect(container.querySelector('.workspace-conversation-page')).toBeInTheDocument();
  });

  it('reopens the conversation after it has been closed', () => {
    const { container } = render(<WorkspaceFixture />);

    fireEvent.click(within(container).getByLabelText('关闭会话面板'));
    expect(container.querySelector('.workspace-conversation-page')).not.toBeInTheDocument();
    expect(container.querySelector('#conversation')).not.toBeInTheDocument();

    fireEvent.click(within(container).getByRole('button', { name: '测试打开会话' }));
    expect(container.querySelector('.workspace-conversation-page')).toBeInTheDocument();
    expect(container.querySelector('#conversation')).toBeInTheDocument();
  });

  it('does not persist a 0% conversation layout when the pane is closed', () => {
    const { container } = render(<WorkspaceFixture />);
    fireEvent.click(within(container).getByLabelText('关闭会话面板'));

    const persisted = Object.keys(window.localStorage)
      .filter((key) => key.includes('workspace-docks.v5'))
      .map((key) => window.localStorage.getItem(key));
    expect(persisted.some((value) => value?.includes('"conversation":0'))).toBe(false);
    expect(container.querySelector('#conversation')).not.toBeInTheDocument();
  });

  it('renders shared separators between adjacent docked pages', () => {
    const { container } = render(<WorkspaceFixture />);

    expect(container.querySelectorAll('.workspace-docked-page')).toHaveLength(2);
    expect(container.querySelectorAll('.workspace-dock-separator')).toHaveLength(1);
  });

  it('opens assets beside the editor and conversation without losing unsaved content', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
    const { container } = render(
      <WorkspaceFixture>
        <input aria-label="项目正文" defaultValue="已保存内容" />
      </WorkspaceFixture>,
    );
    fireEvent.change(screen.getByLabelText('项目正文'), { target: { value: '未保存修改' } });
    fireEvent.click(screen.getByText('测试打开素材库'));

    expect(screen.getByLabelText('项目正文')).toHaveValue('未保存修改');
    expect(container.querySelector('.workspace-assets-page')).toBeInTheDocument();
    expect(container.querySelectorAll('.workspace-docked-page')).toHaveLength(3);
    expect(container.querySelectorAll('.workspace-dock-separator')).toHaveLength(2);

    fireEvent.click(screen.getByLabelText('关闭素材库'));
    expect(container.querySelector('.workspace-assets-page')).not.toBeInTheDocument();
    expect(screen.getByLabelText('项目正文')).toHaveValue('未保存修改');
    fireEvent.click(screen.getByText('测试打开素材库'));
    fireEvent.click(screen.getByLabelText('关闭文档面板'));
    expect(container.querySelector('.workspace-assets-page')).toBeInTheDocument();
    expect(container.querySelector('.workspace-editor-page')).not.toBeInTheDocument();
  });

  it('preserves asset input when the neighboring project page changes', () => {
    const { rerender } = render(<WorkspaceFixture />);
    fireEvent.click(screen.getByText('测试打开素材库'));
    fireEvent.change(screen.getByLabelText('素材搜索'), { target: { value: '角色图片' } });

    rerender(
      <WorkspaceFixture documentActive={false} editorTitle="场次与镜头">
        <div>镜头工作区</div>
      </WorkspaceFixture>,
    );

    expect(screen.getByText('镜头工作区')).toBeInTheDocument();
    expect(screen.getByLabelText('素材搜索')).toHaveValue('角色图片');
  });

  it('keeps project, production and assets docked in a compact workspace', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    const { container } = render(<WorkspaceFixture productionOpen />);
    fireEvent.click(screen.getByText('测试打开素材库'));

    expect(container.querySelector('.workspace-editor-page')).toBeInTheDocument();
    expect(container.querySelector('.workspace-production-page')).toBeInTheDocument();
    expect(container.querySelector('.workspace-assets-page')).toBeInTheDocument();
    expect(container.querySelector('.workspace-conversation-page')).not.toBeInTheDocument();
  });

  it('floats assets on a narrow screen and makes them reachable again after closing', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    const { container } = render(<WorkspaceFixture productionOpen />);
    fireEvent.click(screen.getByText('测试打开素材库'));

    expect(container.querySelector('.floating-window-assets')).toBeInTheDocument();
    expect(screen.getByText('生产内容')).toBeInTheDocument();
    fireEvent.click(
      within(container.querySelector('.floating-window-assets')!).getByLabelText('关闭浮窗'),
    );
    expect(container.querySelector('.floating-window-assets')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('测试打开素材库'));
    expect(container.querySelector('.floating-window-assets')).toBeInTheDocument();
  });

  it('floats assets at the workspace edge and can dock them beside the editor again', () => {
    const { container } = render(<WorkspaceFixture />);
    fireEvent.click(screen.getByText('测试打开素材库'));
    const assetsTab = container.querySelector('[data-pane-id="assets"]')!;
    fireEvent.pointerDown(assetsTab, { button: 0, pointerId: 5, clientX: 450, clientY: 15 });
    fireEvent.pointerMove(assetsTab, { pointerId: 5, clientX: 5, clientY: 15 });
    fireEvent.pointerUp(assetsTab, { pointerId: 5, clientX: 5, clientY: 15 });

    expect(container.querySelector('.floating-window-assets')).toBeInTheDocument();
    expect(screen.getByText('文档内容')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('停靠面板'));
    expect(container.querySelector('.workspace-assets-page')).toBeInTheDocument();
    expect(container.querySelector('.floating-window-assets')).not.toBeInTheDocument();
  });

  it('returns to a project page after the active asset pane is closed on a narrow screen', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    const { container } = render(
      <WorkspaceFixture documentActive={false} editorTitle="小说">
        <div>小说章节</div>
      </WorkspaceFixture>,
    );
    fireEvent.click(screen.getByText('测试打开资料'));
    expect(screen.getByText('小说章节')).toBeInTheDocument();
    fireEvent.click(screen.getByText('测试打开素材库'));
    fireEvent.click(
      within(container.querySelector('.floating-window-assets')!).getByLabelText('关闭浮窗'),
    );

    expect(container.querySelector('.floating-window-assets')).not.toBeInTheDocument();
    expect(screen.getByText('小说章节')).toBeInTheDocument();
  });

  it('keeps unsaved project input and asset search while switching narrow-screen tabs', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(
      <WorkspaceFixture documentActive={false} editorTitle="小说">
        <input aria-label="小说正文" defaultValue="原始内容" />
      </WorkspaceFixture>,
    );
    const tabs = screen.getByRole('navigation', { name: '工作区页面' });
    fireEvent.click(within(tabs).getByRole('button', { name: '小说' }));
    fireEvent.change(screen.getByLabelText('小说正文'), { target: { value: '未保存小说修改' } });
    fireEvent.click(within(tabs).getByRole('button', { name: '素材库' }));
    expect(screen.getByLabelText('小说正文')).not.toBeVisible();
    fireEvent.change(screen.getByLabelText('素材搜索'), { target: { value: '雨夜街景' } });
    fireEvent.click(within(tabs).getByRole('button', { name: '小说' }));

    expect(screen.getByLabelText('小说正文')).toHaveValue('未保存小说修改');
    expect(screen.getByLabelText('小说正文')).toBeVisible();
    fireEvent.click(within(tabs).getByRole('button', { name: '素材库' }));
    expect(screen.getByLabelText('素材搜索')).toHaveValue('雨夜街景');
    expect(screen.getByLabelText('素材搜索')).toBeVisible();
  });

  it('switches between project and production pages without mixing their content', () => {
    const { container, rerender } = render(<WorkspaceFixture productionOpen />);

    expect(container.querySelector('.workspace-production-page')).toBeInTheDocument();
    expect(container.querySelector('.workspace-editor-page')).toBeVisible();
    expect(container.querySelectorAll('.workspace-dock-separator')).toHaveLength(2);

    rerender(<WorkspaceFixture productionOpen={false} />);

    expect(container.querySelector('.workspace-production-page')).not.toBeInTheDocument();
    expect(container.querySelector('.workspace-editor-page')).toBeVisible();
    expect(container.querySelectorAll('.workspace-dock-separator')).toHaveLength(1);
  });

  it.each([1440, 1100, 800])(
    'keeps the novel page beside production when the workspace supports split panes at %i px',
    (width) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      const children = <input aria-label="章节内容" defaultValue="已保存的小说正文" />;
      const { rerender } = render(
        <WorkspaceFixture documentActive={false} editorTitle="小说">
          {children}
        </WorkspaceFixture>,
      );
      if (width >= 1000) {
        fireEvent.change(screen.getByLabelText('章节内容'), {
          target: { value: '未保存的小说修改' },
        });
      }

      rerender(
        <WorkspaceFixture productionOpen documentActive={false} editorTitle="小说">
          {children}
        </WorkspaceFixture>,
      );
      if (width >= 1000) {
        expect(screen.getByLabelText('章节内容')).toBeVisible();
      } else {
        expect(screen.getByLabelText('章节内容')).not.toBeVisible();
      }
      expect(screen.getByText('生产内容')).toBeVisible();

      rerender(
        <WorkspaceFixture documentActive={false} editorTitle="小说">
          {children}
        </WorkspaceFixture>,
      );
      if (width >= 1000) {
        expect(screen.getByLabelText('章节内容')).toBeVisible();
        expect(screen.getByLabelText('章节内容')).toHaveValue('未保存的小说修改');
      }
    },
  );

  it('hides a floating project editor while production is active', () => {
    const { container, rerender } = render(<WorkspaceFixture />);
    fireEvent.click(screen.getByRole('button', { name: '测试浮动文档' }));
    expect(container.querySelector('.floating-window-document')).toBeInTheDocument();

    rerender(<WorkspaceFixture productionOpen />);
    expect(container.querySelector('.floating-window-document')).not.toBeInTheDocument();
    expect(screen.queryByText('文档内容')).not.toBeInTheDocument();

    rerender(<WorkspaceFixture />);
    expect(container.querySelector('.floating-window-document')).toBeInTheDocument();
  });

  it('lets docked neighbors fill the split when the document is detached', () => {
    const { container } = render(
      <WorkspaceFixture detachedPanels={{ document: 'document-window' }} />,
    );

    expect(container.querySelector('.workspace-editor-page')).not.toBeInTheDocument();
    expect(container.querySelector('.workspace-conversation-page')).toBeInTheDocument();
    expect(container.querySelectorAll('.workspace-dock-separator')).toHaveLength(0);
  });

  it('auto-hides the docked conversation beside production in a compact workspace', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    const { container } = render(<WorkspaceFixture productionOpen />);

    expect(container.querySelector('.workspace-editor-page')).toBeVisible();
    expect(container.querySelector('.workspace-production-page')).toBeInTheDocument();
    expect(container.querySelector('.workspace-conversation-page')).not.toBeInTheDocument();
    expect(container.querySelector('.floating-window-conversation')).not.toBeInTheDocument();
  });

  it('shows production first in single-page mode and opens conversation on demand', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    const { container } = render(<WorkspaceFixture productionOpen />);

    expect(container.querySelector('.workspace-production-page')).toBeInTheDocument();
    expect(container.querySelector('.floating-window-conversation')).not.toBeInTheDocument();
  });

  it('collapses and reopens the production pane from its header', () => {
    const { container } = render(
      <WorkspaceFixture
        productionOpen
        productionContent={<input aria-label="制作提示词" defaultValue="原始提示词" />}
      />,
    );
    const productionPage = container.querySelector('.workspace-production-page')!;
    const prompt = screen.getByLabelText('制作提示词');
    fireEvent.change(prompt, { target: { value: '未保存的制作提示词' } });

    fireEvent.click(screen.getByRole('button', { name: '收起生产参数' }));
    expect(productionPage).toHaveClass('is-collapsed');
    expect(screen.getByRole('button', { name: '展开生产参数' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开生产参数' }));
    expect(productionPage).not.toHaveClass('is-collapsed');
    expect(screen.getByLabelText('制作提示词')).toBe(prompt);
    expect(prompt).toHaveValue('未保存的制作提示词');
  });

  it('reorders pages by dragging a page tab', async () => {
    const { container } = render(<WorkspaceFixture />);
    const surface = container.querySelector('.workspace-surface')!;
    const editorTab = container.querySelector('[data-pane-id="editor"]')!;
    const conversationTab = container.querySelector('[data-pane-id="conversation"]')!;
    vi.spyOn(editorTab, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 30,
      width: 100,
      height: 30,
      toJSON: () => ({}),
    });
    vi.spyOn(conversationTab, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 0,
      top: 0,
      left: 100,
      right: 200,
      bottom: 30,
      width: 100,
      height: 30,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(conversationTab, { button: 0, pointerId: 1, clientX: 150, clientY: 15 });
    fireEvent.pointerMove(conversationTab, {
      pointerId: 1,
      clientX: 30,
      clientY: 15,
      screenX: 30,
      screenY: 15,
    });
    fireEvent.pointerUp(conversationTab, { pointerId: 1, clientX: 30, clientY: 15 });

    await waitFor(() =>
      expect(surface.querySelector('[data-pane-id]')?.getAttribute('data-pane-id')).toBe(
        'conversation',
      ),
    );
  });

  it('arms a system-window detach when a document tab reaches the workspace edge', async () => {
    const onDetachDocument = vi.fn();
    const { container } = render(<WorkspaceFixture onDetachDocument={onDetachDocument} />);
    const surface = container.querySelector('.workspace-surface')!;
    const editorTab = container.querySelector('[data-pane-id="editor"]')!;

    fireEvent.pointerDown(editorTab, { button: 0, pointerId: 2, clientX: 80, clientY: 15 });
    fireEvent.pointerMove(editorTab, {
      pointerId: 2,
      clientX: 5,
      clientY: 15,
      screenX: 5,
      screenY: 15,
    });
    await waitFor(() => expect(surface).toHaveClass('is-detach-armed'));
    fireEvent.pointerUp(editorTab, { pointerId: 2, clientX: 5, clientY: 15 });

    expect(onDetachDocument).toHaveBeenCalledOnce();
  });

  it('cancels a tab drag without changing the persisted order', () => {
    const { container } = render(<WorkspaceFixture />);
    const surface = container.querySelector('.workspace-surface')!;
    const conversationTab = container.querySelector('[data-pane-id="conversation"]')!;

    fireEvent.pointerDown(conversationTab, { button: 0, pointerId: 3, clientX: 150, clientY: 15 });
    fireEvent.pointerMove(conversationTab, { pointerId: 3, clientX: 30, clientY: 15 });
    expect(surface).toHaveClass('is-dragging');

    fireEvent.pointerCancel(conversationTab, { pointerId: 3, clientX: 30, clientY: 15 });

    expect(surface).not.toHaveClass('is-dragging');
    expect(surface.querySelector('[data-pane-id]')?.getAttribute('data-pane-id')).toBe('editor');
  });

  it('does not detach the production page when it reaches an edge', () => {
    const onDetachDocument = vi.fn();
    const onDetachConversation = vi.fn();
    const { container } = render(
      <WorkspaceFixture
        productionOpen
        onDetachDocument={onDetachDocument}
        onDetachConversation={onDetachConversation}
      />,
    );
    const surface = container.querySelector('.workspace-surface')!;
    const productionTab = container.querySelector('[data-pane-id="production"]')!;

    fireEvent.pointerDown(productionTab, { button: 0, pointerId: 4, clientX: 150, clientY: 15 });
    fireEvent.pointerMove(productionTab, { pointerId: 4, clientX: 5, clientY: 15 });
    fireEvent.pointerUp(productionTab, { pointerId: 4, clientX: 5, clientY: 15 });

    expect(surface).not.toHaveClass('is-detach-armed');
    expect(onDetachDocument).not.toHaveBeenCalled();
    expect(onDetachConversation).not.toHaveBeenCalled();
  });
});
