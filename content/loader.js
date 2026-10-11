// 모든 페이지에 붙는 아주 작은 스크립트.
// 켜 둔 사이트일 때만 백그라운드가 본체(core.js)를 넣어 준다.
(function () {
    'use strict';
    if (window.__CSP_LOADER__) return;
    window.__CSP_LOADER__ = true;
    try {
        chrome.runtime.sendMessage({ type: 'loader.hello' }, () => void chrome.runtime.lastError);
    } catch (_) { /* 확장이 막 업데이트된 경우 */ }
})();
