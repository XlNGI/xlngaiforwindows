import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useReducer, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultWorkspaceLayout, workspaceReducer } from './workspace-reducer';
import { WorkspaceSurface } from './WorkspaceSurface';

interface WorkspaceFixtureProps {
  productionOpen?: boolean;
  documentActive?: boolean;
  editorTitle?: string;
  detachedPanels?: Partial<Record<'document' | 'conversation', string>>;
  children?: ReactNode;
  onDetachDocument?: () => void;
  onDetachConversation?: () => void;
}

function WorkspaceFixture({
  productionOpen = false,
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
      <WorkspaceSurface
        layout={layout}
        dispatch={dispatch}
        documentTitle="文档"
        conversationContent={<div>会话内容</div>}
        productionContent={<div>生产内容</div>}
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

  it('adds and removes the production split without leaving an empty panel', () => {
    const { container, rerender } = render(<WorkspaceFixture productionOpen />);

    expect(container.querySelector('.workspace-production-page')).toBeInTheDocument();
    expect(container.querySelectorAll('.workspace-dock-separator')).toHaveLength(2);

    rerender(<WorkspaceFixture productionOpen={false} />);

    expect(container.querySelector('.workspace-production-page')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.workspace-dock-separator')).toHaveLength(1);
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

    expect(container.querySelector('.workspace-editor-page')).toBeInTheDocument();
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
