import { describe, expect, it } from 'vitest';
import { RepeatedReadResults } from './repeated-read-results.js';
function read(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    status: 'read',
    sourceType: 'document',
    sourceId: 'doc',
    versionId: 'v1',
    sourceStatus: 'draft',
    readMode: 'source',
    startOffset: 0,
    endOffset: 3000,
    content: '正文'.repeat(1500),
    sourceHandle: 'handle-1',
    citationLabel: 'L1',
    ...extra,
  });
}
describe('RepeatedReadResults', () => {
  it('distinguishes production targets, views, versions and page ranges when reusing evidence', () => {
    const reuse = new RepeatedReadResults();
    const value = {
      status: 'read',
      view: 'text',
      version: 'a'.repeat(64),
      target: { kind: 'shot', id: 'shot' },
      rowVersion: 2,
      sceneId: 'scene',
      shotId: 'shot',
      contentPage: { text: '镜头正文'.repeat(1200), offset: 0, nextOffset: 4096 },
    };
    const original = JSON.stringify(value);
    expect(reuse.use('first', original)).toBe(original);
    expect(JSON.parse(reuse.use('again', original))).toMatchObject({
      status: 'identical_result',
      fullResultCallId: 'first',
      version: value.version,
      target: value.target,
      rowVersion: 2,
      sceneId: 'scene',
      shotId: 'shot',
    });
    for (const change of [
      { view: 'authoring' },
      { version: 'b'.repeat(64) },
      { target: { kind: 'shot', id: 'other' } },
      { contentPage: { ...value.contentPage, offset: 4096, nextOffset: 8192 } },
    ]) {
      const changed = JSON.stringify({ ...value, ...change });
      expect(reuse.use('changed', changed)).toBe(changed);
    }
  });
  it('reuses the same verified content through new handles and labels while preserving locators', () => {
    const reuse = new RepeatedReadResults();
    const original = read();
    expect(reuse.use('first', original)).toBe(original);
    expect(
      JSON.parse(reuse.use('again', read({ sourceHandle: 'handle-2', citationLabel: 'L3' }))),
    ).toMatchObject({
      status: 'identical_result',
      fullResultCallId: 'first',
      sourceId: 'doc',
      versionId: 'v1',
      sourceStatus: 'draft',
      sourceHandle: 'handle-2',
      citationLabel: 'L3',
    });
    reuse.clear();
    expect(reuse.use('restored', original)).toBe(original);
  });
  it('invalidates only omitted full copies when other history is compacted', () => {
    const reuse = new RepeatedReadResults();
    reuse.use('retained', read());
    const other = read({ sourceId: 'other' });
    reuse.use('omitted', other);
    reuse.clear(new Set(['omitted']));
    expect(JSON.parse(reuse.use('again', read()))).toMatchObject({ fullResultCallId: 'retained' });
    expect(reuse.use('restored', other)).toBe(other);
  });
  it.each([
    { versionId: 'v2' },
    { startOffset: 3000, endOffset: 6000 },
    { sourceStatus: 'published' },
    { bindings: { data: { material: '冰' } } },
    { content: '变化的正文'.repeat(900) },
    { readMode: 'chunk' },
  ])('does not conflate changed evidence %j', (change) => {
    const reuse = new RepeatedReadResults();
    reuse.use('first', read());
    const changed = read(change);
    expect(reuse.use('changed', changed)).toBe(changed);
  });
});
