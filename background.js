// Scene Painter 확장 — 백그라운드 서비스 워커
//  · 사이트마다 코어 스크립트 주입 (켜진 사이트만)
//  · GM_xmlhttpRequest 대리 요청 (CORS 우회 — 페이지 대신 확장이 API를 부른다)
//  · 이미지/메타 저장소 (확장 origin의 IndexedDB → 관리 페이지와 공유)
'use strict';

importScripts('shared/platforms.js', 'shared/imagedb.js');

const { BUILTIN_PLATFORMS, matchPlatform, SITES_KEY } = self.CSP_PLATFORMS;

// ── 사이트 주입 ─────────────────────────────────────────────
const CORE_FILES = ['lib/fflate.js', 'shared/platforms.js', 'content/bootstrap.js', 'content/core.js'];

async function getSiteConfig() {
    const res = await chrome.storage.local.get(SITES_KEY);
    return res[SITES_KEY] || {};
}

async function injectCore(tabId, frameId = 0) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            files: CORE_FILES
        });
        return { ok: true };
    } catch (err) {
        console.info('[Vignette] inject failed', err);
        return { ok: false, error: String(err?.message || err) };
    }
}

// ── 권한 ─────────────────────────────────────────────────────
// 기본 지원 사이트와 알려진 AI API 주소는 매니페스트에서 미리 받는다.
// 사용자가 추가한 사이트 · 사용자 지정 API 주소는 쓸 때 그 주소만 허락받는다 (optional_host_permissions).
function hasOriginPermission(origin) {
    return chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false);
}

// ── GM_xmlhttpRequest 대리 ────────────────────────────────────
function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'csp-xhr') return;
    const controller = new AbortController();
    let timer = 0;
    let finished = false;
    const send = (msg) => { if (!finished) { try { port.postMessage(msg); } catch (_) {} } };
    port.onDisconnect.addListener(() => { finished = true; controller.abort(); clearTimeout(timer); });
    port.onMessage.addListener(async (req) => {
        if (req?.type === 'abort') { controller.abort(); return; }
        if (req?.type !== 'request') return;
        const { method = 'GET', url, headers = {}, data, responseType = 'text', timeout = 0 } = req;
        // 기본 목록에 없는 주소(사용자 지정 API 등)는 사용자가 허용해야 접속할 수 있다.
        // 허용이 없으면 막연한 네트워크 오류 대신 "어느 주소를 허용해야 하는지"를 돌려준다.
        let origin = '';
        try { origin = new URL(url).origin; } catch (_) {}
        if (origin && !(await hasOriginPermission(origin))) {
            send({ type: 'error', error: `NO_PERMISSION ${origin}` });
            finished = true;
            try { port.disconnect(); } catch (_) {}
            return;
        }
        if (timeout > 0) timer = setTimeout(() => { send({ type: 'timeout' }); finished = true; controller.abort(); }, timeout);
        try {
            const init = { method, headers, signal: controller.signal, credentials: 'omit' };
            if (data != null && !/^(GET|HEAD)$/i.test(method)) init.body = data;
            const res = await fetch(url, init);
            const headerLines = [];
            res.headers.forEach((v, k) => headerLines.push(`${k}: ${v}`));
            const base = {
                status: res.status,
                statusText: res.statusText,
                finalUrl: res.url,
                responseHeaders: headerLines.join('\r\n')
            };
            if (responseType === 'arraybuffer' || responseType === 'blob') {
                const buf = await res.arrayBuffer();
                // 실패 응답도 사람이 읽을 수 있게 텍스트를 같이 넘긴다
                let text = '';
                if (res.status >= 400) { try { text = new TextDecoder().decode(buf); } catch (_) {} }
                send({ type: 'load', ...base, responseText: text, base64: bufToBase64(buf), contentType: res.headers.get('content-type') || '' });
            } else {
                const text = await res.text();
                send({ type: 'load', ...base, responseText: text });
            }
        } catch (err) {
            if (controller.signal.aborted) send({ type: 'abort' });
            else send({ type: 'error', error: String(err?.message || err) });
        } finally {
            clearTimeout(timer);
            finished = true;
            try { port.disconnect(); } catch (_) {}
        }
    });
});

// ── 메시지 RPC ────────────────────────────────────────────────
const handlers = {
    async 'img.put'({ id, dataUrl, meta }) { await CSP_IMAGEDB.putImage(id, dataUrl, meta); return true; },
    async 'img.get'({ id }) { return await CSP_IMAGEDB.getImage(id); },
    async 'img.delete'({ id }) { await CSP_IMAGEDB.deleteImage(id); return true; },
    async 'meta.put'({ id, value }) { await CSP_IMAGEDB.putMeta(id, value); return true; },
    async 'meta.get'({ id }) { return await CSP_IMAGEDB.getMeta(id); },
    async 'meta.delete'({ id }) { await CSP_IMAGEDB.deleteMeta(id); return true; },
    async 'manager.open'({ hash } = {}) {
        const url = chrome.runtime.getURL('manager/manager.html') + (hash ? `#${hash}` : '');
        const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('manager/manager.html') + '*' });
        if (existing.length) {
            await chrome.tabs.update(existing[0].id, { active: true, url });
            await chrome.windows.update(existing[0].windowId, { focused: true });
        } else {
            await chrome.tabs.create({ url });
        }
        return true;
    },
    // 저장 공간: 설정·기록(chrome.storage) + 이미지(IndexedDB)를 합쳐서 알려 준다
    async 'storage.report'({ roomKey } = {}) {
        const all = await chrome.storage.local.get(null);
        let settingsBytes = 0;
        let roomSettingsBytes = 0;
        for (const [k, v] of Object.entries(all)) {
            const size = k.length + (typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length);
            settingsBytes += size;
            if (roomKey && k.endsWith('_' + roomKey)) roomSettingsBytes += size;
        }
        const images = await CSP_IMAGEDB.listImageInfo();
        let imageBytes = 0; let roomImageBytes = 0; let roomImageCount = 0;
        for (const img of images) {
            // dataUrl(base64) 글자 수 ≈ 실제 바이트의 4/3
            const bytes = Math.round((img.size || 0) * 0.75);
            imageBytes += bytes;
            if (roomKey && (img.roomKey === roomKey || String(img.id).startsWith(roomKey + '::'))) { roomImageBytes += bytes; roomImageCount++; }
        }
        return { settingsBytes, imageBytes, imageCount: images.length, totalBytes: settingsBytes + imageBytes, roomSettingsBytes, roomImageBytes, roomImageCount };
    },
    // 팝업/관리 페이지에서 "이 사이트에서 사용하기" — 사이트 설정만 저장한다.
    // 실제 적용은 접근 허용이 생기는 순간(permissions.onAdded) 또는 다음 페이지 로드 때.
    async 'site.addCustom'({ host, tabId }) {
        const clean = String(host || '').trim().replace(/^www\./, '');
        if (!clean) return false;
        const id = self.CSP_PLATFORMS.sanitizeId(clean);
        const sites = await getSiteConfig();
        if (!sites[id]) {
            sites[id] = { id, name: clean, hosts: [clean], chatPath: '', mode: 'generic', enabled: true, custom: true, userEdited: true,
                messageSelector: '', bodySelector: '', footerSelector: '', userSelector: '', idAttribute: '' };
        } else {
            sites[id] = { ...sites[id], enabled: true };
        }
        await chrome.storage.local.set({ [SITES_KEY]: sites });
        // 이미 허용돼 있으면 바로 적용
        if (tabId != null) {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (tab?.url && await hasOriginPermission(new URL(tab.url).origin)) await injectCore(tabId, 0);
        }
        return true;
    },
    async 'site.inject'({ tabId }, sender) {
        return await injectCore(tabId ?? sender.tab?.id);
    }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const fn = handlers[msg?.type];
    if (!fn) return false;
    Promise.resolve()
        .then(() => fn(msg.payload || {}, sender))
        .then(result => sendResponse({ ok: true, result }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
});

// 페이지마다 가벼운 loader.js가 "여기서 켜야 하냐"를 묻는다.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'loader.hello' || !sender.tab) return false;
    (async () => {
        const sites = await getSiteConfig();
        const platform = matchPlatform(new URL(sender.url || sender.tab.url), sites);
        if (!platform || !platform.enabled) { sendResponse({ inject: false }); return; }
        const r = await injectCore(sender.tab.id, sender.frameId || 0);
        sendResponse({ inject: r.ok });
    })();
    return true;
});

// 사용자가 추가한 사이트: 모든 페이지에 스크립트를 넣지 않고, 그 사이트 페이지가 열릴 때만
// (그리고 사용자가 그 사이트 접근을 허용했을 때만) 본체를 넣는다.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status !== 'complete' || !tab.url || !/^https?:/.test(tab.url)) return;
    try {
        const url = new URL(tab.url);
        const sites = await getSiteConfig();
        const platform = matchPlatform(url, sites);
        if (!platform || !platform.enabled || !platform.custom) return;   // 기본 사이트는 loader.js가 맡는다
        if (!(await hasOriginPermission(url.origin))) return;
        await injectCore(tabId, 0);
    } catch (_) { /* 탭이 닫혔거나 권한 없음 */ }
});

// 사용자가 사이트 접근을 허용하면, 이미 열려 있는 그 사이트 탭에 바로 적용
chrome.permissions.onAdded.addListener(async (perms) => {
    const origins = perms?.origins || [];
    if (!origins.length) return;
    const sites = await getSiteConfig();
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!tab.url || !/^https?:/.test(tab.url)) continue;
        let url;
        try { url = new URL(tab.url); } catch (_) { continue; }
        const platform = matchPlatform(url, sites);
        if (!platform?.enabled || !platform.custom) continue;
        if (await hasOriginPermission(url.origin)) injectCore(tab.id, 0);
    }
});

chrome.runtime.onInstalled.addListener(async () => {
    // 내장 플랫폼 기본값을 깔거나 새 버전 값으로 갱신한다.
    // 사용자가 직접 고친 사이트(userEdited)는 건드리지 않는다. 켜짐/꺼짐은 항상 유지.
    const sites = await getSiteConfig();
    for (const p of BUILTIN_PLATFORMS) {
        const prev = sites[p.id];
        if (prev?.userEdited) continue;
        sites[p.id] = { ...p, enabled: prev ? prev.enabled !== false : true };
    }
    await chrome.storage.local.set({ [SITES_KEY]: sites });
});
