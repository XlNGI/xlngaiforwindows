import { useEffect, useRef, useState, type CSSProperties } from 'react';

export function DocumentDirectoryTitleText({ text }: { text: string }) {
  const titleRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [overflowDistance, setOverflowDistance] = useState(0);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    const title = titleRef.current;
    const track = trackRef.current;
    if (!title || !track) return;

    const measureOverflow = () => {
      const overflow = Math.ceil(Math.max(0, track.scrollWidth - title.clientWidth));
      setOverflowDistance(overflow > 1 ? overflow : 0);
    };

    measureOverflow();

    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measureOverflow);
    observer?.observe(title);
    observer?.observe(track);
    window.addEventListener('resize', measureOverflow);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureOverflow);
    };
  }, [text]);

  const animationStyle =
    overflowDistance > 0
      ? ({
          '--directory-title-distance': `${overflowDistance}px`,
          '--directory-title-duration': `${Math.max(2, (overflowDistance * 2) / 50 + 1.3)}s`,
        } as CSSProperties)
      : undefined;

  return (
    <span
      ref={titleRef}
      className={`document-directory-title-text${overflowDistance > 0 ? ' is-overflowing' : ''}${isHovered && overflowDistance > 0 ? ' is-marquee-active' : ''}`}
      style={animationStyle}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span ref={trackRef} className="document-directory-title-track">
        {text}
      </span>
    </span>
  );
}
