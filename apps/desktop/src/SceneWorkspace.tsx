import { Save, Video } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssetInfo,
  DocumentSummary,
  SceneInfo,
  SceneMaterialBindingInfo,
  SceneMaterialRole,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { AssetImagePreview } from './AssetImagePreview';
import { DubbingScenePanel } from './dubbing/DubbingScenePanel';

const REFERENCE_PATTERN = /\[(角色|场景|道具|人物|地点|物件):([^\]]+)\]/gu;

function normalizeRole(value: string): SceneMaterialRole {
  if (value === '角色' || value === '人物') return 'character';
  if (value === '场景' || value === '地点') return 'scene';
  if (value === '道具' || value === '物件') return 'prop';
  return 'other';
}

function bindingKey(role: SceneMaterialRole, label: string): string {
  return `${role}:${label.trim()}`;
}

function isImage(asset: AssetInfo): boolean {
  return !asset.deletedAt && !asset.kind.toLowerCase().includes('video');
}

export function SceneWorkspace({
  projectId,
  scene,
  prompt,
  bindings,
  documents,
  assets,
  writable,
  onPromptChange,
  onSave,
  onGenerateVideo,
  onOpenAsset,
}: {
  projectId?: string;
  scene: SceneInfo;
  prompt: string;
  bindings: SceneMaterialBindingInfo[];
  documents: DocumentSummary[];
  assets: AssetInfo[];
  writable: boolean;
  onPromptChange: (value: string) => void;
  onSave: (prompt: string, bindings: SceneMaterialBindingInfo[]) => void;
  onGenerateVideo: (bindings: SceneMaterialBindingInfo[]) => void;
  onOpenAsset?: (assetId: string) => void;
}) {
  const [localBindings, setLocalBindings] = useState(bindings);
  const [message, setMessage] = useState('');
  const autoBoundScene = useRef<string | undefined>(undefined);

  useEffect(() => setLocalBindings(bindings), [bindings]);

  const candidatesByRole = useMemo(() => {
    const map: Record<SceneMaterialRole, AssetInfo[]> = {
      character: [],
      scene: [],
      prop: [],
      other: [],
    };
    for (const asset of assets.filter(isImage)) {
      const kind = asset.kind.toLowerCase();
      const role = kind.includes('character')
        ? 'character'
        : kind.includes('scene')
          ? 'scene'
          : kind.includes('prop')
            ? 'prop'
            : 'other';
      map[role].push(asset);
    }
    return map;
  }, [assets]);

  const autoBind = async () => {
    setMessage('正在识别场次素材…');
    try {
      const next = new Map<string, SceneMaterialBindingInfo>();
      const mentions = [...prompt.matchAll(REFERENCE_PATTERN)];
      if (scene.sceneDocumentId) {
        const bound = documents.find((document) => document.id === scene.sceneDocumentId);
        if (bound) {
          const sourceAssets = await callWorker('asset.list', {
            sourceDocumentId: bound.id,
            sort: 'created-desc',
            limit: 1,
          });
          const asset = sourceAssets.find(isImage);
          if (asset)
            next.set(bindingKey('scene', bound.title), {
              id: bindingKey('scene', bound.title),
              role: 'scene',
              label: bound.title,
              assetId: asset.id,
              sourceDocumentId: bound.id,
              source: 'auto',
            });
        }
      }
      for (const match of mentions) {
        const role = normalizeRole(match[1] ?? '');
        const label = (match[2] ?? '').trim();
        if (!label || next.has(bindingKey(role, label))) continue;
        const document = documents.find(
          (item) =>
            item.title.includes(label) &&
            (item.kind === role || role === 'prop' || role === 'other'),
        );
        if (!document) continue;
        const sourceAssets = await callWorker('asset.list', {
          sourceDocumentId: document.id,
          sort: 'created-desc',
          limit: 1,
        });
        const asset = sourceAssets.find(isImage);
        if (asset)
          next.set(bindingKey(role, label), {
            id: bindingKey(role, label),
            role,
            label,
            assetId: asset.id,
            sourceDocumentId: document.id,
            source: 'auto',
          });
      }
      const merged = [...next.values(), ...localBindings.filter((item) => !next.has(item.id))];
      setLocalBindings(merged);
      setMessage(
        merged.length
          ? `已识别 ${merged.length} 个素材，可继续手动调整。`
          : '没有找到可用的参考图片。',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '素材识别失败。');
    }
  };

  useEffect(() => {
    const sceneKey = `${scene.id}:${scene.sceneDocumentId ?? ''}`;
    if (!prompt.trim() || autoBoundScene.current === sceneKey) return;
    autoBoundScene.current = sceneKey;
    void autoBind();
  }, [scene.id, scene.sceneDocumentId, prompt]);

  const setAsset = (binding: SceneMaterialBindingInfo, assetId: string) => {
    setLocalBindings((current) =>
      current.map((item) =>
        item.id === binding.id ? { ...item, assetId, source: 'manual' } : item,
      ),
    );
  };
  const tooManyReferences = localBindings.length > 7;

  return (
    <div className="scene-workspace">
      <section className="scene-prompt-panel">
        <div className="scene-prompt-heading">
          <div>
            <span className="eyebrow">场次 · {scene.title}</span>
            <h1>完整视频提示词</h1>
          </div>
          <div className="toolbar-actions">
            <button
              className="button secondary"
              type="button"
              disabled={!writable}
              onClick={() => void autoBind()}
            >
              自动识别素材
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={!writable}
              onClick={() => onSave(prompt, localBindings)}
            >
              <Save size={14} /> 保存提示词
            </button>
            <button
              className="button primary"
              type="button"
              disabled={!writable || !prompt.trim() || tooManyReferences}
              onClick={() => onGenerateVideo(localBindings)}
            >
              <Video size={14} /> 生成场次视频
            </button>
          </div>
        </div>
        <textarea
          className="markdown-editor scene-video-prompt-editor"
          aria-label="场次完整视频提示词"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          readOnly={!writable}
          placeholder="输入这一场完整的视频提示词…"
        />
        {message ? <div className="inline-status">{message}</div> : null}
        {tooManyReferences ? (
          <div className="inline-status">参考图片超过当前模型支持的 7 张，请先减少绑定。</div>
        ) : null}
      </section>
      <section className="scene-material-panel" aria-label="场次参考素材">
        <div className="scene-prompt-heading">
          <div>
            <h2>场次参考素材</h2>
            <p>提示词中的角色、场景和道具会自动匹配参考图，也可以手动替换。</p>
          </div>
          <button className="text-button" type="button" onClick={() => void autoBind()}>
            重新识别
          </button>
        </div>
        {localBindings.length === 0 ? (
          <p className="tree-empty">暂无绑定素材</p>
        ) : (
          <div className="scene-material-grid">
            {localBindings.map((binding) => {
              const candidates =
                candidatesByRole[binding.role].length > 0
                  ? candidatesByRole[binding.role]
                  : assets.filter(isImage);
              const asset = assets.find((item) => item.id === binding.assetId);
              return (
                <article className="scene-material-card" key={binding.id}>
                  <strong>{binding.label}</strong>
                  <span>
                    {binding.role === 'character'
                      ? '角色'
                      : binding.role === 'scene'
                        ? '场景'
                        : binding.role === 'prop'
                          ? '道具'
                          : '素材'}
                  </span>
                  {asset ? (
                    <AssetImagePreview asset={asset} />
                  ) : (
                    <div className="scene-material-missing">未选择图片</div>
                  )}
                  <select
                    aria-label={`${binding.label}参考图`}
                    value={binding.assetId}
                    disabled={!writable}
                    onChange={(event) => setAsset(binding, event.target.value)}
                  >
                    {candidates.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.alias || item.relativePath.split(/[\\/]/).pop() || item.id}
                      </option>
                    ))}
                  </select>
                </article>
              );
            })}
          </div>
        )}
      </section>
      {projectId ? (
        <DubbingScenePanel
          projectId={projectId}
          sceneId={scene.id}
          documents={documents}
          writable={writable}
          onOpenAsset={onOpenAsset}
        />
      ) : null}
    </div>
  );
}
