import { useState, type KeyboardEvent } from 'react';
import { AudioLines, ChevronDown, ChevronRight, Image, Video } from 'lucide-react';
import type { ProductionCapability } from './use-production-state';

interface ProductionNavigationProps {
  capability: ProductionCapability;
  disabled?: boolean;
  onCapabilityChange: (capability: ProductionCapability) => void;
}

const groups: Array<{
  id: 'image' | 'video' | 'audio';
  label: string;
  icon: typeof Image;
  items: Array<{ capability: ProductionCapability; label: string }>;
}> = [
  {
    id: 'image',
    label: '图片制作',
    icon: Image,
    items: [
      { capability: 'TEXT_TO_IMAGE', label: '文生图' },
      { capability: 'REFERENCE_TO_IMAGE', label: '参考生图' },
    ],
  },
  {
    id: 'video',
    label: '视频制作',
    icon: Video,
    items: [
      { capability: 'TEXT_TO_VIDEO', label: '文生视频' },
      { capability: 'IMAGE_TO_VIDEO', label: '图生视频' },
      { capability: 'REFERENCE_TO_VIDEO', label: '参考生视频' },
      { capability: 'VIDEO_TO_VIDEO', label: '视频编辑' },
      { capability: 'START_END_TO_VIDEO', label: '首尾帧生视频' },
    ],
  },
  {
    id: 'audio',
    label: '音频制作',
    icon: AudioLines,
    items: [{ capability: 'TEXT_TO_AUDIO', label: '音频生成' }],
  },
];

/** Each capability belongs to exactly one production group. */
function groupOf(capability: ProductionCapability): 'image' | 'video' | 'audio' {
  if (capability === 'TEXT_TO_AUDIO') return 'audio';
  return capability.endsWith('_TO_IMAGE') ? 'image' : 'video';
}

export function ProductionNavigation({
  capability,
  disabled = false,
  onCapabilityChange,
}: ProductionNavigationProps) {
  /*
   * Both groups used to open at once, which put all six capabilities in the rail
   * at all times. Only the active group opens now, so the rail shows the current
   * production mode plus its siblings and collapses the unrelated group.
   */
  const [expanded, setExpanded] = useState<Record<'image' | 'video' | 'audio', boolean>>(() => {
    const active = groupOf(capability);
    return { image: active === 'image', video: active === 'video', audio: active === 'audio' };
  });

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, direction: number) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const navigation = event.currentTarget.closest<HTMLElement>('[data-production-navigation]');
    const items = navigation
      ? Array.from(navigation.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      : [];
    const current = items.indexOf(event.currentTarget);
    if (current < 0 || items.length === 0) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + direction + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <nav className="production-navigation" aria-label="内容生产" data-production-navigation>
      <div className="navigation-group-title">内容生产</div>
      {groups.map((group) => {
        const Icon = group.icon;
        const open = expanded[group.id];
        return (
          <div className="production-navigation-group" key={group.id}>
            <button
              className="production-menu-heading"
              type="button"
              aria-expanded={open}
              disabled={disabled}
              onClick={() => setExpanded((current) => ({ ...current, [group.id]: !open }))}
              onKeyDown={(event) => moveFocus(event, event.key === 'ArrowUp' ? -1 : 1)}
            >
              <Icon size={16} />
              <span>{group.label}</span>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {open && (
              <div className="production-menu-items">
                {group.items.map((item) => (
                  <button
                    className={item.capability === capability ? 'active' : ''}
                    type="button"
                    aria-current={item.capability === capability ? 'page' : undefined}
                    disabled={disabled}
                    key={item.capability}
                    onClick={() => {
                      setExpanded({
                        image: group.id === 'image',
                        video: group.id === 'video',
                        audio: group.id === 'audio',
                      });
                      onCapabilityChange(item.capability);
                    }}
                    onKeyDown={(event) => moveFocus(event, event.key === 'ArrowUp' ? -1 : 1)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
