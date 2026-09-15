/**
 * CodeGraph theo workspace, phía extension host — mốc M12.
 *
 * Mẫu `MentionIndex` (`chat/mentionIndex.ts`): dựng LƯỜI (không build lúc
 * activate), watcher chỉ ĐÁNH DẤU cũ, rebuild thật diễn ra lười ở lần
 * `ensureFresh()` kế tiếp — tạo/xoá/sửa hàng loạt (git checkout, cài lại
 * dependency) không nện việc build liên tục.
 *
 * Khác `MentionIndex` một điểm: CodeGraph cần cả `onDidChange` (sửa nội dung
 * đổi cạnh import/export của một file), không chỉ create/delete.
 *
 * `.wasm` không nằm trong `node_modules` của bản đã đóng gói (`.vscodeignore`
 * loại `node_modules/**`) — `esbuild.mjs` copy chúng vào `dist/wasm/`, và
 * đường dẫn ở đây trỏ vào ĐÓ, không phải `require.resolve` như CLI.
 */
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import {
  CodeGraph,
  GraphBuilder,
  GraphCache,
  TreeSitterParser,
  createToolContext,
  graphDir,
  GRAMMAR_WASM_FILENAMES,
  RUNTIME_WASM_FILENAME,
  type CodeGraphProvider,
  type Logger,
} from '@astra/core';
import { VsCodeFileSystem } from '../fs/VsCodeFileSystem.js';
import { homeLayout } from '../session/storage.js';

interface WorkspaceEntry {
  provider: CodeGraphProvider;
  watcher: vscode.FileSystemWatcher;
}

export class CodeGraphService implements vscode.Disposable {
  private readonly perRoot = new Map<string, WorkspaceEntry>();
  private readonly wasmDir: string;

  constructor(
    private readonly logger: Logger,
    extensionUri: vscode.Uri,
  ) {
    this.wasmDir = vscode.Uri.joinPath(extensionUri, 'dist', 'wasm').fsPath;
  }

  dispose(): void {
    for (const entry of this.perRoot.values()) entry.watcher.dispose();
    this.perRoot.clear();
  }

  /** `CodeGraphProvider` cho một workspace root — dựng một lần, tái dùng sau đó. */
  forWorkspace(workspaceRoot: string): CodeGraphProvider {
    let entry = this.perRoot.get(workspaceRoot);
    if (!entry) {
      entry = this.createEntry(workspaceRoot);
      this.perRoot.set(workspaceRoot, entry);
    }
    return entry.provider;
  }

  private createEntry(workspaceRoot: string): WorkspaceEntry {
    const parser = new TreeSitterParser({
      runtimeWasmPath: nodePath.join(this.wasmDir, RUNTIME_WASM_FILENAME),
      resolveGrammarWasm: (lang) => nodePath.join(this.wasmDir, GRAMMAR_WASM_FILENAMES[lang]),
      logger: this.logger,
    });
    const cache = new GraphCache({
      fs: new VsCodeFileSystem(),
      dir: graphDir(homeLayout(), workspaceRoot),
      logger: this.logger,
    });

    let graph: CodeGraph | undefined;
    let building: Promise<CodeGraph> | undefined;
    // true = watcher bắn từ lần build gần nhất, graph trong tay đã cũ.
    let dirty = false;

    const buildOnce = async (signal?: AbortSignal): Promise<CodeGraph> => {
      const toolCtx = createToolContext({
        workspaceRoot,
        logger: this.logger,
        fs: new VsCodeFileSystem(),
        ...(signal ? { signal } : {}),
      });
      const builder = new GraphBuilder({
        workspaceRoot: toolCtx.workspaceRoot,
        fs: toolCtx.fs,
        pathGuard: toolCtx.pathGuard,
        denylist: toolCtx.denylist,
        logger: toolCtx.logger,
        parser,
        ...(signal ? { signal } : {}),
      });

      const base = graph ?? (await cache.load());
      const built = await builder.build(base);
      graph = built;
      dirty = false;
      // Không chờ ghi cache — trả kết quả cho model trước, ghi đĩa chạy song song.
      void cache.save(built);
      return built;
    };

    const provider: CodeGraphProvider = {
      ensureFresh: (signal?: AbortSignal): Promise<CodeGraph> => {
        if (graph && !dirty) return Promise.resolve(graph);
        if (!building) {
          building = buildOnce(signal).finally(() => {
            building = undefined;
          });
        }
        return building;
      },
    };

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(workspaceRoot), '**/*'),
    );
    const markDirty = (): void => {
      dirty = true;
    };
    watcher.onDidCreate(markDirty);
    watcher.onDidChange(markDirty);
    watcher.onDidDelete(markDirty);

    return { provider, watcher };
  }
}
