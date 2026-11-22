// 影像前處理、找表格框線、把文字框分配到格子。全部用 OpenCV.js。

// 把圖片縮到長邊最多 maxSide，回傳 RGBA 的 cv.Mat。
export function imageToMat(cv, image, maxSide = 2000) {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return cv.imread(canvas);
}

// 依 tl、tr、br、bl 順序排列四個點。
export function orderQuad(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

// 判斷四邊形是不是紙張邊緣：紙張裡面亮、外面（桌面）暗。
// 表格外框裡外都是白紙，亮度差不多，不算紙張。
function isPaperEdge(cv, gray, quad) {
  const k = Math.max(5, Math.round(Math.min(gray.cols, gray.rows) * 0.01));
  const mask = cv.Mat.zeros(gray.rows, gray.cols, cv.CV_8U);
  const inner = new cv.Mat();
  const outer = new cv.Mat();
  const ringIn = new cv.Mat();
  const ringOut = new cv.Mat();
  const pts = cv.matFromArray(4, 1, cv.CV_32SC2, quad.flatMap((p) => [p.x, p.y]));
  const vec = new cv.MatVector();
  vec.push_back(pts);
  try {
    cv.fillPoly(mask, vec, new cv.Scalar(255));
    const kernel = cv.Mat.ones(2 * k + 1, 2 * k + 1, cv.CV_8U);
    cv.erode(mask, inner, kernel);
    cv.dilate(mask, outer, kernel);
    kernel.delete();
    cv.subtract(mask, inner, ringIn);
    cv.subtract(outer, mask, ringOut);
    // 四邊形貼著照片邊緣、外面看不到桌面時，無法判斷，當成不是紙張
    if (cv.countNonZero(ringOut) < cv.countNonZero(ringIn) * 0.3) return false;
    const inMean = cv.mean(gray, ringIn)[0];
    const outMean = cv.mean(gray, ringOut)[0];
    return inMean - outMean > 40;
  } finally {
    mask.delete(); inner.delete(); outer.delete(); ringIn.delete(); ringOut.delete(); pts.delete(); vec.delete();
  }
}

// 找到紙張邊緣時，把紙張校正成正面的長方形；找不到紙張邊緣時不裁切，回傳原圖的複本。
export function correctPerspective(cv, src) {
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let best = null;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 50, 150);
    const k = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, k);
    k.delete();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imgArea = src.cols * src.rows;
    let bestArea = imgArea * 0.25;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const peri = cv.arcLength(c, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = cv.contourArea(approx);
        if (area > bestArea) {
          const d = approx.data32S;
          const quad = [0, 1, 2, 3].map((j) => ({ x: d[j * 2], y: d[j * 2 + 1] }));
          if (isPaperEdge(cv, blur, quad)) {
            bestArea = area;
            best = quad;
          }
        }
      }
      approx.delete();
      c.delete();
    }
  } finally {
    gray.delete(); blur.delete(); edges.delete(); contours.delete(); hierarchy.delete();
  }

  if (!best) return { mat: src.clone(), corrected: false };

  const [tl, tr, br, bl] = orderQuad(best);
  const width = Math.round(Math.max(Math.hypot(tr.x - tl.x, tr.y - tl.y), Math.hypot(br.x - bl.x, br.y - bl.y)));
  const height = Math.round(Math.max(Math.hypot(bl.x - tl.x, bl.y - tl.y), Math.hypot(br.x - tr.x, br.y - tr.y)));
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const out = new cv.Mat();
  cv.warpPerspective(src, out, M, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  srcPts.delete(); dstPts.delete(); M.delete();
  return { mat: out, corrected: true };
}

// ---- 框線 ----
// 一條框線用二次曲線表示：橫線是 y = f(x)，直線是 x = f(y)。
// 照片裡的紙張常常沒有拍平，框線是斜的或微彎的，不能當成水平、垂直的直線。

// 最小平方法擬合 v = a + b*t + c*t^2（t 先正規化），點太集中時改用一次式。
function fitCurve(us, vs, degree) {
  const n = us.length;
  const mu = us.reduce((s, u) => s + u, 0) / n;
  const su = Math.max(1, Math.sqrt(us.reduce((s, u) => s + (u - mu) ** 2, 0) / n));
  const m = degree + 1;
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const B = new Array(m).fill(0);
  for (let i = 0; i < n; i++) {
    const t = (us[i] - mu) / su;
    const pw = [1, t, t * t];
    for (let r = 0; r < m; r++) {
      B[r] += pw[r] * vs[i];
      for (let c = 0; c < m; c++) A[r][c] += pw[r] * pw[c];
    }
  }
  // 高斯消去法
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [B[col], B[piv]] = [B[piv], B[col]];
    if (Math.abs(A[col][col]) < 1e-9) return fitCurve(us, vs, 0);
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < m; c++) A[r][c] -= f * A[col][c];
      B[r] -= f * B[col];
    }
  }
  const coef = B.map((b, i) => b / A[i][i]);
  while (coef.length < 3) coef.push(0);
  return (u) => {
    const t = (u - mu) / su;
    return coef[0] + coef[1] * t + coef[2] * t * t;
  };
}

function makeLine(points, horizontal, size) {
  // points: [{ u, v }]，u 是沿著線的座標，v 是垂直於線的座標
  const us = points.map((p) => p.u);
  const vs = points.map((p) => p.v);
  const from = Math.min(...us);
  const to = Math.max(...us);
  const degree = to - from > size * 0.3 ? 2 : 1;
  const f = fitCurve(us, vs, degree);
  return { horizontal, points, from, to, at: f, intervals: [] };
}

// 從遮罩找出框線。回傳的線依位置由小到大排序。
// isText(x, y)：這個點在不在文字框裡，用來排除字的筆畫。
function findLines(cv, mask, horizontal, isText = () => false) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const segments = [];
  const along = horizontal ? mask.cols : mask.rows;
  const across = horizontal ? mask.rows : mask.cols;
  try {
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const r = cv.boundingRect(c);
      const d = c.data32S;
      const pts = [];
      const step = Math.max(1, Math.floor(c.rows / 400));
      for (let j = 0; j < c.rows; j += step) {
        pts.push(horizontal ? { u: d[j * 2], v: d[j * 2 + 1] } : { u: d[j * 2 + 1], v: d[j * 2] });
      }
      segments.push({ length: horizontal ? r.width : r.height, from: horizontal ? r.x : r.y, to: horizontal ? r.x + r.width : r.y + r.height, pts });
      c.delete();
    }
  } finally {
    contours.delete(); hierarchy.delete();
  }
  if (segments.length === 0) return [];

  // 長線段（至少是最長那條線的 1/4）才能自己成為一條框線，排除字的筆畫
  const maxLen = Math.max(...segments.map((s) => s.length));
  const kept = segments.filter((s) => s.length >= maxLen * 0.25).sort((a, b) => b.length - a.length);
  const short = segments.filter((s) => {
    if (s.length >= maxLen * 0.25) return false;
    const mu = (s.from + s.to) / 2;
    const mv = s.pts.reduce((sum, p) => sum + p.v, 0) / s.pts.length;
    return !(horizontal ? isText(mu, mv) : isText(mv, mu));
  });

  // 由長到短，把同一條線上的線段接起來
  const tol = Math.max(6, across * 0.008);
  const lines = [];
  for (const s of kept) {
    const mid = (s.from + s.to) / 2;
    const vMid = s.pts.reduce((sum, p) => sum + p.v, 0) / s.pts.length;
    const line = lines.find((l) => Math.abs(l.at(mid) - vMid) <= tol);
    if (line) {
      const merged = makeLine([...line.points, ...s.pts], horizontal, along);
      merged.intervals = [...line.intervals, [s.from, s.to]];
      lines[lines.indexOf(line)] = merged;
    } else {
      const l = makeLine(s.pts, horizontal, along);
      l.intervals = [[s.from, s.to]];
      lines.push(l);
    }
  }

  // 短線段（例如很窄的第一欄裡的那一小段框線）：整段都落在某條長框線的曲線上，
  // 而且緊鄰那條線已經找到的線段，才接到那條線。離很遠的短筆畫（例如表格外的字）不接。
  const maxGap = along * 0.03;
  const gapTo = (l, s) => Math.min(...l.intervals.map(([a, b]) => Math.max(0, a - s.to, s.from - b)));
  const pending = [...short].sort((a, b) => b.length - a.length);
  let attached = true;
  while (attached) {
    attached = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const s = pending[i];
      const line = lines.find((l) => gapTo(l, s) <= maxGap && s.pts.every((p) => Math.abs(l.at(p.u) - p.v) <= tol));
      if (line) {
        // 只補進 intervals（判斷「這裡有線」用），不改 from/to：
        // from/to 是長線段本身的範圍，用來判斷這條線是不是太長（紙張邊緣）
        line.intervals.push([s.from, s.to]);
        pending.splice(i, 1);
        attached = true;
      }
    }
  }
  const center = along / 2;
  lines.forEach((l) => { l.pos = l.at(center); });
  return lines.sort((a, b) => a.pos - b.pos);
}

// 橫線 h 與直線 v 的交點
function intersect(h, v) {
  let y = h.pos;
  let x = v.at(y);
  for (let i = 0; i < 3; i++) {
    y = h.at(x);
    x = v.at(y);
  }
  return { x, y };
}

function covers(line, value, tol) {
  return line.intervals.some(([a, b]) => value >= a - tol && value <= b + tol);
}

// 橫線與直線互相交叉的連成一組，回傳線條最多的那一組。
// 表格的線彼此交叉成一大組；校正角度後貼在圖片邊緣的紙張邊緣只跟彼此交叉，會被排除。
function largestConnectedGrid(hLines, vLines, tol) {
  const n = hLines.length + vLines.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  // 只用長線段本身的範圍（from～to）判斷交叉，不用接上去的短線段：
  // 短線段可能在表格外面（紙邊、桌面），會讓表格的線碰到紙張邊緣
  const core = (l, value) => value >= l.from - tol && value <= l.to + tol;
  hLines.forEach((h, i) => vLines.forEach((v, j) => {
    const p = intersect(h, v);
    if (core(h, p.x) && core(v, p.y)) parent[find(i)] = find(hLines.length + j);
  }));
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, { h: [], v: [] });
    if (i < hLines.length) groups.get(root).h.push(hLines[i]);
    else groups.get(root).v.push(vLines[i - hLines.length]);
  }
  let best = { h: [], v: [] };
  for (const g of groups.values()) {
    if (g.h.length >= 2 && g.v.length >= 2 && g.h.length + g.v.length > best.h.length + best.v.length) best = g;
  }
  return best;
}


// 找出照片裡紙張的範圍：紙是白色或灰色（飽和度低），桌面、墊子、資料夾多半有顏色（飽和度高）。
// 實測：紙張（含陰影）S ≤ 17，木頭桌面、竹墊、紅色資料夾 S ≥ 94。
// 回傳往內縮過的紙張遮罩（避開紙張邊緣）；找不到夠大的紙張範圍時回傳 null。
function paperMask(cv, src) {
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  const planes = new cv.MatVector();
  const low = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.GaussianBlur(rgb, rgb, new cv.Size(9, 9), 0);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, planes);
    const sat = planes.get(1);
    cv.threshold(sat, low, 60, 255, cv.THRESH_BINARY_INV);
    sat.delete();
    cv.findContours(low, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = -1;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a > bestArea) { bestArea = a; best = i; }
      c.delete();
    }
    const imgArea = src.cols * src.rows;
    // 紙張太小，或幾乎整張照片都是低飽和度（背景也是白色或灰色），就不遮
    if (best < 0 || bestArea < imgArea * 0.2 || bestArea > imgArea * 0.97) return null;
    const mask = cv.Mat.zeros(src.rows, src.cols, cv.CV_8U);
    // 填滿整塊（包括裡面的洞），彩色筆跡、彩色框線不會被挖掉
    cv.drawContours(mask, contours, best, new cv.Scalar(255), cv.FILLED);
    const k = Math.max(5, Math.round(Math.min(src.cols, src.rows) * 0.006));
    const kernel = cv.Mat.ones(2 * k + 1, 2 * k + 1, cv.CV_8U);
    cv.erode(mask, mask, kernel);
    kernel.delete();
    return mask;
  } finally {
    rgb.delete(); hsv.delete(); planes.delete(); low.delete(); contours.delete(); hierarchy.delete();
  }
}

// 找表格框線，回傳 { hLines, vLines }（各自由小到大排序）；找不到格線時回傳 null。
// textBoxes：文字偵測找到的文字框，用來分辨短線段是框線還是字的筆畫。
export function detectGrid(cv, src, textBoxes = []) {
  const shrink = 2;
  const rects = textBoxes.map((b) => {
    const xs = b.map((p) => p.x);
    const ys = b.map((p) => p.y);
    return [Math.min(...xs) + shrink, Math.min(...ys) + shrink, Math.max(...xs) - shrink, Math.max(...ys) - shrink];
  });
  const isText = (x, y) => rects.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  const gray = new cv.Mat();
  const bin = new cv.Mat();
  const horiz = new cv.Mat();
  const vert = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.bitwise_not(gray, gray);
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 15, -2);

    // 只看紙張範圍裡面，桌面的木紋、紙張邊緣不參與找框線
    const paper = paperMask(cv, src);
    if (paper) {
      cv.bitwise_and(bin, paper, bin);
      paper.delete();
    }

    // 照片裡的線常常是斜的。細的斜線在同一個 x（或 y）上連續不夠長，會被切成很多小段，
    // 所以找直線前先左右加粗 2 px、找橫線前先上下加粗 2 px。
    const thickH = new cv.Mat();
    const thickV = new cv.Mat();
    const tH = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 5));
    const tV = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 1));
    cv.dilate(bin, thickH, tH);
    cv.dilate(bin, thickV, tV);
    tH.delete(); tV.delete();

    // 橫線的 kernel 不能比最窄的格子寬，否則窄格子裡的那一小段橫線會被濾掉
    const hk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(10, Math.floor(src.cols / 60)), 1));
    cv.morphologyEx(thickH, horiz, cv.MORPH_OPEN, hk);
    hk.delete();
    // 直線的 kernel 太短會把字的直筆畫也留下來，維持圖高 ÷ 30
    const vk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.max(10, Math.floor(src.rows / 30))));
    cv.morphologyEx(thickV, vert, cv.MORPH_OPEN, vk);
    vk.delete();
    thickH.delete(); thickV.delete();

    // 把斷掉一點點的線接起來
    const joinH = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 3));
    cv.dilate(horiz, horiz, joinH);
    joinH.delete();
    const joinV = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 15));
    cv.dilate(vert, vert, joinV);
    joinV.delete();

    const hAll = findLines(cv, horiz, true, isText);
    const vAll = findLines(cv, vert, false, isText);
    // 判斷交叉用很小的容許誤差：膨脹處理已經讓線的兩端各多延伸約 7 px，
    // 容許誤差太大會讓表格的線碰到旁邊的紙張邊緣
    const tol = 3;
    const grid = largestConnectedGrid(hAll, vAll, tol);
    if (grid.h.length < 2 || grid.v.length < 2) return null;

    // 太靠近的兩條線只留比較長的那一條
    const minGap = Math.max(8, Math.min(src.cols, src.rows) * 0.012);
    const dedupe = (lines) => {
      const out = [];
      for (const l of [...lines].sort((a, b) => a.pos - b.pos)) {
        const prev = out[out.length - 1];
        if (prev && l.pos - prev.pos < minGap) {
          if (l.to - l.from > prev.to - prev.from) out[out.length - 1] = l;
        } else {
          out.push(l);
        }
      }
      return out;
    };
    const hLines = dedupe(grid.h);
    const vLines = dedupe(grid.v);
    if (hLines.length < 2 || vLines.length < 2) return null;
    // debug：每一步找到的線，除錯用
    return { hLines, vLines, tol, debug: { hAll, vAll, group: grid } };
  } finally {
    gray.delete(); bin.delete(); horiz.delete(); vert.delete();
  }
}

// 點 (x, y) 在第幾列、第幾欄；在表格外面時回傳 -1。
function locate(grid, x, y) {
  const { hLines, vLines } = grid;
  let r = -1;
  for (let i = 0; i < hLines.length; i++) if (hLines[i].at(x) <= y) r = i;
  let c = -1;
  for (let i = 0; i < vLines.length; i++) if (vLines[i].at(y) <= x) c = i;
  const row = r >= 0 && r < hLines.length - 1 ? r : -1;
  const col = c >= 0 && c < vLines.length - 1 ? c : -1;
  return { row, col };
}

// 找合併儲存格：兩格之間的框線在那個位置不存在，就是同一格。
// 回傳 [{ r, c, rs, cs }]（只列出跨兩格以上的）。
function findMerges(grid) {
  const { hLines, vLines } = grid;
  // 用很小的容許誤差：框線經過膨脹處理會往兩端多延伸幾 px，容許誤差太大會把沒有線的地方當成有線
  const tol = 2;
  const nR = hLines.length - 1;
  const nC = vLines.length - 1;
  const id = (r, c) => r * nC + c;
  const parent = Array.from({ length: nR * nC }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const center = (r, c) => {
    const tl = intersect(hLines[r], vLines[c]);
    const br = intersect(hLines[r + 1], vLines[c + 1]);
    return { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
  };
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      const p = center(r, c);
      if (c + 1 < nC && !covers(vLines[c + 1], p.y, tol)) parent[find(id(r, c))] = find(id(r, c + 1));
      if (r + 1 < nR && !covers(hLines[r + 1], p.x, tol)) parent[find(id(r, c))] = find(id(r + 1, c));
    }
  }
  const groups = new Map();
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      const root = find(id(r, c));
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push({ r, c });
    }
  }
  const merges = [];
  for (const cells of groups.values()) {
    if (cells.length < 2) continue;
    const r0 = Math.min(...cells.map((x) => x.r));
    const r1 = Math.max(...cells.map((x) => x.r));
    const c0 = Math.min(...cells.map((x) => x.c));
    const c1 = Math.max(...cells.map((x) => x.c));
    // 只接受剛好是長方形的合併
    if ((r1 - r0 + 1) * (c1 - c0 + 1) === cells.length) {
      merges.push({ r: r0, c: c0, rs: r1 - r0 + 1, cs: c1 - c0 + 1 });
    }
  }
  return merges;
}

// 文字偵測有時會把相鄰幾格的字框成同一段。文字框跨過格子的直線時，在直線的位置切開。
export function splitBoxesByGrid(grid, boxes) {
  if (!grid) return boxes;
  const out = [];
  const gap = 3; // 切開時離直線留一點距離，避開線條本身
  for (const box of boxes) {
    const xs = box.map((p) => p.x);
    const ys = box.map((p) => p.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const cy = (y0 + y1) / 2;
    const cuts = grid.vLines
      .map((v) => v.at(cy))
      .filter((x, i) => x > x0 + gap * 2 && x < x1 - gap * 2 && covers(grid.vLines[i], cy, 2))
      .sort((a, b) => a - b);
    if (cuts.length === 0) { out.push(box); continue; }
    const edges = [x0, ...cuts, x1];
    for (let i = 0; i < edges.length - 1; i++) {
      const a = edges[i] + (i > 0 ? gap : 0);
      const b = edges[i + 1] - (i < edges.length - 2 ? gap : 0);
      if (b - a < 6) continue;
      out.push([{ x: a, y: y0 }, { x: b, y: y0 }, { x: b, y: y1 }, { x: a, y: y1 }]);
    }
  }
  return out;
}

// 同一格裡的文字：同一行直接接起來，不同行用換行分開。
function joinCellTexts(items) {
  if (items.length === 0) return '';
  items.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  const lines = [];
  for (const it of items) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(it.cy - line.cy) < it.h * 0.5) {
      line.items.push(it);
    } else {
      lines.push({ cy: it.cy, items: [it] });
    }
  }
  return lines
    .map((l) => l.items.sort((a, b) => a.cx - b.cx).map((i) => i.text).join(''))
    .join('\n');
}

// 沒有框線的文字：依 y 座標分成一行一行，每一行依 x 排序，每一段文字放一格。
// 回傳文字框的二維陣列（每一列的文字框由左到右）。
function groupIntoRows(items) {
  const sorted = [...items].sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(it.cy - row.cy) < Math.max(it.h, row.h) * 0.6) row.items.push(it);
    else rows.push({ cy: it.cy, h: it.h, items: [it] });
  }
  return rows.map((r) => r.items.sort((a, b) => a.cx - b.cx));
}

// 記下每一段文字最後放在第幾列、第幾欄（從 0 開始），寫回原本的 texts 物件（t.row、t.col）。
function placeRows(itemRows, rowOffset) {
  itemRows.forEach((row, r) => row.forEach((it, c) => { it.src.row = r + rowOffset; it.src.col = c; }));
  return itemRows.map((row) => row.map((it) => it.text));
}

// 把辨識出來的文字框放進格子。
// 回傳 { rows: 二維陣列, merges: [{ r, c, rs, cs }] }。
// 表格外面的文字（標題、註記）放在表格上方或下方，每一行一列。
// 每一段文字放在哪一格，會寫回 texts 裡的物件：t.row、t.col（從 0 開始）。
export function buildTable(grid, texts) {
  const items = texts
    .filter((t) => t.text.trim() !== '')
    .map((t) => {
      const xs = t.box.map((p) => p.x);
      const ys = t.box.map((p) => p.y);
      return {
        src: t,
        text: t.text,
        cx: (Math.min(...xs) + Math.max(...xs)) / 2,
        cy: (Math.min(...ys) + Math.max(...ys)) / 2,
        h: Math.max(...ys) - Math.min(...ys),
      };
    });

  if (!grid) return { rows: placeRows(groupIntoRows(items), 0), merges: [] };

  const nR = grid.hLines.length - 1;
  const nC = grid.vLines.length - 1;
  const merges = findMerges(grid);
  const owner = Array.from({ length: nR }, (_, r) => Array.from({ length: nC }, (_, c) => ({ r, c })));
  for (const m of merges) {
    for (let r = m.r; r < m.r + m.rs; r++) for (let c = m.c; c < m.c + m.cs; c++) owner[r][c] = { r: m.r, c: m.c };
  }

  const cells = Array.from({ length: nR }, () => Array.from({ length: nC }, () => []));
  const above = [];
  const below = [];
  const midY = (grid.hLines[0].pos + grid.hLines[nR].pos) / 2;
  for (const it of items) {
    const { row, col } = locate(grid, it.cx, it.cy);
    if (row >= 0 && col >= 0) {
      const o = owner[row][col];
      cells[o.r][o.c].push(it);
    } else if (it.cy < midY) {
      above.push(it);
    } else {
      below.push(it);
    }
  }

  const aboveItems = groupIntoRows(above);
  const belowItems = groupIntoRows(below);
  const offset = aboveItems.length;
  const aboveRows = placeRows(aboveItems, 0);
  const belowRows = placeRows(belowItems, offset + nR);
  cells.forEach((row, r) => row.forEach((list, c) => list.forEach((it) => { it.src.row = r + offset; it.src.col = c; })));

  const width = Math.max(nC, ...aboveRows.map((r) => r.length), ...belowRows.map((r) => r.length));
  const pad = (row) => [...row, ...new Array(width - row.length).fill('')];

  const rows = [
    ...aboveRows.map(pad),
    ...cells.map((row) => pad(row.map(joinCellTexts))),
    ...belowRows.map(pad),
  ];
  return { rows, merges: merges.map((m) => ({ ...m, r: m.r + offset })) };
}
