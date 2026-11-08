import { useEffect, useState } from 'react';
import type { GenerationCapability } from '@ai-video/contracts';

export type ProductionCapability = GenerationCapability | 'TEXT_TO_AUDIO';

const PRODUCTION_CAPABILITY_STORAGE_KEY = 'ai-video.production-capability';
const productionCapabilities = new Set<ProductionCapability>([
  'TEXT_TO_IMAGE',
  'REFERENCE_TO_IMAGE',
  'TEXT_TO_VIDEO',
  'IMAGE_TO_VIDEO',
  'REFERENCE_TO_VIDEO',
  'START_END_TO_VIDEO',
  'VIDEO_TO_VIDEO',
  'TEXT_TO_AUDIO',
]);

function initialProductionCapability(): ProductionCapability {
  try {
    const stored = window.localStorage.getItem(PRODUCTION_CAPABILITY_STORAGE_KEY);
    if (stored && productionCapabilities.has(stored as ProductionCapability)) {
      return stored as ProductionCapability;
    }
  } catch {
    // The selection remains available for the current session when storage is unavailable.
  }
  return 'TEXT_TO_IMAGE';
}

export function useProductionState({
  setNavigationMode,
}: {
  setNavigationMode: (mode: 'project' | 'production') => void;
}) {
  const [productionCapability, setProductionCapability] = useState<ProductionCapability>(
    initialProductionCapability,
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(PRODUCTION_CAPABILITY_STORAGE_KEY, productionCapability);
    } catch {
      // Storage can be unavailable in restricted webviews.
    }
  }, [productionCapability]);

  const selectProductionCapability = (capability: ProductionCapability) => {
    setProductionCapability(capability);
    setNavigationMode('production');
  };

  return {
    productionCapability,
    setProductionCapability: selectProductionCapability,
  };
}
