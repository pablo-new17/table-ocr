// 從 PP-OCRv5 辨識模型的 inference.yml 取出 character_dict，存成 JSON 陣列。
// 用法：node tools/extract-dict.mjs vendor/ppocrv5_rec.yml vendor/ppocrv5_dict.json
import { readFileSync, writeFileSync } from 'node:fs';

const [, , src, dst] = process.argv;
if (!src || !dst) {
  console.error('用法：node tools/extract-dict.mjs <inference.yml> <輸出.json>');
  process.exit(1);
}

const lines = readFileSync(src, 'utf8').split(/\r?\n/);
const start = lines.indexOf('  character_dict:');
if (start < 0) {
  console.error('找不到 character_dict');
  process.exit(1);
}

const dict = [];
for (let i = start + 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.startsWith('  - ')) break;
  let value = line.slice(4);
  // YAML 單引號字串：'x'，裡面的單引號寫成 ''
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1).replace(/''/g, "'");
  } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = JSON.parse(value);
  }
  dict.push(value);
}

writeFileSync(dst, JSON.stringify(dict));
console.log(`字典共 ${dict.length} 個字元，已寫入 ${dst}`);
