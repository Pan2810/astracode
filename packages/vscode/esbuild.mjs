/**
 * Bundle extension host thành CommonJS.
 *
 * Vì sao bundle thay vì để tsc emit: extension host của VS Code nạp CommonJS,
 * còn @astra/core là ESM. Bundle giải quyết chuyện đó một lần, và cũng là điều
 * kiện để webview không phải tải gì từ ngoài (CSP nghiêm ngặt — SECURITY.md §6).
 */
import { build, context } from 'esbuild';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

/**
 * `.wasm` của CodeGraph (M12) — copy vào `dist/wasm/`, KHÔNG bundle qua esbuild.
 *
 * `.vscodeignore` loại cả `node_modules/**`, nên `web-tree-sitter`/`tree-sitter-wasms`
 * không có mặt trong bản đã đóng gói; đây là lý do `TreeSitterParser` nhận đường
 * dẫn wasm tường minh từ `CodeGraphService` thay vì tự `require.resolve` — xem
 * comment đầu file `packages/core/src/graph/parser/TreeSitterParser.ts`.
 */
function copyWasmAssets() {
  const require = createRequire(import.meta.url);
  const outDir = 'dist/wasm';
  mkdirSync(outDir, { recursive: true });

  // Tên file PHẢI khớp `RUNTIME_WASM_FILENAME` ở
  // packages/core/src/graph/parser/TreeSitterParser.ts — pin 0.22.x dùng
  // `tree-sitter.wasm`, không phải `web-tree-sitter.wasm` của bản ≥0.25.
  copyFileSync(require.resolve('web-tree-sitter/tree-sitter.wasm'), join(outDir, 'tree-sitter.wasm'));

  const grammars = [
    'tree-sitter-javascript.wasm',
    'tree-sitter-typescript.wasm',
    'tree-sitter-tsx.wasm',
    'tree-sitter-python.wasm',
    'tree-sitter-go.wasm',
  ];
  for (const name of grammars) {
    copyFileSync(require.resolve(`tree-sitter-wasms/out/${name}`), join(outDir, name));
  }
}

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  minify,
  // Bản phát hành không kèm sourcemap: nó to gấp ~3 lần chính bundle và có thể
  // lộ đường dẫn tuyệt đối trên máy build.
  sourcemap: !minify,
  logLevel: 'info',
  // 'vscode' do host cung cấp lúc chạy, không được bundle vào.
  external: ['vscode'],
};

/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  format: 'cjs',
  // TreeSitterParser.ts (core) dùng `import.meta.url` trong nhánh
  // `defaultResolveGrammarWasm` — chỉ chạy khi KHÔNG truyền `resolveGrammarWasm`.
  // CodeGraphService luôn truyền tường minh (dòng 66-67), nên nhánh đó chết trong
  // extension đã đóng gói; cảnh báo esbuild vô hại, tắt ở đây thay vì đổi source ESM
  // của core.
  logOverride: { 'empty-import-meta': 'silent' },
};

/**
 * Script chạy TRONG webview: trình duyệt, không có Node, không có 'vscode'.
 * Từ v5 chỉ còn MỘT webview — bảng cài đặt là lớp phủ bên trong chat.
 */
/** @type {(entry: string) => import('esbuild').BuildOptions} */
const webview = (entry) => ({
  ...common,
  entryPoints: [`src/webview/${entry}.ts`],
  outfile: `dist/webview/${entry}.js`,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  external: [],
});

const builds = [extension, webview('chat')];

copyWasmAssets();

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('esbuild: đang theo dõi thay đổi...');
} else {
  await Promise.all(builds.map((b) => build(b)));
}
