/**
 * Cổng của /admin: một lần Bearer đúng, rồi mười lăm phút bằng cookie.
 *
 * Năm điều được canh, và cả năm là hàng rào chứ không phải tiện nghi:
 *   1. Bearer đúng → cho qua VÀ đặt cookie HttpOnly, SameSite=Strict, 900 giây.
 *   2. Cookie đó mở được GET tiếp theo mà không cần header.
 *   3. Giá trị cookie KHÔNG phải service token.
 *   4. Cookie không mở được method nào khác GET.
 *   5. Hết mười lăm phút là hết, tính từ lúc cấp chứ không gia hạn.
 *
 * Thuần, không dựng server: đây là một quyết định trên `req`, và test nó qua
 * HTTP chỉ thêm một tầng có thể hỏng vì lý do khác.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COOKIE_NAME, DEFAULT_TTL_MS, cookieOf, createAdminAuth } from '../lib/adminAuth.mjs';

const TOKEN = 'service-token-cookie-test-0123456789';

/** `req` tối thiểu, và một `res` chỉ ghi lại header được đặt. */
function call(auth, { method = 'GET', bearer = '', cookie = '' } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (cookie) headers.cookie = cookie;
  const set = {};
  const res = { setHeader: (name, value) => { set[name] = value; } };
  const ok = auth.authorize({ method, headers }, res);
  return { ok, set };
}

test('Bearer đúng một lần thì được cấp cookie, và cookie đó mở GET sau đó', () => {
  const auth = createAdminAuth({ serviceToken: TOKEN });

  const first = call(auth, { bearer: TOKEN });
  assert.equal(first.ok, true);

  const cookie = first.set['Set-Cookie'];
  assert.ok(cookie, 'Bearer đúng phải đặt cookie');
  // Ba thuộc tính là ba hàng rào, không phải trang trí.
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, new RegExp(`Max-Age=${DEFAULT_TTL_MS / 1000}\\b`));
  assert.match(cookie, /Path=\//);
  // `Secure` KHÔNG đặt: server nói HTTP trên 127.0.0.1, và một cookie Secure
  // trên http thì có trình duyệt nhận có trình duyệt bỏ im lặng.
  assert.doesNotMatch(cookie, /Secure/);

  // Lần sau chỉ cần cookie — đúng thứ trình duyệt làm được, mà header thì không.
  const sent = cookie.split(';')[0];
  assert.equal(call(auth, { cookie: sent }).ok, true);
});

test('cookie không phải service token', () => {
  const auth = createAdminAuth({ serviceToken: TOKEN });
  const cookie = call(auth, { bearer: TOKEN }).set['Set-Cookie'];

  // Đặt chính token vào cookie là đem bí mật dài hạn đi rải vào profile trình
  // duyệt: từ đó nó ra khỏi tầm tay tiến trình này.
  assert.ok(!cookie.includes(TOKEN), 'cookie mang chính service token');
  const value = cookie.slice(`${COOKIE_NAME}=`.length).split(';')[0];
  assert.ok(value.length >= 32, `giá trị cookie quá ngắn: ${value.length}`);
  // Và nó phải khác nhau mỗi lần cấp.
  const again = call(auth, { bearer: TOKEN }).set['Set-Cookie'];
  assert.notEqual(again, cookie);
});

test('cookie chỉ mở đường đọc', () => {
  const auth = createAdminAuth({ serviceToken: TOKEN });
  const sent = call(auth, { bearer: TOKEN }).set['Set-Cookie'].split(';')[0];

  assert.equal(call(auth, { method: 'GET', cookie: sent }).ok, true);
  // Hôm nay route admin vốn chỉ đọc, nên đây là hàng rào cho ngày mai: một
  // route admin ghi được, nếu có, vẫn phải có Bearer.
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(call(auth, { method, cookie: sent }).ok, false, `${method} phải bị chặn`);
  }
  // Bearer thì vẫn đi được mọi method — cổng này không phải chỗ quyết định
  // route nào chỉ đọc.
  assert.equal(call(auth, { method: 'POST', bearer: TOKEN }).ok, true);
});

test('mười lăm phút, tính từ lúc cấp', () => {
  let clock = 1_000_000;
  const auth = createAdminAuth({ serviceToken: TOKEN, now: () => clock });
  const sent = call(auth, { bearer: TOKEN }).set['Set-Cookie'].split(';')[0];

  clock += DEFAULT_TTL_MS - 1000;
  assert.equal(call(auth, { cookie: sent }).ok, true, 'còn một giây vẫn phải vào được');

  // Dùng ở phút thứ mười bốn KHÔNG gia hạn: cửa sổ cố định là thứ nói được
  // thành câu, còn cửa sổ trượt thì hết hạn vào lúc không ai đoán được.
  clock += 2000;
  assert.equal(call(auth, { cookie: sent }).ok, false, 'hết hạn rồi vẫn vào được');
  assert.equal(auth.size(), 0, 'phiên hết hạn phải bị bỏ khỏi sổ');
});

test('không token, cookie bịa, header cookie hỏng — tất cả là không', () => {
  const auth = createAdminAuth({ serviceToken: TOKEN });

  assert.equal(call(auth).ok, false);
  assert.equal(call(auth, { bearer: 'sai-be-bet' }).ok, false);
  assert.equal(call(auth, { bearer: TOKEN.slice(0, -1) }).ok, false);
  assert.equal(call(auth, { cookie: `${COOKIE_NAME}=bia-ra-mot-gia-tri` }).ok, false);
  // Header của người lạ: hỏng thì ra rỗng, không được ném lỗi.
  for (const raw of ['', ';;;', '=', `${COOKIE_NAME}`, 'khac=1; =2']) {
    assert.equal(call(auth, { cookie: raw }).ok, false, `cookie ${JSON.stringify(raw)}`);
  }
});

test('cookieOf đọc đúng cookie của mình giữa những cookie khác', () => {
  assert.equal(cookieOf({ headers: { cookie: `a=1; ${COOKIE_NAME}=xyz; b=2` } }), 'xyz');
  assert.equal(cookieOf({ headers: { cookie: `${COOKIE_NAME}=xyz` } }), 'xyz');
  assert.equal(cookieOf({ headers: { cookie: 'khac=xyz' } }), '');
  assert.equal(cookieOf({ headers: {} }), '');
  assert.equal(cookieOf({}), '');
});

test('chưa đặt token thì mở, và không cấp cookie', () => {
  const auth = createAdminAuth({ serviceToken: '', devMode: true });
  const { ok, set } = call(auth);

  assert.equal(ok, true);
  // Không có gì để giữ, và một cookie cấp trong chế độ dev chỉ là thứ sống sót
  // sang lần chạy sau — khi có thể đã có token.
  assert.equal(set['Set-Cookie'], undefined);
  assert.equal(auth.size(), 0);
});
