// 等 vendor/opencv.js 載入並初始化完成，回傳 cv 物件。
export function waitForOpenCV(timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let promiseHooked = false;

    const tick = () => {
      const c = window.cv;
      if (c && typeof c.Mat === 'function') {
        // Emscripten 的 Module 物件帶有 then 方法；直接 resolve(c) 會讓 Promise
        // 一直呼叫 c.then，形成無限的 microtask 迴圈，把主執行緒卡死。
        if (typeof c.then === 'function') delete c.then;
        resolve(c);
        return;
      }
      // 有些版本的 opencv.js 把 cv 設成 Promise
      if (c && c instanceof Promise && !promiseHooked) {
        promiseHooked = true;
        c.then((mod) => {
          if (mod && typeof mod.then === 'function') delete mod.then;
          window.cv = mod;
        });
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('OpenCV.js 載入逾時'));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}
