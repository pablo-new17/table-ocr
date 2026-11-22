// PP-OCRv5 mobile 文字偵測與辨識，用 ONNX Runtime Web 在瀏覽器裡執行。
// 前處理與後處理參數照 vendor/ppocrv5_det.yml、vendor/ppocrv5_rec.yml。
import { orderQuad } from './table.js';

const DET_LIMIT_SIDE = 960;
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const DET_THRESH = 0.3;
const DET_BOX_THRESH = 0.6;
const DET_UNCLIP_RATIO = 1.5;
const DET_MAX_CANDIDATES = 1000;
const REC_HEIGHT = 48;
const REC_MIN_WIDTH = 320;
const REC_MAX_WIDTH = 3200;

export class PPOCR {
  constructor(cv, base = './') {
    this.cv = cv;
    this.base = base;
  }

  async init() {
    const ort = window.ort;
    ort.env.wasm.wasmPaths = new URL('vendor/', new URL(this.base, location.href)).href;
    // GitHub Pages 不能設定 COOP/COEP 標頭，沒有 SharedArrayBuffer，只能單執行緒
    ort.env.wasm.numThreads = 1;
    const opts = { executionProviders: ['wasm'] };
    this.det = await ort.InferenceSession.create(this.base + 'vendor/ppocrv5_det.onnx', opts);
    this.rec = await ort.InferenceSession.create(this.base + 'vendor/ppocrv5_rec.onnx', opts);
    const dict = await (await fetch(this.base + 'vendor/ppocrv5_dict.json')).json();
    this.dict = dict;
    this.chars = null; // 第一次辨識時依模型輸出大小決定要不要補空白字元
  }

  // 偵測文字位置。src 是 RGBA 的 cv.Mat，回傳每一段文字的四個角（原圖座標）。
  async detect(src) {
    const cv = this.cv;
    const ort = window.ort;
    const ratio = Math.min(1, DET_LIMIT_SIDE / Math.max(src.cols, src.rows));
    const w = Math.max(32, Math.round((src.cols * ratio) / 32) * 32);
    const h = Math.max(32, Math.round((src.rows * ratio) / 32) * 32);

    const resized = new cv.Mat();
    cv.resize(src, resized, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
    const data = resized.data; // RGBA
    const input = new Float32Array(3 * w * h);
    const plane = w * h;
    for (let i = 0; i < plane; i++) {
      const r = data[i * 4] / 255;
      const g = data[i * 4 + 1] / 255;
      const b = data[i * 4 + 2] / 255;
      // 模型輸入是 BGR 順序
      input[i] = (b - DET_MEAN[0]) / DET_STD[0];
      input[plane + i] = (g - DET_MEAN[1]) / DET_STD[1];
      input[plane * 2 + i] = (r - DET_MEAN[2]) / DET_STD[2];
    }
    resized.delete();

    const feeds = { [this.det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) };
    const out = await this.det.run(feeds);
    const prob = out[this.det.outputNames[0]].data; // [1,1,h,w]

    return this.#dbPostProcess(prob, w, h, src.cols / w, src.rows / h);
  }

  #dbPostProcess(prob, w, h, sx, sy) {
    const cv = this.cv;
    const probMat = cv.matFromArray(h, w, cv.CV_32F, prob);
    const bitmap = new cv.Mat(h, w, cv.CV_8U);
    const bd = bitmap.data;
    for (let i = 0; i < prob.length; i++) bd[i] = prob[i] > DET_THRESH ? 255 : 0;

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(bitmap, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const boxes = [];
    const n = Math.min(contours.size(), DET_MAX_CANDIDATES);
    for (let i = 0; i < n; i++) {
      const c = contours.get(i);
      const rect = cv.minAreaRect(c);
      if (Math.min(rect.size.width, rect.size.height) < 3) { c.delete(); continue; }

      // 文字框分數：框內機率的平均值
      const br = cv.boundingRect(c);
      const roi = probMat.roi(br);
      const mask = cv.Mat.zeros(br.height, br.width, cv.CV_8U);
      const shifted = new cv.MatVector();
      const pts = new cv.Mat(c.rows, 1, cv.CV_32SC2);
      for (let j = 0; j < c.rows; j++) {
        pts.data32S[j * 2] = c.data32S[j * 2] - br.x;
        pts.data32S[j * 2 + 1] = c.data32S[j * 2 + 1] - br.y;
      }
      shifted.push_back(pts);
      cv.fillPoly(mask, shifted, new cv.Scalar(1));
      const score = cv.mean(roi, mask)[0];
      roi.delete(); mask.delete(); shifted.delete(); pts.delete(); c.delete();
      if (score < DET_BOX_THRESH) continue;

      // unclip：長方形往外擴 distance = 面積 × ratio / 周長
      const rw = rect.size.width;
      const rh = rect.size.height;
      const dist = (rw * rh * DET_UNCLIP_RATIO) / (2 * (rw + rh));
      const grown = { center: rect.center, size: { width: rw + 2 * dist, height: rh + 2 * dist }, angle: rect.angle };
      if (Math.min(grown.size.width, grown.size.height) < 5) continue;

      const corners = cv.RotatedRect.points(grown).map((p) => ({
        x: Math.min(Math.max(p.x * sx, 0), w * sx - 1),
        y: Math.min(Math.max(p.y * sy, 0), h * sy - 1),
      }));
      boxes.push(orderQuad(corners));
    }
    probMat.delete(); bitmap.delete(); contours.delete(); hierarchy.delete();

    // 由上到下、由左到右排序
    boxes.sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x);
    return boxes;
  }

  // 把四邊形文字區域切出來並轉正，回傳 RGBA 的 cv.Mat。
  #cropBox(src, box) {
    const cv = this.cv;
    const [tl, tr, br, bl] = box;
    const width = Math.max(1, Math.round(Math.max(Math.hypot(tr.x - tl.x, tr.y - tl.y), Math.hypot(br.x - bl.x, br.y - bl.y))));
    const height = Math.max(1, Math.round(Math.max(Math.hypot(bl.x - tl.x, bl.y - tl.y), Math.hypot(br.x - tr.x, br.y - tr.y))));
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    let crop = new cv.Mat();
    cv.warpPerspective(src, crop, M, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    srcPts.delete(); dstPts.delete(); M.delete();
    // 直的文字框轉 90 度
    if (height / width >= 1.5) {
      const rotated = new cv.Mat();
      cv.rotate(crop, rotated, cv.ROTATE_90_COUNTERCLOCKWISE);
      crop.delete();
      crop = rotated;
    }
    return crop;
  }

  // 辨識一個文字框，回傳 { text, score }。
  async recognize(src, box) {
    const cv = this.cv;
    const ort = window.ort;
    const crop = this.#cropBox(src, box);
    const ratio = crop.cols / crop.rows;
    const targetW = Math.min(REC_MAX_WIDTH, Math.max(REC_MIN_WIDTH, Math.ceil(REC_HEIGHT * ratio)));
    const resizedW = Math.min(targetW, Math.ceil(REC_HEIGHT * ratio));

    const resized = new cv.Mat();
    cv.resize(crop, resized, new cv.Size(resizedW, REC_HEIGHT), 0, 0, cv.INTER_LINEAR);
    crop.delete();

    const plane = REC_HEIGHT * targetW;
    const input = new Float32Array(3 * plane); // 右邊補 0
    const d = resized.data;
    for (let y = 0; y < REC_HEIGHT; y++) {
      for (let x = 0; x < resizedW; x++) {
        const si = (y * resizedW + x) * 4;
        const di = y * targetW + x;
        input[di] = (d[si + 2] / 255 - 0.5) / 0.5; // B
        input[plane + di] = (d[si + 1] / 255 - 0.5) / 0.5; // G
        input[plane * 2 + di] = (d[si] / 255 - 0.5) / 0.5; // R
      }
    }
    resized.delete();

    const feeds = { [this.rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, REC_HEIGHT, targetW]) };
    const out = await this.rec.run(feeds);
    const t = out[this.rec.outputNames[0]];
    const [, steps, classes] = t.dims;

    if (!this.chars) {
      // CTC：索引 0 是 blank；模型多一類時最後一類是空白字元
      this.chars = ['', ...this.dict];
      if (classes === this.dict.length + 2) this.chars.push(' ');
    }

    return ctcDecode(t.data, steps, classes, this.chars);
  }
}

// CTC 解碼。回傳：
// - text、score：每個字取機率最高的字，score 是這些機率的平均。
// - candidates：整段文字的前 3 名候選 [{ text, score }]，第 1 名就是 text。
//   每個字位置取機率最高的前 5 個字（不含空白），組合後依平均機率排序。
export function ctcDecode(probs, steps, classes, chars, topK = 3, perChar = 5) {
  let text = '';
  let prev = -1;
  let scoreSum = 0;
  let count = 0;
  const positions = [];
  for (let s = 0; s < steps; s++) {
    let best = 0;
    let bestP = -Infinity;
    const off = s * classes;
    for (let c = 0; c < classes; c++) {
      const p = probs[off + c];
      if (p > bestP) { bestP = p; best = c; }
    }
    if (best !== 0 && best !== prev) {
      text += chars[best] ?? '';
      scoreSum += bestP;
      count++;
      // 這個字位置的前幾名候選字（跟 score 用同一個時間點）
      const ranked = [];
      for (let c = 1; c < classes; c++) {
        const p = probs[off + c];
        if (ranked.length < perChar || p > ranked[ranked.length - 1].p) {
          ranked.push({ ch: chars[c] ?? '', p });
          ranked.sort((a, b) => b.p - a.p);
          if (ranked.length > perChar) ranked.pop();
        }
      }
      positions.push(ranked);
    }
    prev = best;
  }

  // beam search：一個字一個字展開，只留機率總和最高的 topK 個組合
  let beams = [{ text: '', sum: 0 }];
  for (const ranked of positions) {
    const next = [];
    for (const b of beams) for (const r of ranked) next.push({ text: b.text + r.ch, sum: b.sum + r.p });
    next.sort((a, b) => b.sum - a.sum);
    beams = [];
    for (const n of next) {
      if (!beams.some((b) => b.text === n.text)) beams.push(n);
      if (beams.length === topK) break;
    }
  }
  const candidates = count ? beams.map((b) => ({ text: b.text, score: b.sum / count })) : [];
  return { text, score: count ? scoreSum / count : 0, candidates };
}
