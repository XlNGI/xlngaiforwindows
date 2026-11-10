import { useId, useState } from 'react';

// Shortcuts for free-form compatible APIs; these are not model capabilities.
const presets = [
  ['auto', '自动（auto）'],
  ['1024x1024', '1024 × 1024（1:1）'],
  ['1536x1024', '1536 × 1024（3:2）'],
  ['1024x1536', '1024 × 1536（2:3）'],
  ['1536x864', '1536 × 864（16:9）'],
  ['864x1536', '864 × 1536（9:16）'],
  ['1792x1008', '1792 × 1008（16:9）'],
  ['1008x1792', '1008 × 1792（9:16）'],
  ['1920x1088', '1920 × 1088（横向）'],
  ['1088x1920', '1088 × 1920（纵向）'],
  ['2048x2048', '2048 × 2048（1:1）'],
  ['3840x2160', '3840 × 2160（16:9）'],
  ['2160x3840', '2160 × 3840（9:16）'],
] as const;

export function ImageSizeInput({
  id,
  label,
  value,
  maxLength,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  maxLength?: number;
  onChange: (value: string) => void;
}) {
  const [editingCustom, setEditingCustom] = useState(false);
  const helpId = useId();
  const custom = editingCustom || (value !== '' && !presets.some(([size]) => size === value));
  return (
    <>
      <select
        id={id}
        value={custom ? 'custom' : value}
        aria-describedby={helpId}
        onChange={(event) => {
          const next = event.target.value;
          setEditingCustom(next === 'custom');
          if (next !== 'custom') onChange(next);
        }}
      >
        <option value="">不指定尺寸</option>
        {presets.map(([size, name]) => (
          <option key={size} value={size}>
            {name}
          </option>
        ))}
        <option value="custom">自定义尺寸…</option>
      </select>
      {custom && (
        <input
          aria-label={`自定义${label}`}
          aria-describedby={helpId}
          value={value}
          maxLength={maxLength}
          placeholder="输入宽x高，例如 1792x1008"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <small id={helpId}>常用尺寸可直接选择；实际支持范围以当前服务为准。</small>
    </>
  );
}
