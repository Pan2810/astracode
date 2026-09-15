/**
 * ask_user_question — execute() không tự hỏi gì cả, nó chỉ gọi ctx.askUser và
 * dịch kết quả thành content cho model. Trọng tâm test: ba nhánh của
 * AskUserResult (không có kênh hỏi / cancelled / trả lời thật) không bao giờ
 * lẫn vào nhau.
 */
import { describe, expect, it } from 'vitest';
import { askUserQuestionTool } from './askUserQuestion.js';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { PathGuard } from '../security/pathGuard.js';
import { Denylist } from '../security/denylist.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import type { ToolContext } from './Tool.js';
import type { AskUserFn, AskUserQuestion } from './askUser.js';

const ROOT = '/repo';

function ctx(askUser?: AskUserFn): ToolContext {
  const fs = new MemoryFileSystem({ files: {} });
  return {
    workspaceRoot: ROOT,
    fs,
    pathGuard: new PathGuard({ workspaceRoot: ROOT, fs }),
    denylist: new Denylist(),
    logger: new Logger({ sink: new MemorySink() }),
    ...(askUser ? { askUser } : {}),
  };
}

const oneQuestion: AskUserQuestion[] = [
  {
    header: 'Nguyên nhân',
    question: 'Nguyên nhân nào khả dĩ nhất?',
    options: [{ label: 'A' }, { label: 'B' }],
  },
];

describe('ask_user_question', () => {
  it('không có ctx.askUser thì báo lỗi rõ ràng, không giả vờ đã hỏi', async () => {
    const result = await askUserQuestionTool.execute({ questions: oneQuestion }, ctx());
    expect(result.isError).toBe(true);
    expect(result.meta).toMatchObject({ noCapability: true });
  });

  it('cancelled (Dừng/đóng panel) không được suy diễn thành một lựa chọn', async () => {
    const result = await askUserQuestionTool.execute(
      { questions: oneQuestion },
      ctx(async () => ({ cancelled: true })),
    );
    expect(result.isError).toBe(true);
    expect(result.meta).toMatchObject({ cancelled: true, questionCount: 1 });
    expect(result.content).toContain('KHÔNG trả lời');
  });

  it('một câu hỏi, người dùng chọn một phương án', async () => {
    const result = await askUserQuestionTool.execute(
      { questions: oneQuestion },
      ctx(async () => ({
        cancelled: false,
        answers: [{ header: 'Nguyên nhân', selected: ['B'] }],
      })),
    );
    expect(result.isError).toBeUndefined();
    expect(result.untrusted).toBe(false);
    expect(result.content).toContain('B');
    expect(result.meta).toMatchObject({ questionCount: 1, answered: 1 });
  });

  it('nhiều câu hỏi, một câu không chọn gì thì không tính vào answered', async () => {
    const questions: AskUserQuestion[] = [
      ...oneQuestion,
      {
        header: 'Cách sửa',
        question: 'Sửa theo hướng nào?',
        options: [{ label: 'X' }, { label: 'Y' }],
      },
    ];
    const result = await askUserQuestionTool.execute(
      { questions },
      ctx(async () => ({
        cancelled: false,
        answers: [
          { header: 'Nguyên nhân', selected: ['A'] },
          { header: 'Cách sửa', selected: [] },
        ],
      })),
    );
    expect(result.meta).toMatchObject({ questionCount: 2, answered: 1 });
    expect(result.content).toContain('(không chọn gì)');
  });

  it('schema từ chối hai lựa chọn trùng nhãn trong cùng một câu hỏi', () => {
    // Nhãn trùng làm mất khả năng phân biệt hai lựa chọn — cả webview lẫn
    // answerQuestion ở host đều đối chiếu theo nhãn, không theo vị trí.
    const result = askUserQuestionTool.schema.safeParse({
      questions: [
        {
          header: 'Nguyên nhân',
          question: 'Chọn một',
          options: [{ label: 'A' }, { label: 'A' }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
