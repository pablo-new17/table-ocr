import { waitForOpenCV } from './cv-ready.js';
import { PPOCR } from './ocr.js';
import { runPipeline } from './pipeline.js';
import { exportXlsx } from './export.js';

const $ = (id) => document.getElementById(id);
const offlineStatus = $('offline-status');
const engineStatus = $('engine-status');
const progress = $('progress');
const previewSection = $('preview-section');
const previewCanvas = $('preview');
const resultSection = $('result-section');
const resultTable = $('result-table');
const exportButton = $('export-xlsx');
const reviewSection = $('review-section');
const reviewList = $('review-list');
const inputs = [$('camera-input'), $('file-input')];

// 信心分數低於這個值的文字，列在「可能辨識錯誤」清單裡
const LOW_SCORE = 0.8;

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

// ---- 離線（Service Worker） ----
async function setupOffline() {
  if (!('serviceWorker' in navigator)) {
    setStatus(offlineStatus, '這個瀏覽器不支援離線使用', 'error');
    return;
  }
  // 直接檢查 cache 裡有沒有離線需要的大檔，不只看 Service Worker 有沒有啟用
  const REQUIRED = [
    'vendor/opencv.js',
    'vendor/ort-wasm-simd-threaded.wasm',
    'vendor/ppocrv5_det.onnx',
    'vendor/ppocrv5_rec.onnx',
    'vendor/ppocrv5_dict.json',
    'vendor/xlsx.full.min.js',
  ];
  const allCached = async () => {
    const hits = await Promise.all(REQUIRED.map((p) => caches.match(new URL(p, location.href).href)));
    return hits.every(Boolean);
  };
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    const update = async () => {
      if (reg.active && await allCached()) setStatus(offlineStatus, '離線準備完成：之後斷線也能使用', 'ok');
      else setStatus(offlineStatus, '下載離線檔案中，請保持連線…');
    };
    update();
    navigator.serviceWorker.ready.then(update);
    reg.addEventListener('updatefound', () => {
      setStatus(offlineStatus, '下載離線檔案中，請保持連線…');
      reg.installing?.addEventListener('statechange', update);
    });
  } catch (err) {
    setStatus(offlineStatus, `離線功能啟用失敗：${err.message}`, 'error');
  }
}

// ---- 辨識引擎 ----
let cv = null;
let ocr = null;

async function setupEngine() {
  inputs.forEach((i) => { i.disabled = true; });
  try {
    setStatus(engineStatus, '載入 OpenCV 中…');
    cv = await waitForOpenCV();
    setStatus(engineStatus, '載入 PP-OCRv5 模型中…');
    const engine = new PPOCR(cv, './');
    await engine.init();
    ocr = engine; // 模型全部載入完才設定，避免還沒載入完就開始辨識
    setStatus(engineStatus, '辨識引擎已就緒', 'ok');
    inputs.forEach((i) => { i.disabled = false; });
  } catch (err) {
    console.error(err);
    setStatus(engineStatus, `辨識引擎載入失敗：${err.message}`, 'error');
  }
}

// ---- 表格顯示與匯出 ----
let currentRows = [];

let currentMerges = [];
let tableWidth = 0;

// 合併儲存格用 rowspan、colspan 顯示；每一格記住自己的列、欄位置。
function renderTable(rows, merges = []) {
  resultTable.replaceChildren();
  tableWidth = Math.max(1, ...rows.map((r) => r.length));
  const covered = new Set();
  const spanAt = new Map();
  for (const m of merges) {
    spanAt.set(`${m.r},${m.c}`, m);
    for (let r = m.r; r < m.r + m.rs; r++) {
      for (let c = m.c; c < m.c + m.cs; c++) if (r !== m.r || c !== m.c) covered.add(`${r},${c}`);
    }
  }
  rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    for (let c = 0; c < tableWidth; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const td = document.createElement('td');
      td.contentEditable = 'true';
      td.dataset.r = r;
      td.dataset.c = c;
      const m = spanAt.get(`${r},${c}`);
      if (m) { td.rowSpan = m.rs; td.colSpan = m.cs; }
      td.textContent = row[c] ?? '';
      tr.appendChild(td);
    }
    resultTable.appendChild(tr);
  });
}

// 找到第 r 列、第 c 欄所在的那一格（合併儲存格會找到左上角那一格）
function cellAt(r, c) {
  for (const m of currentMerges) {
    if (r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs) { r = m.r; c = m.c; break; }
  }
  return resultTable.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
}

// 列出信心分數低的文字，並把表格裡那幾格標成黃色底
function renderReview(texts) {
  reviewList.replaceChildren();
  const low = texts
    .filter((t) => t.score < LOW_SCORE && t.text.trim() !== '' && t.row !== undefined)
    .sort((a, b) => a.row - b.row || a.col - b.col);
  for (const t of low) {
    const td = cellAt(t.row, t.col);
    if (td) td.classList.add('low');
    t.current = t.text; // 表格那一格目前用的文字
    const li = document.createElement('li');

    // 上半部：原圖與位置，點一下跳到表格那一格
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'jump';
    if (t.crop) jump.appendChild(t.crop);
    const info = document.createElement('span');
    info.innerHTML = '<span class="text"></span><br><span class="where"></span>';
    const textEl = info.querySelector('.text');
    textEl.textContent = `目前：「${t.current}」`;
    info.querySelector('.where').textContent = `第 ${t.row + 1} 列第 ${t.col + 1} 欄`;
    jump.appendChild(info);
    jump.addEventListener('click', () => {
      const cell = cellAt(t.row, t.col);
      if (!cell) return;
      cell.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      cell.focus();
    });
    li.appendChild(jump);

    // 下半部：前 3 名候選（按一下就選），第 4 個是自己輸入
    const choices = document.createElement('div');
    choices.className = 'choices';
    const optionButtons = [];
    const apply = (value, chosenBtn) => {
      const cell = cellAt(t.row, t.col);
      if (cell) {
        const now = cell.textContent;
        cell.textContent = now.includes(t.current) ? now.replace(t.current, value) : value;
        cell.classList.remove('low');
      }
      t.current = value;
      textEl.textContent = `目前：「${t.current}」`;
      optionButtons.forEach((b) => b.classList.toggle('chosen', b === chosenBtn));
      li.classList.add('done');
    };
    (t.candidates?.length ? t.candidates : [{ text: t.text, score: t.score }]).forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'choice';
      b.textContent = `${c.text}　${c.score.toFixed(2)}`;
      b.addEventListener('click', () => apply(c.text, b));
      optionButtons.push(b);
      choices.appendChild(b);
    });
    const own = document.createElement('form');
    own.className = 'own';
    own.innerHTML = '<input type="text" placeholder="自己輸入" aria-label="自己輸入正確的文字"><button type="submit">確定</button>';
    own.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = own.querySelector('input').value;
      if (value.trim() === '') return;
      apply(value, null);
    });
    choices.appendChild(own);
    li.appendChild(choices);
    li.tableOcrItem = t; // 給測試用
    reviewList.appendChild(li);
  }
  reviewSection.hidden = low.length === 0;
  return low.length;
}

// 使用者改過的格子，拿掉黃色底
resultTable.addEventListener('input', (e) => {
  if (e.target.matches('td')) e.target.classList.remove('low');
});

function readTable() {
  const rows = Array.from({ length: resultTable.rows.length }, () => new Array(tableWidth).fill(''));
  for (const td of resultTable.querySelectorAll('td')) {
    rows[Number(td.dataset.r)][Number(td.dataset.c)] = td.innerText.replace(/\n$/, '');
  }
  return rows;
}

exportButton.addEventListener('click', async () => {
  try {
    currentRows = readTable();
    const how = await exportXlsx(currentRows, currentMerges);
    setStatus(progress, how === 'share' ? '已開啟分享選單' : '已下載 .xlsx', 'ok');
  } catch (err) {
    if (err.name === 'AbortError') return; // 使用者關掉分享選單
    console.error(err);
    setStatus(progress, `匯出失敗：${err.message}`, 'error');
  }
});

// ---- 拍照或選圖 ----
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取這張照片')); };
    img.src = url;
  });
}

async function handleFile(file) {
  if (!file || !ocr) return;
  inputs.forEach((i) => { i.disabled = true; });
  const started = performance.now();
  try {
    const img = await loadImage(file);
    const result = await runPipeline(cv, ocr, img, (msg) => setStatus(progress, `${msg}…`), LOW_SCORE);

    previewCanvas.width = result.preview.width;
    previewCanvas.height = result.preview.height;
    previewCanvas.getContext('2d').drawImage(result.preview, 0, 0);
    previewSection.hidden = false;

    window.tableOcr.last = result; // 除錯用
    currentRows = result.rows;
    currentMerges = result.merges;
    renderTable(currentRows, currentMerges);
    resultSection.hidden = false;
    const lowCount = renderReview(result.texts);

    const secs = ((performance.now() - started) / 1000).toFixed(1);
    const gridText = result.grid
      ? `找到 ${result.grid.hLines.length - 1} 列 × ${result.grid.vLines.length - 1} 欄、${result.merges.length} 個合併儲存格`
      : '沒有找到表格框線，改用文字位置排列';
    setStatus(progress, `完成（${secs} 秒）：${gridText}，辨識出 ${result.texts.length} 段文字，其中 ${lowCount} 段信心分數低於 ${LOW_SCORE}`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus(progress, `處理失敗：${err.message}`, 'error');
  } finally {
    inputs.forEach((i) => { i.disabled = false; i.value = ''; });
  }
}

inputs.forEach((input) => input.addEventListener('change', () => handleFile(input.files[0])));

// 給測試頁用
window.tableOcr = { handleFile, readTable, get merges() { return currentMerges; }, get ready() { return !!ocr; } };

setupOffline();
setupEngine();
