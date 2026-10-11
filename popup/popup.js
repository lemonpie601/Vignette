'use strict';
// 툴바 팝업 = 확장 패널
//  · 사이트 켜기/끄기 · 이 사이트 추가
//  · 메뉴 위치 선택 (플로팅 버튼 / 확장 패널 / 둘 다)
//  · 확장 패널 모드면 플로팅 버튼 메뉴와 같은 항목을 여기서 바로 쓴다
const P = globalThis.CSP_PLATFORMS;
const UI_MODE_KEY = 'csp_ui_mode_v1';
const root = document.getElementById('root');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
    wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    images: '<path d="M18 22H4a2 2 0 0 1-2-2V6"/><path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18"/><circle cx="12" cy="8" r="2"/><rect width="16" height="16" x="6" y="2" rx="2"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    crosshair: '<circle cx="12" cy="12" r="10"/><path d="M22 12h-4"/><path d="M6 12H2"/><path d="M12 6V2"/><path d="M12 22v-4"/>',
    footer: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/><path d="M8 19h.01"/><path d="M12 19h.01"/>',
    userx: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5"/><path d="m22 8-5 5"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'
};
const icon = (n) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;
const item = (act, ic, label, extra = '', disabled = false) => `<button type="button" class="item" data-act="${act}" ${disabled ? 'disabled' : ''}>${icon(ic)}<span>${label}</span>${extra}</button>`;

let tab = null;

async function getSites() {
    return (await chrome.storage.local.get(P.SITES_KEY))[P.SITES_KEY] || {};
}

function askTab(action, payload) {
    return new Promise((resolve) => {
        if (!tab) { resolve(null); return; }
        chrome.tabs.sendMessage(tab.id, { type: 'csp.panel', action, payload }, (res) => {
            void chrome.runtime.lastError;
            resolve(res?.ok ? res.result : null);
        });
    });
}

function modeSegHtml(mode) {
    const opt = (v, label) => `<button type="button" data-mode="${v}" class="${mode === v ? 'on' : ''}">${label}</button>`;
    return `<div class="label">메뉴 열기</div>
        <div class="seg" role="radiogroup" aria-label="메뉴 열기 방식">${opt('fab', '플로팅 버튼')}${opt('panel', '확장 패널')}${opt('both', '둘 다')}</div>`;
}

async function render() {
    const store = await chrome.storage.local.get([P.SITES_KEY, UI_MODE_KEY, 'ls:csp_ext_theme']);
    const th = store['ls:csp_ext_theme'] || 'warm';
    document.documentElement.dataset.theme = (th === 'auto' || th === 'site') ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'warm') : th;
    const mode = store[UI_MODE_KEY] || 'fab';
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let url = null;
    try { url = new URL(tab?.url || ''); } catch (_) {}

    const foot = `<div class="sep"></div>${modeSegHtml(mode)}${item('manager', 'external', '관리 페이지 열기')}`;

    if (!url || !/^https?:$/.test(url.protocol)) {
        root.innerHTML = `<div class="note">채팅 사이트 탭에서 열면 메뉴가 나와요.</div>${foot}`;
        bindCommon();
        return;
    }
    const sites = store[P.SITES_KEY] || {};
    const platform = P.matchPlatform(url, sites);
    if (!platform) {
        root.innerHTML = `
            <div class="card"><div class="toggle"><span class="t"><span class="host">${esc(url.hostname)}</span><small>등록되지 않은 사이트예요. 켜면 메뉴에서 본문 · 하단 위치를 지정해서 쓸 수 있어요.</small></span></div></div>
            <button class="btn primary wide" id="add-site">이 사이트에서 사용하기</button>${foot}`;
        document.getElementById('add-site').onclick = async () => {
            const host = url.hostname.replace(/^www\./, '');
            const id = P.sanitizeId(host);
            const all = await getSites();
            all[id] = { id, name: host, hosts: [host], chatPath: '', mode: 'generic', enabled: true, custom: true, userEdited: true, messageSelector: '', bodySelector: '', footerSelector: '', userSelector: '', idAttribute: '' };
            await chrome.storage.local.set({ [P.SITES_KEY]: all });
            await chrome.runtime.sendMessage({ type: 'site.inject', payload: { tabId: tab.id } });
            setTimeout(render, 600);
        };
        bindCommon();
        return;
    }

    const enabled = platform.enabled !== false;
    const state = enabled ? await askTab('state') : null;
    const siteSwitch = `<div class="card"><label class="toggle"><span class="t">${esc(platform.name || platform.id)}<small>${esc(url.hostname)} · 이 사이트에서 사용</small></span><span class="switch"><input type="checkbox" id="site-enabled" ${enabled ? 'checked' : ''}><span></span></span></label></div>`;

    if (!enabled) {
        root.innerHTML = siteSwitch + foot;
    } else if (!state) {
        root.innerHTML = siteSwitch + `<div class="note">페이지를 새로고침하면 메뉴가 연결돼요.</div>` + foot;
    } else if (!state.isChatRoom) {
        root.innerHTML = siteSwitch + `<div class="note">채팅방에 들어가면 삽화 메뉴가 나와요.</div>` + foot;
    } else if (mode === 'fab') {
        root.innerHTML = siteSwitch + `<div class="note">메뉴는 화면 오른쪽 아래 🎨 플로팅 버튼에 있어요. 여기서 쓰려면 아래에서 ‘확장 패널’이나 ‘둘 다’를 골라 주세요.</div>` + foot;
    } else {
        const on = state.enabled;
        const count = state.galleryCount ? `<em class="count">${state.galleryCount > 999 ? '999+' : state.galleryCount}</em>` : '';
        // 지정됨 ✓(초록) · 안 됨 ✕(빨강)
        const mark = (v) => v ? '<em class="count is-set">✓</em>' : '<em class="count is-unset" title="아직 지정 안 됨">✕</em>';
        const keyWarn = state.naiKeyReady === false
            ? `<button type="button" class="item" data-act="keys" style="margin-top:6px;background:color-mix(in srgb, var(--warn) 14%, var(--surface));color:var(--warn);font-weight:700">${icon('settings')}<span>NovelAI 키가 없어요 — 공통 설정에서 넣기</span></button>`
            : '';
        root.innerHTML = siteSwitch + keyWarn + `
            <div class="card" style="margin-top:6px">
                <label class="toggle"><span class="t">켜기<small>답변 아래 삽화 버튼 표시</small></span><span class="switch"><input type="checkbox" id="pp-enabled" ${on ? 'checked' : ''}><span></span></span></label>
                <label class="toggle"><span class="t">퀵 패널<small>화면에 떠 있는 작은 조작판</small></span><span class="switch"><input type="checkbox" id="pp-quick" ${state.quickPanel ? 'checked' : ''}><span></span></span></label>
            </div>
            <div class="sep"></div>
            ${item('generate', 'wand', '마지막 답변 삽화', '', !on)}
            ${item('speed', 'zap', '스피드 생성', '', !on)}
            <div class="sep"></div>
            ${item('gallery', 'images', '갤러리', count)}
            ${item('settings', 'settings', '설정')}
            <div class="sep"></div>
            <div class="site"><b>${esc(state.platformName)}</b><span class="${state.dom?.ok ? 'ok' : 'warn'}">${esc(state.dom?.text || '')}</span></div>
            ${item('pick-body', 'crosshair', '본문 위치 지정', mark(state.hasBody))}
            ${item('pick-footer', 'footer', '하단 위치 지정', mark(state.hasFooter))}
            ${item('pick-user', 'userx', '내 메시지 제외 지정', mark(state.hasUser))}
            ${item('check', 'check', '위치 확인 · 자동 진단')}
            ${item('reset-site', 'refresh', '위치 초기화')}
            ${state.isUnivers ? item('import-legacy', 'download', '유저스크립트 기록 가져오기') : ''}
            ${foot}`;
        document.getElementById('pp-enabled').onchange = async (e) => {
            await askTab('toggle-enabled', { value: e.target.checked });
            document.querySelectorAll('[data-act="generate"], [data-act="speed"]').forEach(b => { b.disabled = !e.target.checked; });
        };
        document.getElementById('pp-quick').onchange = (e) => askTab('toggle-quick', { value: e.target.checked });
    }

    const siteEnabled = document.getElementById('site-enabled');
    if (siteEnabled) siteEnabled.onchange = async (e) => {
        const all = await getSites();
        all[platform.id] = { ...(all[platform.id] || platform), enabled: e.target.checked };
        await chrome.storage.local.set({ [P.SITES_KEY]: all });
        if (e.target.checked) await chrome.runtime.sendMessage({ type: 'site.inject', payload: { tabId: tab.id } });
        else chrome.tabs.reload(tab.id);
        setTimeout(render, 700);
    };
    bindCommon();
}

function bindCommon() {
    root.querySelectorAll('[data-mode]').forEach(b => b.onclick = async () => {
        await chrome.storage.local.set({ [UI_MODE_KEY]: b.dataset.mode });
        render();
    });
    root.querySelectorAll('.item[data-act]').forEach(b => b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'manager' || act === 'keys') {
            await chrome.runtime.sendMessage({ type: 'manager.open', payload: act === 'keys' ? { hash: 'keys' } : {} });
            window.close();
            return;
        }
        // 페이지 쪽 동작(생성 · 갤러리 · 설정 · 위치 지정)은 팝업을 닫고 페이지에서 이어진다
        await askTab(act);
        window.close();
    });
}

try { document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) {}
render();
