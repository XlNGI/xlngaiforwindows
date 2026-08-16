import { useEffect, useState } from 'react';
import type { GenerationCapability } from '@ai-video/contracts';

const PRODUCTION_CAPABILITY_STORAGE_KEY = 'ai-video.production-capability';
const productionCapabilities = new Set<GenerationCapability>([
  'TEXT_TO_IMAGE',
  'REFERENCE_TO_IMAGE',
  'TEXT_TO_VIDEO',
  'IMAGE_TO_VIDEO',
  'REFERENCE_TO_VIDEO',
  'START_END_TO_VIDEO',
]);

function initialProductionCapability(): GenerationCapability {
  try {
    const stored = window.localStorage.getItem(PRODUCTION_CAPABILITY_STORAGE_KEY);
    if (stored && productionCapabilities.has(stored as GenerationCapability)) {
      return stored as GenerationCapability;
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
  const [productionCapability, setProductionCapability] = useState<GenerationCapability>(
    initialProductionCapability,
  );
  const [productionMenuOpen, setProductionMenuOpen] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(PRODUCTION_CAPABILITY_STORAGE_KEY, productionCapability);
    } catch {
      // Storage can be unavailable in restricted webviews.
    }
  }, [productionCapability]);

  const selectProductionCapability = (capability: GenerationCapability) => {
    setProductionCapability(capability);
    setNavigationMode('production');
  };

  return {
    productionCapability,
    setProductionCapability: selectProductionCapability,
    productionMenuOpen,
    setProductionMenuOpen,
  };
}
