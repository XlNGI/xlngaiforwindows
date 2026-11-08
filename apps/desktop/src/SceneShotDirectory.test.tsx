import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneInfo, ShotInfo } from '@ai-video/contracts';
import { SceneShotDirectory } from './SceneShotDirectory';
import { callWorker } from './worker-client';
import { useState } from 'react';
import { selectWorkerScope } from './worker-scope';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  selectWorkerScope(undefined);
});
const scene: SceneInfo = {
  id: 'a',
  projectId: 'project',
  title: '第一场',
  position: 0,
  rowVersion: 0,
  createdAt: 'now',
  updatedAt: 'now',
};
const next = { ...scene, id: 'b', title: '第二场', position: 1 };
const shot: ShotInfo = {
  id: 'a1',
  sceneId: scene.id,
  title: '第一场近景',
  position: 0,
  status: 'draft',
  rowVersion: 0,
  createdAt: 'now',
  updatedAt: 'now',
};
const nextShot = { ...shot, id: 'b1', sceneId: next.id, title: '第二场远景' };
function InteractiveDirectory({ initialShotId }: { initialShotId?: string }) {
  const [sceneId, setSceneId] = useState(scene.id);
  const [shotId, setShotId] = useState(initialShotId);
  return (
    <SceneShotDirectory
      projectId="project"
      scenes={[scene, next]}
      sceneId={sceneId}
      shotId={shotId}
      shots={sceneId === scene.id ? [shot] : [nextShot]}
      writable
      onAddScene={vi.fn()}
      onSelectScene={(selected) => {
        setSceneId(selected.id);
        setShotId(undefined);
      }}
      onSelectShot={(selected, item) => {
        setSceneId(selected.id);
        setShotId(item.id);
      }}
    />
  );
}

describe('scene and shot directory', () => {
  it('archives a selected parent once, warns about unsaved child edits, and hides its children', async () => {
    const changed = vi.fn().mockResolvedValue(undefined);
    vi.mocked(callWorker).mockResolvedValue({ ...scene, archivedAt: 'now', rowVersion: 1 });
    render(
      <SceneShotDirectory
        projectId="project"
        scenes={[scene, next]}
        sceneId={scene.id}
        shots={[shot]}
        writable
        onAddScene={vi.fn()}
        onSelectScene={vi.fn()}
        onSelectShot={vi.fn()}
        dirtyShotId={shot.id}
        onLifecycleChanged={changed}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: `选择镜头 ${shot.title}` }));
    fireEvent.click(screen.getByRole('checkbox', { name: `选择场次 ${scene.title}` }));
    fireEvent.click(screen.getByRole('button', { name: '归档所选' }));
    const dialog = screen.getByRole('dialog', { name: '归档所选草稿？' });
    expect(within(dialog).getByText(/未保存的更改将被放弃/)).toBeInTheDocument();
    expect(within(dialog).getByText(/同时隐藏其下镜头/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认归档' }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith([{ kind: 'scene', id: scene.id }]));
    expect(callWorker).toHaveBeenCalledTimes(1);
    expect(callWorker).toHaveBeenCalledWith('production.lifecycle.change', {
      target: { kind: 'scene', id: scene.id },
      expectedRowVersion: scene.rowVersion,
      archived: true,
    });
    expect(screen.queryByRole('button', { name: scene.title })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: `选择镜头 ${shot.title}` }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: next.title })).toBeInTheDocument();
  });

  it('deletes an individual shot recoverably and leaves a failed scene selected', async () => {
    const changed = vi.fn().mockResolvedValue(undefined);
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'shot.list') return Promise.resolve([]);
      if (
        method === 'production.lifecycle.change' &&
        (params as { target: { kind: string } }).target.kind === 'scene'
      )
        return Promise.reject(new Error('内容已变化'));
      return Promise.resolve({ ...shot, archivedAt: 'now' });
    });
    render(
      <SceneShotDirectory
        projectId="project"
        scenes={[scene, next]}
        sceneId={scene.id}
        shots={[shot]}
        writable
        onAddScene={vi.fn()}
        onSelectScene={vi.fn()}
        onSelectShot={vi.fn()}
        onLifecycleChanged={changed}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: `选择场次 ${next.title}` }));
    fireEvent.click(screen.getByRole('checkbox', { name: `选择镜头 ${shot.title}` }));
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }));
    await screen.findByText(/已删除 1 个草稿/);
    expect(changed).toHaveBeenCalledWith([{ kind: 'shot', id: shot.id }]);
    expect(screen.getByRole('checkbox', { name: `选择场次 ${next.title}` })).toBeChecked();
    expect(screen.queryByRole('button', { name: shot.title })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: scene.title })).toBeInTheDocument();
  });

  it('restores archived scenes and individually archived shots using current versions', async () => {
    const changed = vi.fn().mockResolvedValue(undefined);
    const archivedScene = { ...next, rowVersion: 5, archivedAt: 'now' };
    const archivedShot = { ...shot, rowVersion: 3, archivedAt: 'now' };
    let restored = false;
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'scene.list') return Promise.resolve([scene, archivedScene]);
      if (method === 'shot.list')
        return Promise.resolve(
          (params as { sceneId: string }).sceneId === scene.id
            ? restored
              ? []
              : [archivedShot]
            : [nextShot],
        );
      restored = true;
      return Promise.resolve({ ...archivedShot, archivedAt: undefined, rowVersion: 4 });
    });
    render(
      <SceneShotDirectory
        projectId="project"
        scenes={[scene]}
        shots={[]}
        writable
        onAddScene={vi.fn()}
        onSelectScene={vi.fn()}
        onSelectShot={vi.fn()}
        onLifecycleChanged={changed}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '已归档 / 已删除' }));
    fireEvent.click(await screen.findByRole('button', { name: `恢复镜头 ${shot.title}` }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith([]));
    expect(callWorker).toHaveBeenCalledWith('production.lifecycle.change', {
      target: { kind: 'shot', id: shot.id },
      expectedRowVersion: 3,
      archived: false,
    });
    expect(await screen.findByRole('button', { name: `恢复场次 ${next.title}` })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: `恢复镜头 ${nextShot.title}` }),
    ).not.toBeInTheDocument();
  });

  it('stops a pending batch after the project scope changes', async () => {
    selectWorkerScope({ projectId: 'project', projectSessionId: 'one' });
    let resolve!: (value: SceneInfo) => void;
    vi.mocked(callWorker).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const changed = vi.fn();
    render(
      <SceneShotDirectory
        projectId="project"
        scenes={[scene, next]}
        shots={[]}
        writable
        onAddScene={vi.fn()}
        onSelectScene={vi.fn()}
        onSelectShot={vi.fn()}
        onLifecycleChanged={changed}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }));
    selectWorkerScope({ projectId: 'other', projectSessionId: 'two' });
    await act(() => Promise.resolve(resolve({ ...scene, archivedAt: 'now' })));
    await waitFor(() => expect(callWorker).toHaveBeenCalledTimes(1));
    expect(changed).not.toHaveBeenCalled();
  });

  it('toggles scene titles repeatedly without reopening after selection', () => {
    render(<InteractiveDirectory />);
    const first = screen.getByRole('button', { name: scene.title });
    const second = screen.getByRole('button', { name: next.title });
    expect(first).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(shot.title)).not.toBeInTheDocument();
    fireEvent.click(first);
    expect(screen.getByRole('button', { name: shot.title })).toBeInTheDocument();
    fireEvent.click(second);
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: nextShot.title })).toBeInTheDocument();
    fireEvent.click(second);
    expect(second).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(nextShot.title)).not.toBeInTheDocument();
    fireEvent.click(second);
    expect(second).toHaveAttribute('aria-expanded', 'true');
  });

  it('can return from a shot to its parent and keep that scene collapsed', () => {
    render(<InteractiveDirectory initialShotId={shot.id} />);
    const title = screen.getByRole('button', { name: scene.title });
    fireEvent.click(title);
    expect(title).toHaveAttribute('aria-current', 'page');
    expect(title).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(shot.title)).not.toBeInTheDocument();
    fireEvent.click(title);
    expect(screen.getByRole('button', { name: shot.title })).toBeInTheDocument();
  });

  it('keeps an already expanded neighboring scene collapsed when its title is selected', async () => {
    vi.mocked(callWorker).mockResolvedValue([nextShot]);
    render(<InteractiveDirectory />);
    fireEvent.click(screen.getByRole('button', { name: '展开第二场' }));
    await screen.findByRole('button', { name: nextShot.title });
    const title = screen.getByRole('button', { name: next.title });
    fireEvent.click(title);
    expect(title).toHaveAttribute('aria-current', 'page');
    expect(title).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(nextShot.title)).not.toBeInTheDocument();
  });
  it('keeps each shot directly under its parent while multiple scenes are expanded', async () => {
    vi.mocked(callWorker).mockResolvedValue([nextShot]);
    const onSelectScene = vi.fn();
    const onSelectShot = vi.fn();
    render(
      <SceneShotDirectory
        projectId="project"
        scenes={[scene, next]}
        sceneId={scene.id}
        shotId={shot.id}
        shots={[shot]}
        writable
        onAddScene={vi.fn()}
        onSelectScene={onSelectScene}
        onSelectShot={onSelectShot}
      />,
    );
    expect(
      within(screen.getByLabelText('第一场的镜头')).getByRole('button', { name: shot.title }),
    ).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: '展开第二场' }));
    expect(
      await within(screen.getByLabelText('第二场的镜头')).findByRole('button', {
        name: nextShot.title,
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('第二场的镜头')).queryByText(shot.title),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: nextShot.title }));
    expect(onSelectShot).toHaveBeenCalledWith(next, nextShot);
    fireEvent.click(screen.getByRole('button', { name: scene.title }));
    expect(onSelectScene).toHaveBeenCalledWith(scene);
    expect(screen.queryByText(shot.title)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: scene.title }));
    fireEvent.click(screen.getByRole('button', { name: '收起第一场' }));
    expect(screen.queryByText(shot.title)).not.toBeInTheDocument();
    expect(screen.getByText(nextShot.title)).toBeInTheDocument();
    expect(screen.queryByLabelText('场次绑定场景')).not.toBeInTheDocument();
  });

  it('edits the selected scene title directly in the directory', async () => {
    const onRenameScene = vi.fn().mockResolvedValue(undefined);
    render(
      <SceneShotDirectory
        projectId="project"
        scenes={[scene]}
        sceneId={scene.id}
        shots={[shot]}
        writable
        onAddScene={vi.fn()}
        onSelectScene={vi.fn()}
        onSelectShot={vi.fn()}
        onRenameScene={onRenameScene}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: scene.title }));
    const input = screen.getByRole('textbox', { name: '场次标题' });
    fireEvent.change(input, { target: { value: '第一场（修改）' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onRenameScene).toHaveBeenCalledWith(scene, '第一场（修改）'));
  });

  it('edits the selected shot title directly in the directory', async () => {
    const onRenameShot = vi.fn().mockResolvedValue(undefined);
    render(
      <SceneShotDirectory
        projectId="project"
        scenes={[scene]}
        sceneId={scene.id}
        shotId={shot.id}
        shots={[shot]}
        writable
        onAddScene={vi.fn()}
        onSelectScene={vi.fn()}
        onSelectShot={vi.fn()}
        onRenameShot={onRenameShot}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: shot.title }));
    const input = screen.getByRole('textbox', { name: '镜头标题' });
    fireEvent.change(input, { target: { value: '第一场近景（修改）' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(onRenameShot).toHaveBeenCalledWith(scene, shot, '第一场近景（修改）'),
    );
  });
});
