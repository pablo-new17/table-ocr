// 一張照片從頭到尾的處理流程：校正角度 → 找框線 → 偵測文字 → 辨識文字 → 組成表格。
import { imageToMat, correctPerspective, detectGrid, buildTable, splitBoxesByGrid } from './table.js';

// lowScore：信心分數低於這個值的文字，會另外切出原圖（t.crop，canvas），讓使用者檢查。
export async function runPipeline(cv, ocr, image, onProgress = () => {}, lowScore = 0.8) {
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));

  onProgress('讀取照片');
  await yieldUI();
  const raw = imageToMat(cv, image);

  onProgress('校正拍攝角度');
  await yieldUI();
  const { mat, corrected } = correctPerspective(cv, raw);
  raw.delete();

  try {
    onProgress('偵測文字位置');
    await yieldUI();
    const rawBoxes = await ocr.detect(mat);

    onProgress('尋找表格框線');
    await yieldUI();
    const grid = detectGrid(cv, mat, rawBoxes);
    const boxes = splitBoxesByGrid(grid, rawBoxes);

    const texts = [];
    for (let i = 0; i < boxes.length; i++) {
      onProgress(`辨識文字 ${i + 1} / ${boxes.length}`);
      const { text, score, candidates } = await ocr.recognize(mat, boxes[i]);
      texts.push({ box: boxes[i], text, score, candidates });
      if (i % 5 === 4) await yieldUI();
    }

    onProgress('產生表格');
    const { rows, merges } = buildTable(grid, texts);

    // 信心分數低的文字：切出原圖（四周多留 6 px），給使用者對照
    for (const t of texts) {
      if (t.score >= lowScore || t.text.trim() === '') continue;
      const xs = t.box.map((p) => p.x);
      const ys = t.box.map((p) => p.y);
      const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 6);
      const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 6);
      const x1 = Math.min(mat.cols, Math.ceil(Math.max(...xs)) + 6);
      const y1 = Math.min(mat.rows, Math.ceil(Math.max(...ys)) + 6);
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      const roi = mat.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
      const crop = document.createElement('canvas');
      cv.imshow(crop, roi);
      roi.delete();
      t.crop = crop;
    }

    // 預覽圖：紅線是框線（只畫實際找到的線段），藍框是文字
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, mat);
    const ctx = canvas.getContext('2d');
    const lw = Math.max(2, Math.round(mat.cols / 500));
    if (grid) {
      ctx.strokeStyle = '#e5322d';
      ctx.lineWidth = lw;
      for (const line of [...grid.hLines, ...grid.vLines]) {
        for (const [a, b] of line.intervals) {
          ctx.beginPath();
          for (let u = a; u <= b; u += 10) {
            const v = line.at(u);
            const [x, y] = line.horizontal ? [u, v] : [v, u];
            if (u === a) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
    }
    ctx.strokeStyle = '#1f6feb';
    ctx.lineWidth = lw;
    for (const b of boxes) {
      ctx.beginPath();
      ctx.moveTo(b[0].x, b[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(b[i].x, b[i].y);
      ctx.closePath();
      ctx.stroke();
    }

    return { rows, merges, grid, texts, corrected, preview: canvas };
  } finally {
    mat.delete();
  }
}
