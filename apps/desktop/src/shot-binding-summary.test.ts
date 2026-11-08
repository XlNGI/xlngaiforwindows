import { describe, expect, it } from 'vitest';
import type { ShotInfo } from '@ai-video/contracts';
import { aggregateShotBindings, shotReferenceDocumentIdsByScene } from './shot-binding-summary';

const shot = (id: string, title: string, references?: ShotInfo['authoringIR']): ShotInfo => ({
  id,
  sceneId: 'scene',
  title,
  position: 0,
  status: 'draft',
  authoringIR: references,
  rowVersion: 1,
  createdAt: 'now',
  updatedAt: 'now',
});

describe('aggregateShotBindings', () => {
  it('unions shot references by role and keeps the shots and explicit assets for each document', () => {
    const first = shot('shot-1', '镜头一', {
      schemaVersion: 1,
      kind: 'shot',
      prompt: '林澈在旧码头。',
      references: {
        characterDocumentIds: ['character'],
        sceneDocumentIds: ['location'],
        propDocumentIds: ['radio'],
      },
    });
    first.referenceBindings = {
      characterBindings: [{ characterDocumentId: 'character', assetId: 'character-image' }],
      sceneBindings: [{ sourceDocumentId: 'location', assetId: 'location-image' }],
    };
    const second = shot('shot-2', '镜头二', {
      schemaVersion: 1,
      kind: 'shot',
      prompt: '林澈拿起收音机。',
      references: {
        characterDocumentIds: ['character'],
        propDocumentIds: ['radio'],
      },
    });

    expect(aggregateShotBindings([first, second])).toEqual([
      {
        role: 'character',
        documentId: 'character',
        shotIds: ['shot-1', 'shot-2'],
        shotTitles: ['镜头一', '镜头二'],
        assetIds: ['character-image'],
      },
      {
        role: 'scene',
        documentId: 'location',
        shotIds: ['shot-1'],
        shotTitles: ['镜头一'],
        assetIds: ['location-image'],
      },
      {
        role: 'prop',
        documentId: 'radio',
        shotIds: ['shot-1', 'shot-2'],
        shotTitles: ['镜头一', '镜头二'],
        assetIds: [],
      },
    ]);
  });

  it('does not restore legacy media references when the shot IR explicitly clears that role', () => {
    const current = shot('shot-1', '镜头一', {
      schemaVersion: 1,
      kind: 'shot',
      prompt: '空镜。',
      references: { characterDocumentIds: [], sceneDocumentIds: [] },
    });
    current.referenceBindings = {
      characterBindings: [{ characterDocumentId: 'old-character', assetId: 'old-image' }],
      sceneBindings: [{ sourceDocumentId: 'old-location', assetId: 'old-scene-image' }],
    };

    expect(aggregateShotBindings([current])).toEqual([]);
  });

  it('projects shot-only references into the scene document binding view', () => {
    const current = shot('shot-1', '镜头一', {
      schemaVersion: 1,
      kind: 'shot',
      prompt: '林澈在旧码头。',
      references: {
        characterDocumentIds: ['character'],
        sceneDocumentIds: ['location'],
        propDocumentIds: [],
      },
    });
    expect(
      shotReferenceDocumentIdsByScene([{ id: 'scene' }], new Map([['scene', [current]]])),
    ).toEqual({
      scene: {
        characterDocumentIds: ['character'],
        sceneDocumentIds: ['location'],
        propDocumentIds: [],
      },
    });
  });
});
