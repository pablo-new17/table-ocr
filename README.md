# 表格 OCR

用手機拍表格文件，在瀏覽器裡轉成表格並匯出 `.xlsx`。全部在手機上處理，第一次連線打開網頁之後，斷線也能使用。

## 功能

- 拍照或從相簿選照片
- 自動校正拍歪的角度
- 找出表格框線，把文字放進對應的格子（目前支援有框線、沒有合併儲存格的表格）
- 用 PP-OCRv5 辨識繁體中文、數字，印刷字與手寫字
- 網頁上可以直接修改每一格，再匯出 `.xlsx`
- iPhone 從主畫面圖示打開時，用分享選單存檔

## 技術

| 用途 | 函式庫 | 檔案 |
|---|---|---|
| 文字偵測與辨識 | PP-OCRv5 mobile（ONNX） | `vendor/ppocrv5_det.onnx`、`vendor/ppocrv5_rec.onnx`、`vendor/ppocrv5_dict.json` |
| 執行 ONNX 模型 | onnxruntime-web 1.31.1 | `vendor/ort.wasm.min.js`、`vendor/ort-wasm-simd-threaded.*` |
| 影像處理、找框線 | OpenCV.js 4.10.0 | `vendor/opencv.js` |
| 匯出 `.xlsx` | SheetJS 0.20.3 | `vendor/xlsx.full.min.js` |
| 離線 | Service Worker | `sw.js` |

## 本機測試

```powershell
node tools/serve.mjs 8080
```

- 網頁：`http://localhost:8080/`
- 自動測試：`http://localhost:8080/tests/selftest.html`

## 更新版本

改了任何檔案之後，把 `sw.js` 的 `CACHE_VERSION` 加 1，手機下次連線時才會下載新版。

## 重新產生的檔案

- `vendor/ppocrv5_dict.json`：`node tools/extract-dict.mjs vendor/ppocrv5_rec.yml vendor/ppocrv5_dict.json`
- `icon-192.png`、`icon-512.png`：`powershell -File tools/make-icons.ps1`

## 授權

第三方函式庫與模型的授權見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
