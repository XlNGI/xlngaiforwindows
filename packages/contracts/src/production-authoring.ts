const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Only optional descriptive strings are omitted. Required text, IDs, unknown
 * keys and invalid types remain intact for the ordinary strict validator. */
export function normalizeProductionAuthoringInstruction(input: unknown): unknown {
  const value: unknown = structuredClone(input);
  if (!record(value)) return value;
  const omitEmpty = (target: unknown, keys: string[]) => {
    if (!record(target)) return;
    for (const key of keys)
      if (typeof target[key] === 'string' && !target[key].trim()) delete target[key];
  };
  const fields: Record<string, string[]> = {
    narrative: ['conflict', 'emotionalProgression'],
    storyTime: ['era', 'season', 'storyDay', 'date', 'clockTime'],
    location: ['interiorExterior', 'area', 'weather', 'geography', 'layout', 'state'],
    style: [
      'medium',
      'technique',
      'realism',
      'proportions',
      'linework',
      'materials',
      'palette',
      'contrast',
      'texture',
      'referenceDescription',
    ],
    camera: [
      'framing',
      'angle',
      'composition',
      'lens',
      'depthOfField',
      'focus',
      'movement',
      'speed',
      'amplitude',
      'startFrame',
      'endFrame',
      'axis',
    ],
    lightingDesign: [
      'source',
      'direction',
      'quality',
      'colorTemperature',
      'fill',
      'rim',
      'practicals',
    ],
    visual: ['environment', 'composition', 'lighting', 'style', 'palette', 'lens', 'negative'],
    audio: ['ambience', 'music', 'effects'],
    transition: ['entry', 'exit'],
  };
  for (const [key, keys] of Object.entries(fields)) omitEmpty(value[key], keys);
  if (Array.isArray(value.subjects))
    for (const subject of value.subjects)
      omitEmpty(subject, [
        'description',
        'wardrobe',
        'position',
        'appearance',
        'hairMakeup',
        'expression',
        'gaze',
        'action',
        'props',
        'initialState',
        'endState',
      ]);
  if (Array.isArray(value.beats))
    for (const beat of value.beats) {
      if (!record(beat)) continue;
      omitEmpty(beat.camera, ['framing', 'angle', 'movement', 'focus']);
      if (Array.isArray(beat.dialogue))
        for (const line of beat.dialogue) omitEmpty(line, ['emotion', 'delivery']);
    }
  return value;
}

/** Applied only to model authoring tools, never to the user's final media form. */
export function normalizeProductionAuthoringArguments(name: string, input: unknown): unknown {
  const value: unknown = structuredClone(input);
  if (!record(value)) return value;
  const normalize = (entry: unknown) => {
    if (record(entry) && entry.instruction !== undefined)
      entry.instruction = normalizeProductionAuthoringInstruction(entry.instruction);
  };
  if (name === 'scene.structure.stage') {
    normalize(value.scene);
    if (Array.isArray(value.shots)) value.shots.forEach(normalize);
  } else if (name === 'scene.submit_structure' || name === 'novel.episode.submit_structure') {
    if (Array.isArray(value.scenes))
      for (const scene of value.scenes) {
        normalize(scene);
        if (record(scene) && Array.isArray(scene.shots)) scene.shots.forEach(normalize);
      }
  } else if (name === 'production.execute' && Array.isArray(value.operations))
    value.operations.forEach(normalize);
  return value;
}
