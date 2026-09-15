import { describe, expect, it } from 'vitest';
import { CodeGraph } from './CodeGraph.js';
import type { SymbolDefinition, SymbolLocation } from './types.js';

function def(file: string, name: string, line = 1): SymbolDefinition {
  return { file, name, line, column: 0, kind: 'function' };
}

function ref(file: string, name: string, line = 1): SymbolLocation {
  return { file, name, line, column: 0 };
}

describe('CodeGraph', () => {
  it('importsOf/importedBy đúng cả hai chiều', () => {
    const graph = new CodeGraph();
    graph.setFile('a.ts', 'h1', ['b.ts', 'c.ts'], [], []);
    graph.setFile('b.ts', 'h2', ['c.ts'], [], []);
    graph.setFile('c.ts', 'h3', [], [], []);

    expect(graph.importsOf('a.ts').sort()).toEqual(['b.ts', 'c.ts']);
    expect(graph.importedBy('c.ts').sort()).toEqual(['a.ts', 'b.ts']);
    expect(graph.importedBy('a.ts')).toEqual([]);
  });

  it('setFile gọi lại xoá cạnh CŨ trước khi ghi cạnh mới — không cộng dồn', () => {
    const graph = new CodeGraph();
    graph.setFile('a.ts', 'h1', ['b.ts'], [], []);
    graph.setFile('a.ts', 'h2', ['c.ts'], [], []);

    expect(graph.importsOf('a.ts')).toEqual(['c.ts']);
    expect(graph.importedBy('b.ts')).toEqual([]);
    expect(graph.importedBy('c.ts')).toEqual(['a.ts']);
  });

  it('removeFile dọn sạch cạnh, định nghĩa và tham chiếu', () => {
    const graph = new CodeGraph();
    graph.setFile('a.ts', 'h1', ['b.ts'], [def('a.ts', 'foo')], [ref('a.ts', 'bar')]);
    graph.removeFile('a.ts');

    expect(graph.hashOf('a.ts')).toBeUndefined();
    expect(graph.importedBy('b.ts')).toEqual([]);
    expect(graph.definitionOf('foo')).toBeUndefined();
    expect(graph.referencesTo('bar')).toEqual([]);
  });

  it('definitionOf trả định nghĩa đầu tiên; referencesTo trả hết', () => {
    const graph = new CodeGraph();
    graph.setFile('a.ts', 'h1', [], [def('a.ts', 'run', 3)], [ref('a.ts', 'run', 10)]);
    graph.setFile('b.ts', 'h2', [], [], [ref('b.ts', 'run', 5)]);

    expect(graph.definitionOf('run')).toEqual(def('a.ts', 'run', 3));
    expect(graph.referencesTo('run').map((r) => r.file).sort()).toEqual(['a.ts', 'b.ts']);
    expect(graph.definitionOf('không-tồn-tại')).toBeUndefined();
  });

  it('impactRadius là BFS ngược trên importedBy, giới hạn độ sâu', () => {
    const graph = new CodeGraph();
    // a -> b -> c -> d  (mũi tên = import). Sửa d ảnh hưởng c, b, a theo thứ tự sâu.
    graph.setFile('a.ts', 'h', ['b.ts'], [], []);
    graph.setFile('b.ts', 'h', ['c.ts'], [], []);
    graph.setFile('c.ts', 'h', ['d.ts'], [], []);
    graph.setFile('d.ts', 'h', [], [], []);

    expect(graph.impactRadius('d.ts', 1)).toEqual(['c.ts']);
    expect(graph.impactRadius('d.ts', 2).sort()).toEqual(['b.ts', 'c.ts']);
    expect(graph.impactRadius('d.ts', 10).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(graph.impactRadius('a.ts', 5)).toEqual([]); // Không ai import a.ts.
  });

  it('toSnapshot/fromSnapshot round-trip giữ nguyên dữ liệu', () => {
    const graph = new CodeGraph();
    graph.setFile('a.ts', 'h1', ['b.ts'], [def('a.ts', 'foo')], [ref('a.ts', 'bar')]);
    graph.setFile('b.ts', 'h2', [], [], []);
    graph.truncated = true;

    const restored = CodeGraph.fromSnapshot(graph.toSnapshot(1));

    expect(restored.importsOf('a.ts')).toEqual(['b.ts']);
    expect(restored.importedBy('b.ts')).toEqual(['a.ts']);
    expect(restored.definitionOf('foo')).toEqual(def('a.ts', 'foo'));
    expect(restored.referencesTo('bar')).toEqual([ref('a.ts', 'bar')]);
    expect(restored.hashOf('a.ts')).toBe('h1');
    expect(restored.truncated).toBe(true);
  });
});
