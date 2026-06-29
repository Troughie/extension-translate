// config.js — Cấu hình dùng chung cho extension (đóng vai trò "env" của extension).
// Trình duyệt không đọc được file .env của Python, nên ĐỔI ĐỊA CHỈ SERVER OCR Ở ĐÂY.
//
// Được nạp ở cả 3 nơi:
//   - service worker  : background.js gọi importScripts('config.js')
//   - content script  : manifest content_scripts.js liệt kê config.js TRƯỚC content.js
//   - popup           : popup.html <script src="src/config.js"> TRƯỚC popup.js
//
// Dùng `var` + gán globalThis để mọi scope (worker/page) đều thấy biến này.
var OCR_SERVER_URL = 'http://100.114.67.105:7860';

if (typeof globalThis !== 'undefined') {
  globalThis.OCR_SERVER_URL = OCR_SERVER_URL;
}
