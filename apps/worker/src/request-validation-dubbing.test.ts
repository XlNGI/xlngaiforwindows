import type { WorkerMethod } from '@ai-video/contracts';
import { describe, expect, it } from 'vitest';
import { RequestValidationError, validateSessionRequestParams } from './request-validation.js';

const cue = {
  sceneId: 'scene',
  speakerKind: 'character',
  characterDocumentId: 'character',
  voiceProfileId: 'voice',
  text: '确定台词。',
  position: 0,
  startMs: 0,
  lipSync: false,
};
const speech = { cueId: 'cue', expectedRowVersion: 1, costAcknowledged: true };
const submit = {
  sceneId: 'scene',
  sourceVideoAssetId: 'video',
  mode: 'lipsync',
  providerProfileId: 'sync',
  model: 'sync-3',
  costAcknowledged: true,
  removeSourceAudioAcknowledged: true,
};
const voice = {
  characterDocumentId: 'character',
  providerProfileId: 'speech',
  model: 'speech-2.8-hd',
  voiceId: 'saved-fixed-voice',
  speed: 1,
  pitch: 0,
};
const valid: Array<[WorkerMethod, Record<string, unknown>]> = [
  ['characterVoice.list', {}],
  ['characterVoice.save', voice],
  ['audio.import', { sourcePath: 'E:\\recordings\\line.wav', cueId: 'cue', expectedRowVersion: 1 }],
  ['audio.list', { deleted: 'trash', kind: 'reference' }],
  ['audio.get', { audioId: 'audio' }],
  ['audio.mediaSource', { audioId: 'audio' }],
  ['audio.trash', { audioId: 'audio' }],
  ['audio.restore', { audioId: 'audio' }],
  ['audio.purge', { audioId: 'audio', confirm: true }],
  ['dubbing.runtime.get', {}],
  ['dubbing.scene.get', { sceneId: 'scene' }],
  ['dubbing.cue.save', cue],
  ['dubbing.cue.delete', { cueId: 'cue', expectedRowVersion: 1 }],
  ['dubbing.take.generate', speech],
  ['dubbing.take.adopt', { cueId: 'cue', takeId: 'take', expectedRowVersion: 1 }],
  ['dubbing.job.submit', submit],
  ['dubbing.job.cancel', { jobId: 'job' }],
  ['dubbing.job.retry', { jobId: 'job', costAcknowledged: true }],
  ['dubbing.job.get', { jobId: 'job' }],
  ['dubbing.job.list', {}],
  ['dubbing.output.adopt', { jobId: 'job', expectedRowVersion: 1 }],
];
describe('dubbing RPC boundary validation', () => {
  it.each(valid)('accepts the bounded public %s contract', (method, input) => {
    expect(validateSessionRequestParams(method, input)).toBe(input);
  });

  it.each(valid)('rejects caller-injected secrets and frozen snapshots for %s', (method, input) => {
    for (const key of ['apiKey', 'headers', 'inputSnapshot', 'projectId', 'outputRelativePath'])
      expect(() => validateSessionRequestParams(method, { ...input, [key]: 'forged' })).toThrow(
        RequestValidationError,
      );
    for (const value of [null, [], 'object'])
      expect(() => validateSessionRequestParams(method, value)).toThrow(RequestValidationError);
  });

  it.each(['false', 'true', 0, 1, null, {}, []])(
    'rejects truthy nonboolean acknowledgements: %j',
    (value) => {
      expect(() =>
        validateSessionRequestParams('dubbing.take.generate', {
          ...speech,
          costAcknowledged: value,
        }),
      ).toThrow(RequestValidationError);
      expect(() =>
        validateSessionRequestParams('dubbing.job.submit', { ...submit, costAcknowledged: value }),
      ).toThrow(RequestValidationError);
      expect(() =>
        validateSessionRequestParams('dubbing.job.submit', {
          ...submit,
          removeSourceAudioAcknowledged: value,
        }),
      ).toThrow(RequestValidationError);
      expect(() =>
        validateSessionRequestParams('dubbing.job.retry', {
          jobId: 'job',
          costAcknowledged: value,
        }),
      ).toThrow(RequestValidationError);
      expect(() =>
        validateSessionRequestParams('audio.purge', { audioId: 'audio', confirm: value }),
      ).toThrow(RequestValidationError);
      expect(() =>
        validateSessionRequestParams('dubbing.cue.save', { ...cue, lipSync: value }),
      ).toThrow(RequestValidationError);
    },
  );

  it('requires dialogue revisions for edits, imports, generation and adoption', () => {
    for (const [method, input] of [
      ['dubbing.cue.save', { ...cue, id: 'existing' }],
      ['audio.import', { sourcePath: 'E:\\line.wav', cueId: 'cue' }],
      ['dubbing.take.generate', { cueId: 'cue', costAcknowledged: true }],
      ['dubbing.take.adopt', { cueId: 'cue', takeId: 'take' }],
    ] as Array<[WorkerMethod, Record<string, unknown>]>)
      expect(() => validateSessionRequestParams(method, input)).toThrow(RequestValidationError);
  });

  it('bounds text, scene times, speaker coordinates, voice models and settings without coercion', () => {
    for (const patch of [
      { text: 'x'.repeat(4001) },
      { text: '' },
      { text: null },
      { startMs: -1 },
      { startMs: 600001 },
      { startMs: '0' },
      { position: 0.5 },
      { trailingPauseMs: 60001 },
      { emotion: 'whisper' },
      { speakerCoordinates: [0.5] },
      { speakerCoordinates: [0.5, '0.5'] },
      { speakerCoordinates: [1.01, 0.5] },
      { speakerCoordinates: [NaN, 0.5] },
      { speakerCoordinates: null },
      { speakerKind: 'narration', characterDocumentId: undefined, lipSync: true },
    ])
      expect(() => validateSessionRequestParams('dubbing.cue.save', { ...cue, ...patch })).toThrow(
        RequestValidationError,
      );
    for (const patch of [
      { model: 'arbitrary-model' },
      { speed: '1' },
      { speed: 2.1 },
      { speed: NaN },
      { pitch: 13 },
      { pitch: 0.5 },
      { voiceId: '' },
      { providerProfileId: null },
    ])
      expect(() =>
        validateSessionRequestParams('characterVoice.save', { ...voice, ...patch }),
      ).toThrow(RequestValidationError);
  });

  it('validates budgets as a strict nested contract with finite prices and at most three attempts', () => {
    const budget = { currency: 'USD', unitPrice: 0.15, maxAmount: 10, maxAttempts: 1 };
    expect(
      validateSessionRequestParams('dubbing.job.submit', { ...submit, budget }),
    ).toHaveProperty('budget', budget);
    for (const patch of [
      { apiKey: 'secret' },
      { reservedAmount: 1 },
      { currency: 'usd' },
      { currency: null },
      { maxAttempts: 0 },
      { maxAttempts: 4 },
      { maxAttempts: '1' },
      { unitPrice: '0.15' },
      { unitPrice: Infinity },
      { unitPrice: -1 },
      { maxAmount: 0 },
      { maxAmount: null },
    ])
      expect(() =>
        validateSessionRequestParams('dubbing.job.submit', {
          ...submit,
          budget: { ...budget, ...patch },
        }),
      ).toThrow(RequestValidationError);
    expect(() =>
      validateSessionRequestParams('dubbing.job.submit', { ...submit, budget: null }),
    ).toThrow(RequestValidationError);
  });
});
