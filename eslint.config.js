// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // web/ là trang giới thiệu tĩnh (HTML/CSS/JS thuần trình duyệt, đa ngôn
    // ngữ) — không thuộc pnpm workspace, không cần các quy tắc kiến trúc của
    // packages/core.
    // .venv/ là virtualenv Python của người dùng: nó có sẵn JS bundle của
    // torch/pip, và eslint quét chúng làm `pnpm lint` thất bại với ~90 lỗi
    // không liên quan tới repo.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'web/**',
      '.venv/**',
      '.verify-baseline/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── Nguyên tắc kiến trúc #1 (docs/PLAN.md): core không được import 'vscode'.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message:
                "packages/core phải test được bằng vitest thuần Node. Đưa phần phụ thuộc VS Code sang packages/vscode và truyền vào qua interface.",
            },
          ],
        },
      ],
    },
  },

  // ── Nguyên tắc bảo mật #7 (docs/SECURITY.md §5): filesystem chỉ đi qua một cửa.
  // Chỉ core/fs/ được chạm node:fs. Mọi tool nhận FileSystem qua ctx.
  // (FileSystem port viết ở M2 — rule đặt sẵn để không bị trôi.)
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: [
      'packages/core/src/fs/**',
      'packages/core/src/telemetry/**',
      'packages/core/src/sandbox/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message: 'Xem nguyên tắc kiến trúc #1 trong docs/PLAN.md.',
            },
            // Chạy tiến trình cũng chỉ một cửa, y như filesystem (M5). Tool
            // `bash` phải đi qua ctx.sandbox, nếu không thì việc "chạy trong
            // Docker" chỉ là một nhánh if và sẽ có ngày bị đi vòng.
            {
              name: 'child_process',
              message:
                'Chỉ core/sandbox/ được spawn tiến trình. Tool dùng ctx.sandbox — docs/SECURITY.md §4.',
            },
            {
              name: 'node:child_process',
              message:
                'Chỉ core/sandbox/ được spawn tiến trình. Tool dùng ctx.sandbox — docs/SECURITY.md §4.',
            },
            {
              name: 'fs',
              message:
                'Chỉ core/fs/ được chạm filesystem trực tiếp. Dùng FileSystem port qua ctx — docs/SECURITY.md §5.',
            },
            {
              name: 'node:fs',
              message:
                'Chỉ core/fs/ được chạm filesystem trực tiếp. Dùng FileSystem port qua ctx — docs/SECURITY.md §5.',
            },
            {
              name: 'node:fs/promises',
              message:
                'Chỉ core/fs/ được chạm filesystem trực tiếp. Dùng FileSystem port qua ctx — docs/SECURITY.md §5.',
            },
          ],
        },
      ],
    },
  },

  // Tiền tố `_` = "cố ý không dùng". Cần cho hai khuôn xuất hiện thường xuyên:
  // bỏ một khoá khi destructure (`({ stage: _stage, ...task }) => task`) và
  // tham số phải khai để giữ đúng vị trí. Không có quy ước này thì cách duy
  // nhất làm lint xanh là viết vòng vo hơn — hoặc rải `eslint-disable`.
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // astraqa-server chạy trên Node ≥ 20 và dùng runtime của nó: `fetch` có sẵn,
  // hẹn giờ là global, `AbortController` dùng để cắt một lượt gọi model quá
  // giờ. Không khai ở đây thì `no-undef` báo 85 lỗi trên 16 file — một cổng
  // lint không ai qua được là cổng lint không ai đọc.
  {
    files: ['tools/astraqa-server/**/*.mjs'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        queueMicrotask: 'readonly',
      },
    },
  },

  // Script build/tooling chạy bằng Node, không phải code sản phẩm.
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        URL: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
      },
    },
  },
);
