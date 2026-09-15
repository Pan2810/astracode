/**
 * Khớp glob tối giản cho `exclude_globs`.
 *
 * Tự viết thay vì kéo `picomatch` vào: server này cố ý không thêm dependency
 * nào (thêm dep = sửa package.json = sửa file có sẵn). Chỉ cần đúng ba thứ mà
 * hợp đồng dùng: `**`, `*`, `?`.
 */

// Sao chép mẫu vào regex: hai sao bọc quanh một thư mục khớp thư mục đó ở mọi
// độ sâu, kể cả ngay ở gốc; một sao không vượt qua dấu `/`.
export function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    // `/**` ở cuối: khớp cả chính thư mục đó lẫn mọi thứ bên trong.
    if (c === '/' && g[i + 1] === '*' && g[i + 2] === '*' && i + 3 >= g.length) {
      re += '(?:/.*)?';
      i += 2;
      continue;
    }
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        // `**/` khớp cả KHÔNG thư mục nào — nếu không thì `**/node_modules/**`
        // sẽ trượt `node_modules/a.js` ở ngay gốc repo.
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
      continue;
    }
    if (c === '*') {
      re += '[^/]*';
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      continue;
    }
    re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(relPath, globs = []) {
  const p = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some((g) => {
    try {
      return globToRegExp(g).test(p);
    } catch {
      return false;
    }
  });
}
