import { useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, Image, Video } from 'lucide-react';
import type { GenerationCapability } from '@ai-video/contracts';

interface ProductionNavigationProps {
  capability: GenerationCapability;
  onCapabilityChange: (capability: GenerationCapability) => void;
  compact?: boolean;
}

const groups: Array<{
  id: 'image' | 'video';
  label: string;
  icon: typeof Image;
  items: Array<{ capability: GenerationCapability; label: string }>;
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
      { capability: 'START_END_TO_VIDEO', label: '首尾帧生视频' },
    ],
  },
];

export function ProductionNavigation({
  capability,
  onCapabilityChange,
  compact = false,
}: ProductionNavigationProps) {
  const [expanded, setExpanded] = useState<Record<'image' | 'video', boolean>>({
    image: true,
    video: true,
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
    <nav
      className={compact ? 'production-navigation compact' : 'production-navigation'}
      aria-label="内容生产"
      data-production-navigation
    >
      {!compact && <div className="navigation-group-title">内容生产</div>}
      {groups.map((group) => {
        const Icon = group.icon;
        const open = expanded[group.id];
        return (
          <div className="production-navigation-group" key={group.id}>
            <button
              className="production-menu-heading"
              type="button"
              aria-expanded={open}
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
                    key={item.capability}
                    onClick={() => onCapabilityChange(item.capability)}
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
