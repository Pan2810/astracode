/**
 * TreeView "Thay đổi trong phiên" (mốc M4).
 *
 * Là chỗ người dùng thấy TOÀN BỘ những gì agent đã đụng vào, ở một danh sách,
 * với ba nút cho mỗi dòng: xem diff, nhận, bỏ. Chat cuộn đi mất; Explorer thì
 * rải badge khắp cây thư mục. Cần một chỗ trả lời được câu "nó vừa sửa những
 * gì" trong một cái liếc mắt.
 *
 * Việc hoàn tác đi qua `RevertApplier` chứ không tự gọi filesystem: ledger phát
 * ra thao tác, applier áp bằng WorkspaceEdit để Ctrl+Z vẫn dùng được — kể cả
 * cho chính hành động hoàn tác.
 */
import * as vscode from 'vscode';
import { summarizeChanges, type ChangeLedger, type FileChange, type RevertOp } from '@astra/core';
import { diffLines, diffStat } from '@astra/core';

export class ChangeItem extends vscode.TreeItem {
  constructor(readonly change: FileChange) {
    super(basename(change.relativePath), vscode.TreeItemCollapsibleState.None);

    const dir = dirname(change.relativePath);
    const stat =
      change.originalContent !== null && change.currentContent !== null
        ? diffStat(diffLines(change.originalContent, change.currentContent))
        : undefined;

    this.description = [dir, stat ? `+${stat.added}/−${stat.removed}` : undefined]
      .filter(Boolean)
      .join('  ');

    this.resourceUri = vscode.Uri.file(change.uri);
    this.tooltip = new vscode.MarkdownString(
      `**${change.relativePath}**\n\n${describeStatus(change.status)}` +
        `\n\n${change.approved ? 'Approved' : 'Awaiting approval'}`,
    );

    // contextValue quyết định nút nào hiện trên dòng — xem package.json.
    this.contextValue = change.approved ? 'astraChangeApproved' : 'astraChangePending';

    this.iconPath = new vscode.ThemeIcon(
      change.status === 'created'
        ? 'diff-added'
        : change.status === 'deleted'
          ? 'diff-removed'
          : 'diff-modified',
      new vscode.ThemeColor(
        change.status === 'created'
          ? 'gitDecoration.addedResourceForeground'
          : change.status === 'deleted'
            ? 'gitDecoration.deletedResourceForeground'
            : 'gitDecoration.modifiedResourceForeground',
      ),
    );

    // Bấm vào dòng thì mở diff — đó là việc người ta muốn làm 9/10 lần.
    this.command = {
      command: 'astra.changes.openDiff',
      title: 'Show change',
      arguments: [this],
    };
  }
}

export class ChangesTreeProvider
  implements vscode.TreeDataProvider<ChangeItem>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<ChangeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.TreeView<ChangeItem> | undefined;

  constructor(private readonly ledger: ChangeLedger) {
    this.disposables.push(
      new vscode.Disposable(
        ledger.onChange(() => {
          this.emitter.fire(undefined);
          this.updateBadge();
        }),
      ),
    );
  }

  attach(view: vscode.TreeView<ChangeItem>): void {
    this.view = view;
    this.updateBadge();
  }

  getTreeItem(element: ChangeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ChangeItem[] {
    return this.ledger.list().map((c) => new ChangeItem(c));
  }

  private updateBadge(): void {
    if (!this.view) return;
    const pending = this.ledger.pending().length;
    // Badge đếm số CHỜ DUYỆT, không phải tổng: con số cần trả lời "còn việc gì
    // phải làm không", chứ không phải "đã làm bao nhiêu".
    this.view.badge =
      pending > 0 ? { value: pending, tooltip: `${pending} changes awaiting approval` } : undefined;
    this.view.description = summarizeChanges(this.ledger.list());
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}

/**
 * Áp dụng thao tác hoàn tác lên workspace.
 *
 * Dùng WorkspaceEdit vì lý do y hệt lúc ghi: hoàn tác cũng là một thay đổi, và
 * người dùng bấm nhầm nút "Bỏ" thì phải Ctrl+Z lại được.
 */
export class RevertApplier {
  async apply(ops: RevertOp[]): Promise<{ reverted: number; failed: string[] }> {
    if (ops.length === 0) return { reverted: 0, failed: [] };

    const edit = new vscode.WorkspaceEdit();
    const failed: string[] = [];
    const toSave: vscode.Uri[] = [];

    for (const op of ops) {
      const uri = vscode.Uri.file(op.uri);
      try {
        if (op.content === null) {
          // Trước đó file không tồn tại → hoàn tác nghĩa là xoá nó đi.
          edit.deleteFile(uri, { ignoreIfNotExists: true });
          continue;
        }

        let exists = true;
        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          exists = false;
        }

        if (!exists) {
          edit.createFile(uri, {
            ignoreIfExists: true,
            contents: Buffer.from(op.content, 'utf8'),
          });
        } else {
          const doc = await vscode.workspace.openTextDocument(uri);
          edit.replace(
            uri,
            new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
            op.content,
          );
          toSave.push(uri);
        }
      } catch (err) {
        failed.push(`${op.uri}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      return { reverted: 0, failed: [...failed, 'VS Code refused to apply the change'] };
    }

    for (const uri of toSave) {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase(),
      );
      if (doc?.isDirty) await doc.save();
    }

    return { reverted: ops.length - failed.length, failed };
  }
}

function describeStatus(status: FileChange['status']): string {
  switch (status) {
    case 'created':
      return 'New file created by AstraCode';
    case 'deleted':
      return 'File deleted by AstraCode';
    case 'modified':
      return 'File edited by AstraCode';
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}
