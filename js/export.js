// 用 SheetJS 產生 .xlsx。iPhone 從主畫面打開時改用分享選單。

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// 純數字（沒有前導 0）轉成數值，其餘保留文字，避免編號的前導 0 被吃掉。
function toCellValue(text) {
  const t = text.trim();
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t) && t.length < 16) return Number(t);
  return text;
}

export function makeFilename(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `table-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.xlsx`;
}

export function buildXlsxBlob(rows, merges = []) {
  const XLSX = window.XLSX;
  const ws = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map(toCellValue)));
  if (merges.length) {
    ws['!merges'] = merges.map((m) => ({ s: { r: m.r, c: m.c }, e: { r: m.r + m.rs - 1, c: m.c + m.cs - 1 } }));
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '表格');
  const data = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([data], { type: XLSX_MIME });
}

// 回傳 'share' 或 'download'。
export async function exportXlsx(rows, merges = [], filename = makeFilename()) {
  const blob = buildXlsxBlob(rows, merges);
  const file = new File([blob], filename, { type: XLSX_MIME });

  if (isIOS() && isStandalone() && navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: filename });
    return 'share';
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.target = '_self';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'download';
}
