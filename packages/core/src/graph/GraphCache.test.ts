import { describe, expect, it } from 'vitest';
import * as nodePath from 'node:path';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { CodeGraph } from './CodeGraph.js';
import { GraphCache, GRAPH_SCHEMA_VERSION } from './GraphCache.js';

const WINDOWS = nodePath.sep === '\\';
const DIR = WINDOWS ? 'C:\\home\\.astra\\graph\\repo-abc' : '/home/.astra/graph/repo-abc';

function makeGraph(): CodeGraph {
  const graph = new CodeGraph();
  graph.setFile('a.ts', 'hash-a', ['b.ts'], [{ file: 'a.ts', name: 'foo', line: 1, column: 0, kind: 'function' }], []);
  graph.setFile('b.ts', 'hash-b', [], [], []);
  return graph;
}

describe('GraphCache', () => {
  it('load() trên cache trống trả undefined, không throw', async () => {
    const fs = new MemoryFileSystem({ files: {}, caseInsensitive: WINDOWS });
    const cache = new GraphCache({ fs, dir: DIR, logger: new Logger({ sink: new MemorySink() }) });
    expect(await cache.load()).toBeUndefined();
  });

  it('save() rồi load() lại ra đúng graph', async () => {
    const fs = new MemoryFileSystem({ files: {}, caseInsensitive: WINDOWS });
    const cache = new GraphCache({ fs, dir: DIR, logger: new Logger({ sink: new MemorySink() }) });

    await cache.save(makeGraph());
    const restored = await cache.load();

    expect(restored?.importsOf('a.ts')).toEqual(['b.ts']);
    expect(restored?.importedBy('b.ts')).toEqual(['a.ts']);
    expect(restored?.definitionOf('foo')?.file).toBe('a.ts');
    expect(restored?.hashOf('a.ts')).toBe('hash-a');
  });

  it('schemaVersion lệch (cũ hơn hoặc mới hơn) -> bỏ qua, không throw', async () => {
    const snapshotPath = nodePath.join(DIR, 'snapshot.json');
    const fs = new MemoryFileSystem({
      files: { [snapshotPath]: JSON.stringify({ ...emptySnapshot(), schemaVersion: GRAPH_SCHEMA_VERSION + 1 }) },
      caseInsensitive: WINDOWS,
    });
    const cache = new GraphCache({ fs, dir: DIR, logger: new Logger({ sink: new MemorySink() }) });
    expect(await cache.load()).toBeUndefined();
  });

  it('JSON hỏng -> bỏ qua, không throw', async () => {
    const snapshotPath = nodePath.join(DIR, 'snapshot.json');
    const fs = new MemoryFileSystem({ files: { [snapshotPath]: '{ không phải json' }, caseInsensitive: WINDOWS });
    const cache = new GraphCache({ fs, dir: DIR, logger: new Logger({ sink: new MemorySink() }) });
    expect(await cache.load()).toBeUndefined();
  });
});

function emptySnapshot() {
  return { schemaVersion: GRAPH_SCHEMA_VERSION, fileHashes: {}, files: {}, definitions: {}, references: {}, truncated: false };
}
