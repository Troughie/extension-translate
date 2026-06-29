// queue-order.test.js — kiểm tra pipeline dịch theo THỨ TỰ ĐỌC (trên→dưới),
// không theo thứ tự ảnh tải xong. Chạy: node manga-translator/test/queue-order.test.js
//
// Trích thẳng hàm topmostIndex từ content.js (eval) để test ĐÚNG code đang ship,
// không cần DOM / chrome API (cả file content.js là IIFE gọi chrome.* nên không require trực tiếp được).

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');

// Lấy nguyên định nghĩa `function topmostIndex(...) { ... }` (đến dấu } cân bằng đầu tiên ở cột 2).
const m = src.match(/function topmostIndex\([\s\S]*?\n {2}\}/);
if (!m) {
  console.error('FAIL: không tìm thấy hàm topmostIndex trong content.js (chưa implement?)');
  process.exit(1);
}
// eslint-disable-next-line no-eval
const topmostIndex = eval(`(${m[0]})`);

function drain(arrival, topOf) {
  // Mô phỏng pump(): lặp lấy phần tử CAO NHẤT cho tới khi rỗng → ra thứ tự XỬ LÝ.
  const q = [...arrival];
  const out = [];
  while (q.length) out.push(q.splice(topmostIndex(q, topOf), 1)[0]);
  return out;
}

let failed = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`PASS: ${name}`); }
  else { console.error(`FAIL: ${name}\n   expected ${e}\n   got      ${a}`); failed++; }
}

const topOf = x => x.top;

// 1. Ảnh tải xong theo thứ tự LOẠN (giống lúc sang chapter mới) → vẫn xử lý trên→dưới.
const scrambled = [
  { id: 'p4', top: 3000 },
  { id: 'p1', top: 0 },
  { id: 'p5', top: 4000 },
  { id: 'p2', top: 1000 },
  { id: 'p3', top: 2000 },
];
eq(drain(scrambled, topOf).map(x => x.id), ['p1', 'p2', 'p3', 'p4', 'p5'],
   'thứ tự tải loạn → dịch trên→dưới');

// 2. Trường hợp BUG cũ: ảnh dưới tải xong trước (bottom-up arrival).
const bottomUp = [
  { id: 'last', top: 8000 },
  { id: 'mid', top: 4000 },
  { id: 'first', top: 0 },
];
eq(drain(bottomUp, topOf).map(x => x.id), ['first', 'mid', 'last'],
   'ảnh cuối tải trước → vẫn dịch ảnh đầu trước');

// 3. Đã đúng thứ tự thì giữ nguyên.
const inOrder = [{ id: 'a', top: 0 }, { id: 'b', top: 500 }, { id: 'c', top: 900 }];
eq(drain(inOrder, topOf).map(x => x.id), ['a', 'b', 'c'], 'đã đúng thứ tự → giữ nguyên');

// 4. topmostIndex chọn đúng index nhỏ-Y-nhất khi gọi đơn lẻ.
eq(topmostIndex([{ top: 50 }, { top: 10 }, { top: 30 }], topOf), 1, 'topmostIndex chọn top nhỏ nhất');

process.exit(failed ? 1 : 0);
