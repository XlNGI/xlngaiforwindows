import type { ProductionInputImage } from '@ai-video/contracts';

/** Reflect the current request, so changing a role never leaves stale first-frame claims. */
export function ProductionInputRoleDetails({ images }: { images: ProductionInputImage[] }) {
  if (!images.length) return null;
  const hasFirstFrame = images.some((image) => image.role === 'first-frame');
  return (
    <section aria-label="当前视频图片用途">
      <ul>
        {images.map((image, index) => (
          <li key={index}>
            图片 {index + 1}：
            {image.role === 'first-frame'
              ? '首帧输入'
              : image.role === 'last-frame'
                ? '尾帧输入'
                : '普通参考输入'}
          </li>
        ))}
      </ul>
      <p>
        {hasFirstFrame
          ? '当前指定首帧用途。生成后仍需核对实际开头的光照、灯具和构图。'
          : '当前图片作为参考，未指定首帧用途；开场构图和光照可能被重新生成。'}
      </p>
    </section>
  );
}
