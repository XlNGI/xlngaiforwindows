import { AssetImagePreview } from './AssetImagePreview';
import { ImagePreview } from './ImagePreview';

export function imageAssetId(value: string): string | undefined {
  const prefix = ['project-asset://', 'asset://'].find((prefix) => value.startsWith(prefix));
  return prefix && value.length > prefix.length ? value.slice(prefix.length) : undefined;
}

export function ParameterImagePreview({
  value,
  label,
  projectId,
}: {
  value: string;
  label: string;
  projectId?: string;
}) {
  const assetId = imageAssetId(value);
  return assetId ? (
    <AssetImagePreview assetId={assetId} projectId={projectId} alt={label} />
  ) : (
    <ImagePreview src={value} alt={label} />
  );
}
