/**
 * 빵을그리다(주) 판매이익 분석 — 구글 시트 저장소 (Google Apps Script)  v1
 *
 * 판매이익 분석 화면(index.html)이 올린 이카운트 판매현황·품목등록·거래처 분류·전표 점검 결과를
 * 이 구글 시트에 저장하고, 어느 기기에서 열어도 같은 자료를 돌려줍니다.
 *
 * 보안
 *  · 이 시트는 만든 사람의 구글 드라이브에만 있습니다 (공유하지 않으면 아무도 못 봄).
 *  · 웹 앱 주소로 들어오는 요청은 「비밀번호로 만든 열쇠」가 맞을 때만 자료를 주고받습니다.
 *    비밀번호 자체는 이 서버에 오지 않고, 열쇠의 해시(SHA-256)만 스크립트 속성에 보관합니다.
 *  · 열쇠가 1시간에 20번 넘게 틀리면 그 시간 동안 모든 요청을 거절합니다.
 *
 * 설치 (처음 한 번)
 *  1) 구글 드라이브 → 새로 만들기 → 구글 스프레드시트 (이름 예: 판매이익 자료)
 *  2) 확장 프로그램 → Apps Script → 이 코드를 모두 붙여넣고 저장
 *  3) 배포 → 새 배포 → 유형: 웹 앱 / 실행: 나 / 액세스 권한: 모든 사용자 → 배포 → 권한 허용
 *  4) 나온 웹 앱 주소(https://script.google.com/macros/s/…/exec)를 판매이익 분석 화면 「연결 설정」에 넣고
 *     비밀번호를 정하면 끝 (처음 정한 비밀번호가 이 시트의 비밀번호가 됩니다)
 *  비밀번호를 바꾸려면: 프로젝트 설정 → 스크립트 속성 → KEY_HASH 지우기 → 화면에서 새 비밀번호로 연결
 *
 * 코드를 고친 뒤: 배포 → 배포 관리 → 연필 → 버전 「새 버전」 → 배포 (주소는 그대로)
 */

var VER = 1;
var SH = {
  sales: ['판매', ['날짜', '거래처', '품목', '수량', '원가', '공급가액', '판매합계', '판매이익', '단가', '전달사항']],
  items: ['품목', ['품목명', '품목코드', '품목구분', '매입처', '그룹', '단위', '입고단가', '출고단가']],
  cust: ['거래처', ['거래처', '그룹', '지역', '내부']],
  audit: ['전표점검', ['키', '상태', '바꾼 때', '바꾼 사람']],
  ups: ['올린기록', ['올린 때', '종류', '파일', '시작', '끝', '줄 수', '바뀐 기존 줄', '매출 합계', '올린 사람']]
};

function doGet() { return out_({ ok: true, service: 'bread-sales', version: VER }); }
function doPost(e) {
  var res;
  try { res = handle_(JSON.parse((e && e.postData && e.postData.contents) || '{}')); }
  catch (err) { res = { ok: false, error: String((err && err.message) || err) }; }
  return out_(res);
}
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function props_() { return PropertiesService.getScriptProperties(); }
function sha_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
function hourKey_() { return 'fail:' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMddHH'); }

function handle_(q) {
  var P = props_(), hash = P.getProperty('KEY_HASH');
  if (q.action === 'hello') return { ok: true, version: VER, ready: !!hash };
  var fails = Number(P.getProperty(hourKey_()) || 0);
  if (fails >= 20) return { ok: false, error: '비밀번호가 여러 번 틀려 1시간 동안 잠겼습니다' };
  var tok = String(q.token || '');
  if (!/^[0-9a-f]{64}$/.test(tok)) return { ok: false, error: '열쇠 형식이 맞지 않습니다' };
  if (!hash) {
    if (q.action !== 'setup') return { ok: false, error: '아직 비밀번호가 정해지지 않았습니다', needSetup: true };
    P.setProperty('KEY_HASH', sha_(tok)); ensure_(); return { ok: true, setup: true };
  }
  if (sha_(tok) !== hash) { P.setProperty(hourKey_(), String(fails + 1)); cleanFails_(); return { ok: false, error: '비밀번호가 맞지 않습니다', auth: false }; }
  if (q.action === 'setup') return { ok: true, setup: false };
  var lock = LockService.getScriptLock();
  if (q.action !== 'load' && !lock.tryLock(30000)) return { ok: false, error: '다른 기기가 저장 중입니다 — 잠시 뒤 다시 해 주세요' };
  try {
    ensure_();
    switch (q.action) {
      case 'load': return load_();
      case 'putSales': return putSales_(q);
      case 'putItems': write_(SH.items, q.items || []); log_([now_(), '품목등록', q.file || '', '', '', (q.items || []).length, '', '', q.user || '']); return { ok: true };
      case 'putCust': write_(SH.cust, (q.rows || []).map(function (r) { return [r[0], r[1] || '', r[2] || '', r[3] === true ? 'Y' : r[3] === false ? 'N' : '']; })); return { ok: true };
      case 'mark': return mark_(q);
      case 'putAll': return putAll_(q);
    }
    return { ok: false, error: '모르는 요청: ' + q.action };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}
function cleanFails_() { var P = props_(), k = hourKey_(); P.getKeys().forEach(function (x) { if (x.indexOf('fail:') === 0 && x !== k) P.deleteProperty(x); }); }
function now_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', "yyyy-MM-dd'T'HH:mm:ss"); }
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(def) {
  var s = ss_().getSheetByName(def[0]);
  if (!s) { s = ss_().insertSheet(def[0]); s.getRange(1, 1, 1, def[1].length).setValues([def[1]]).setFontWeight('bold').setBackground('#173F4B').setFontColor('#ffffff'); s.setFrozenRows(1); }
  return s;
}
function ensure_() { Object.keys(SH).forEach(function (k) { sheet_(SH[k]); }); var d = ss_().getSheetByName('Sheet1') || ss_().getSheetByName('시트1'); if (d && d.getLastRow() === 0 && ss_().getSheets().length > 1) ss_().deleteSheet(d); }
function ymd_(v) { if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd'); return String(v == null ? '' : v); }
function read_(def) {
  var s = sheet_(def), n = s.getLastRow() - 1, w = def[1].length; if (n <= 0) return [];
  return s.getRange(2, 1, n, w).getValues();
}
function write_(def, rows) {
  var s = sheet_(def), w = def[1].length, old = s.getLastRow() - 1;
  if (old > 0) s.getRange(2, 1, old, s.getMaxColumns()).clearContent();
  if (!rows.length) return;
  var data = rows.map(function (r) { var a = []; for (var i = 0; i < w; i++) { var v = r[i] == null ? '' : r[i]; if (typeof v === 'string' && /^[=+@]/.test(v)) v = "'" + v; a.push(v); } return a; });   /* 이름이 = + @ 로 시작해도 수식으로 바뀌지 않게 */
  if (def === SH.sales) s.getRange(2, 1, data.length, 1).setNumberFormat('@');
  s.getRange(2, 1, data.length, w).setValues(data);
}
function log_(row) { var s = sheet_(SH.ups); s.insertRowAfter(1); s.getRange(2, 1, 1, row.length).setValues([row]); var n = s.getLastRow(); if (n > 301) s.deleteRows(302, n - 301); }

function load_() {
  var sales = read_(SH.sales).filter(function (r) { return r[0] !== '' && r[1] !== ''; }).map(function (r) { r[0] = ymd_(r[0]); return r; });
  var items = read_(SH.items), cust = read_(SH.cust), audit = read_(SH.audit), ups = read_(SH.ups).map(function (r) { r[0] = r[0] instanceof Date ? Utilities.formatDate(r[0], 'Asia/Seoul', "yyyy-MM-dd'T'HH:mm:ss") : String(r[0]); r[3] = ymd_(r[3]); r[4] = ymd_(r[4]); return r; });
  return { ok: true, version: VER, at: now_(), sales: sales, items: items, cust: cust, audit: audit, uploads: ups };
}
/* 같은 기간(from~to) 자료는 새 파일로 바꿈 → 같은 주를 다시 올려도 겹치지 않음 */
function putSales_(q) {
  var from = String(q.from || ''), to = String(q.to || ''), rows = q.rows || [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return { ok: false, error: '기간이 없습니다' };
  var keep = [], replaced = 0;
  read_(SH.sales).forEach(function (r) { if (r[0] === '' && r[1] === '') return; var d = ymd_(r[0]); r[0] = d; if (d >= from && d <= to) replaced++; else keep.push(r); });
  var all = keep.concat(rows).sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  write_(SH.sales, all);
  var amt = rows.reduce(function (s, r) { return s + (Number(r[5]) || 0); }, 0);
  log_([now_(), '판매현황', q.file || '', from, to, rows.length, replaced, Math.round(amt), q.user || '']);
  return { ok: true, replaced: replaced, total: all.length };
}
function mark_(q) {
  var s = sheet_(SH.audit), key = String(q.key || ''); if (!key) return { ok: false, error: '키가 없습니다' };
  var n = s.getLastRow() - 1, keys = n > 0 ? s.getRange(2, 1, n, 1).getValues() : [];
  for (var i = 0; i < keys.length; i++) if (keys[i][0] === key) {
    if (!q.status) s.deleteRow(i + 2); else s.getRange(i + 2, 2, 1, 3).setValues([[q.status, now_(), q.user || '']]);
    return { ok: true };
  }
  if (q.status) s.appendRow([key, q.status, now_(), q.user || '']);
  return { ok: true };
}
/* 백업 파일로 전체 바꾸기 */
function putAll_(q) {
  write_(SH.sales, q.sales || []); write_(SH.items, q.items || []); write_(SH.cust, q.cust || []); write_(SH.audit, q.audit || []);
  log_([now_(), '백업 불러오기', q.file || '', '', '', (q.sales || []).length, '', '', q.user || '']);
  return { ok: true };
}
