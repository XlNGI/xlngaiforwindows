import { useEffect, useRef, useState } from 'react';
import type { ProductionDefaults, ProductionDefaultsInfo } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';

const styleFields = [
  ['medium', '画面类型'],
  ['technique', '表现方式'],
  ['realism', '写实程度'],
  ['proportions', '人物比例'],
  ['linework', '线条'],
  ['materials', '材质'],
  ['palette', '色彩'],
  ['contrast', '明暗对比'],
  ['texture', '画面质感'],
  ['referenceDescription', '参考风格说明'],
] as const;

export function ProjectProductionDefaults({
  writable,
  onSaved,
}: {
  writable: boolean;
  onSaved: () => void;
}) {
  const callWorker = projectWorker();
  const [opened, setOpened] = useState(false);
  const [value, setValue] = useState<ProductionDefaultsInfo>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!opened || value) return;
    let active = true;
    void callWorker('production.defaults.get', {})
      .then((next) => {
        if (active) setValue(next ?? { rowVersion: 0, settings: {} });
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : '项目风格读取失败。');
      });
    return () => {
      active = false;
    };
  }, [opened, refresh]);
  const update = (settings: ProductionDefaults) =>
    setValue((current) => (current ? { ...current, settings } : current));
  const save = async () => {
    if (!value || busy || !writable) return;
    setBusy(true);
    setMessage('');
    try {
      const next = await callWorker('production.defaults.save', {
        expectedRowVersion: value.rowVersion,
        settings: value.settings,
      });
      if (!alive.current) return;
      setValue(next);
      setMessage('项目风格与输出默认值已保存。');
      onSaved();
    } catch (error) {
      if (alive.current) setMessage(error instanceof Error ? error.message : '项目风格保存失败。');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <details onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>项目统一视觉风格与输出默认值</summary>
      <p>角色、场景、场次和分镜默认沿用，具体制作要求可覆盖。时长由剧情推导。</p>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => {
          setValue(undefined);
          setMessage('');
          setRefresh((value) => value + 1);
        }}
      >
        重新读取项目风格
      </button>
      {value && (
        <fieldset disabled={!writable || busy}>
          {styleFields.map(([key, label]) => (
            <label className="parameter-field" key={key}>
              {label}
              <input
                value={value.settings.style?.[key] ?? ''}
                onChange={(event) => {
                  const style = { ...value.settings.style };
                  if (event.target.value.trim()) style[key] = event.target.value;
                  else delete style[key];
                  update({ ...value.settings, style });
                }}
              />
            </label>
          ))}
          <label className="parameter-field">
            视频默认画幅
            <select
              value={value.settings.generation?.ratio ?? ''}
              onChange={(event) => {
                const generation = { ...value.settings.generation };
                if (event.target.value) generation.ratio = event.target.value;
                else delete generation.ratio;
                update({ ...value.settings, generation });
              }}
            >
              <option value="">沿用模型默认值</option>
              {['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'].map((ratio) => (
                <option key={ratio}>{ratio}</option>
              ))}
            </select>
          </label>
          <label className="parameter-field">
            视频默认分辨率
            <input
              value={value.settings.generation?.resolution ?? ''}
              placeholder="例如 1080p"
              onChange={(event) => {
                const generation = { ...value.settings.generation };
                if (event.target.value.trim()) generation.resolution = event.target.value;
                else delete generation.resolution;
                update({ ...value.settings, generation });
              }}
            />
          </label>
          <button type="button" className="button secondary" onClick={() => void save()}>
            保存项目风格
          </button>
        </fieldset>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
