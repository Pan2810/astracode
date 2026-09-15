/**
 * Ba tầng UI theo dõi thay đổi của agent (mốc M4).
 *
 * Cả ba đọc từ MỘT ChangeLedger trong core. Không tầng nào giữ trạng thái
 * riêng — nếu chúng tự nhớ lấy thì sớm muộn badge nói một đằng, diff nói một
 * nẻo, và người dùng không biết tin cái nào.
 *
 *   Tầng 1  FileDecorationProvider   badge A/M/D + màu trong Explorer
 *   Tầng 2  TextDocumentContentProvider (`astra-original:`) → vscode.diff
 *   Tầng 3  TextEditorDecorationType  tô dòng thêm/xoá ngay trong editor
 *
 * Tầng 2 cần một chỗ giữ BẢN GỐC. Nó không nằm trên đĩa nữa (file đã bị ghi
 * đè), nên phải lấy từ ledger — đó là lý do ledger giữ `originalContent` chứ
 * không chỉ ghi "file này đã đổi".
 */
import * as vscode from 'vscode';
import { diffLines, type ChangeLedger, type FileChange } from '@astra/core';

/** Scheme cho tài liệu ảo chứa bản gốc. Đăng ký trong package.json không cần. */
export const ORIGINAL_SCHEME = 'astra-original';

/** `file:///c:/repo/a.ts` → `astra-original:/c:/repo/a.ts` */
export function toOriginalUri(fsPath: string): vscode.Uri {
  return vscode.Uri.file(fsPath).with({ scheme: ORIGINAL_SCHEME });
}

// ─── Tầng 1: badge trong Explorer ──────────────────────────────────────────

const BADGE: Record<FileChange['status'], { badge: string; tooltip: string; color: string }> = {
  created: {
    badge: 'A',
    tooltip: 'AstraCode created this file',
    color: 'gitDecoration.addedResourceForeground',
  },
  modified: {
    badge: 'M',
    tooltip: 'AstraCode edited this file',
    color: 'gitDecoration.modifiedResourceForeground',
  },
  deleted: {
    badge: 'D',
    tooltip: 'AstraCode deleted this file',
    color: 'gitDecoration.deletedResourceForeground',
  },
};

export class ChangeDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  /** URI đã từng gắn badge — cần để BỎ badge khi thay đổi bị hoàn tác. */
  private lastUris: vscode.Uri[] = [];

  constructor(private readonly ledger: ChangeLedger) {
    this.disposables.push(
      vscode.window.registerFileDecorationProvider(this),
      new vscode.Disposable(
        ledger.onChange((changes) => {
          // Phải báo cả URI CŨ lẫn mới: VS Code chỉ vẽ lại đúng những URI được
          // nêu tên, nên bỏ sót URI cũ là badge còn nguyên sau khi revert.
          const next = changes.map((c) => vscode.Uri.file(c.uri));
          this.emitter.fire([...this.lastUris, ...next]);
          this.lastUris = next;
        }),
      ),
    );
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const change = this.ledger.get(uri.fsPath);
    if (!change) return undefined;

    const spec = BADGE[change.status];
    return {
      badge: spec.badge,
      tooltip: change.approved ? `${spec.tooltip} (approved)` : `${spec.tooltip} — awaiting approval`,
      color: new vscode.ThemeColor(spec.color),
      propagate: true,
    };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}

// ─── Tầng 2: bản gốc cho diff editor ───────────────────────────────────────

export class OriginalContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ledger: ChangeLedger) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, this),
      new vscode.Disposable(
        ledger.onChange((changes) => {
          for (const c of changes) this.emitter.fire(toOriginalUri(c.uri));
        }),
      ),
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const change = this.ledger.get(uri.fsPath);
    // File mới tạo thì "bản gốc" là rỗng — diff sẽ hiện toàn bộ là dòng thêm,
    // đúng như git hiển thị file mới.
    return change?.originalContent ?? '';
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}

/** Mở diff bản gốc ↔ bản hiện tại. */
export async function openDiff(change: FileChange): Promise<void> {
  const current = vscode.Uri.file(change.uri);
  const title = `${change.relativePath} — AstraCode ${
    change.status === 'created' ? 'created' : change.status === 'deleted' ? 'deleted' : 'edited'
  }`;
  await vscode.commands.executeCommand('vscode.diff', toOriginalUri(change.uri), current, title, {
    preview: true,
  });
}

// ─── Tầng 3: tô dòng ngay trong editor ─────────────────────────────────────

export class InlineDiffDecorator implements vscode.Disposable {
  private readonly added: vscode.TextEditorDecorationType;
  private readonly removedGutter: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ledger: ChangeLedger) {
    this.added = vscode.window.createTextEditorDecorationType({
      // Dùng màu của theme, không hardcode: nền sáng và nền tối cần hai màu
      // khác hẳn nhau, và người dùng có thể đang dùng theme tương phản cao.
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    // Dòng bị xoá không còn tồn tại trong bản mới nên không tô nền được — đánh
    // dấu ở lề trái tại vị trí nó từng nằm.
    this.removedGutter = vscode.window.createTextEditorDecorationType({
      borderWidth: '0 0 1px 0',
      borderStyle: 'dashed',
      borderColor: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
      overviewRulerColor: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      new vscode.Disposable(ledger.onChange(() => this.refreshAll())),
    );
    this.refreshAll();
  }

  private refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.refresh(editor);
  }

  private refresh(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== 'file') return;

    const change = this.ledger.get(editor.document.uri.fsPath);
    if (!change || change.originalContent === null || change.currentContent === null) {
      editor.setDecorations(this.added, []);
      editor.setDecorations(this.removedGutter, []);
      return;
    }

    const lines = diffLines(change.originalContent, editor.document.getText());
    const addedRanges: vscode.Range[] = [];
    const removedRanges: vscode.Range[] = [];

    for (const l of lines) {
      if (l.op === 'add' && l.newLine !== undefined) {
        const i = l.newLine - 1;
        if (i < editor.document.lineCount) addedRanges.push(editor.document.lineAt(i).range);
      } else if (l.op === 'remove') {
        // Neo vào dòng liền trước trong bản MỚI — chỗ khoảng trống từng có nó.
        const anchor = Math.max(0, (l.oldLine ?? 1) - 2);
        if (anchor < editor.document.lineCount) {
          removedRanges.push(editor.document.lineAt(anchor).range);
        }
      }
    }

    editor.setDecorations(this.added, addedRanges);
    editor.setDecorations(this.removedGutter, removedRanges);
  }

  dispose(): void {
    this.added.dispose();
    this.removedGutter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
