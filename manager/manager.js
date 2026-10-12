// Scene Painter 관리 페이지
// 플랫폼별 · 채팅별 보관함, 갤러리, 사이트 위치 설정, 백업/복원, 환경설정
'use strict';

const P = globalThis.CSP_PLATFORMS;
const DB = globalThis.CSP_IMAGEDB;
const LS = 'ls:';
const CSP_PREFIX = 'csp_scene_painter';
const ROOM_SETTINGS = `${CSP_PREFIX}_room_settings_`;
const SCENE_RECORDS = `${CSP_PREFIX}_scene_records_`;
const GLOBAL_SETTINGS = `${CSP_PREFIX}_global_settings`;
const CHATS_KEY = 'csp_chats_v1';
const GZ = '__CSP_JSON_GZIP_V1__';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
    store: {},        // chrome.storage.local 전체
    sites: {},
    chats: {},
    images: [],       // dataUrl 없는 목록
    rooms: new Map(), // roomKey → 방 요약
    filter: 'all',
    query: '',
    showEmpty: false,          // 삽화 없는 채팅도 보기
    collapsed: new Set(),      // 접은 플랫폼
    limit: new Map()           // 플랫폼별로 보여 줄 개수 (더 보기)
};
const PAGE = 24;

// ── 유틸 ─────────────────────────────────────────────────────
function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function fmtDate(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(bytes) {
    const kb = bytes / 1024;
    if (kb < 1024) return `${Math.max(1, Math.round(kb))}KB`;
    return `${(kb / 1024).toFixed(1)}MB`;
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

function decodeJson(raw, fallback = {}) {
    const s = String(raw || '');
    if (!s) return fallback;
    try {
        if (s.startsWith(GZ)) return JSON.parse(fflate.strFromU8(fflate.gunzipSync(b64ToBytes(s.slice(GZ.length)))));
        return JSON.parse(s);
    } catch (_) { return fallback; }
}

function encodeJson(value) {
    const json = JSON.stringify(value ?? {});
    try {
        const enc = GZ + bytesToB64(fflate.gzipSync(fflate.strToU8(json)));
        return enc.length < json.length ? enc : json;
    } catch (_) { return json; }
}

// 예전 유저스크립트 이미지 ID는 "<uuid>::<messageKey>" — 유니챗 방으로 본다.
function roomKeyOfImage(img) {
    if (img.roomKey) return img.roomKey;
    const prefix = String(img.id || '').split('::')[0];
    if (!prefix) return 'global_room';
    return prefix.includes('__') || prefix === 'global_room' ? prefix : `univers__${prefix}`;
}

function platformName(id) {
    return state.sites[id]?.name || P.BUILTIN_PLATFORMS.find(p => p.id === id)?.name || (id === 'legacy' ? '기타' : id);
}

function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function dataUrlToBytes(dataUrl) {
    const m = String(dataUrl).match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) return { bytes: new Uint8Array(), mime: '' };
    const mime = m[1] || 'application/octet-stream';
    const bytes = m[2] ? b64ToBytes(m[3]) : fflate.strToU8(decodeURIComponent(m[3]));
    return { bytes, mime };
}

function extOf(mime) {
    return /png/.test(mime) ? 'png' : /webp/.test(mime) ? 'webp' : /jpe?g/.test(mime) ? 'jpg' : 'bin';
}

// ── 데이터 읽기 ──────────────────────────────────────────────
async function loadAll() {
    state.store = await chrome.storage.local.get(null);
    state.sites = state.store[P.SITES_KEY] || {};
    state.chats = state.store[CHATS_KEY] || {};
    state.images = await DB.listImageInfo().catch(() => []);
    buildRooms();
    renderNavCounts();
    renderUsage();
    applyTheme();
}

// 장면 기록은 압축돼 있어서 개수를 세려면 풀어야 한다. 값이 그대로면 지난 결과를 쓴다.
const recordCountCache = new Map();
function recordCountOf(key, raw) {
    const s = String(raw || '');
    const sig = s.length + ':' + s.slice(-24);
    const hit = recordCountCache.get(key);
    if (hit && hit.sig === sig) return hit.count;
    const count = Object.keys(decodeJson(s, {})).length;
    recordCountCache.set(key, { sig, count });
    return count;
}

function buildRooms() {
    const rooms = new Map();
    const ensure = (roomKey) => {
        if (!rooms.has(roomKey)) {
            const { platformId, chatId } = roomKey === 'global_room' ? { platformId: 'legacy', chatId: '채팅방 밖' } : P.parseRoomKey(roomKey);
            rooms.set(roomKey, { roomKey, platformId, chatId, title: '', url: '', lastVisited: 0, firstSeen: 0, images: [], recordCount: 0, bytes: 0, hasSettings: false });
        }
        return rooms.get(roomKey);
    };
    for (const [k, v] of Object.entries(state.store)) {
        if (!k.startsWith(LS)) continue;
        const key = k.slice(LS.length);
        if (key.startsWith(ROOM_SETTINGS)) {
            const r = ensure(key.slice(ROOM_SETTINGS.length));
            r.hasSettings = true;
            r.bytes += String(v).length;
        } else if (key.startsWith(SCENE_RECORDS)) {
            const r = ensure(key.slice(SCENE_RECORDS.length));
            r.recordCount = recordCountOf(key, v);
            r.bytes += String(v).length;
        }
    }
    for (const c of Object.values(state.chats)) {
        const r = ensure(c.roomKey);
        Object.assign(r, { title: c.title || '', url: c.url || '', lastVisited: c.lastVisited || 0, firstSeen: c.firstSeen || 0, platformId: c.platformId || r.platformId });
    }
    for (const img of state.images) {
        const r = ensure(roomKeyOfImage(img));
        r.images.push(img);
        r.bytes += Math.round((img.size || 0) * 0.75);
        r.lastImageAt = Math.max(r.lastImageAt || 0, img.createdAt || 0);
    }
    rooms.forEach(r => r.images.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
    state.rooms = rooms;
    pruneEmptyIndex();
}

// 예전 버전은 들어가 본 채팅을 전부 색인에 적었다. 이미지 · 기록 · 방 설정이 하나도 없는
// 색인 항목은 보관할 게 없으니 지운다. (실제 데이터는 건드리지 않는다)
let pruning = false;
async function pruneEmptyIndex() {
    if (pruning) return;
    const empty = Array.from(state.rooms.values()).filter(r => !r.images.length && !r.recordCount && !r.hasSettings && state.chats[r.roomKey]);
    if (!empty.length) return;
    pruning = true;
    try {
        const chats = (await chrome.storage.local.get(CHATS_KEY))[CHATS_KEY] || {};
        empty.forEach(r => { delete chats[r.roomKey]; state.rooms.delete(r.roomKey); });
        await chrome.storage.local.set({ [CHATS_KEY]: chats });
    } finally { pruning = false; }
}

const hasImages = (r) => r.images.length > 0;

function renderNavCounts() {
    $('#nav-chats').textContent = Array.from(state.rooms.values()).filter(hasImages).length || '';
    $('#nav-images').textContent = state.images.length || '';
    const ks = keyStatus();
    const navKeys = $('#nav-keys');
    navKeys.textContent = ks.nai && ks.analysis ? '' : '!';
    navKeys.className = ks.nai && ks.analysis ? '' : 'is-warn';
}

// 예전엔 navigator.storage.estimate()만 써서 "20KB"처럼 나왔다 — 그건 설정·기록(chrome.storage)이
// 빠지고, 이미지도 아직 디스크에 다 반영되기 전 값이라 실제와 달랐다. 직접 더해서 보여 준다.
function storageBreakdown() {
    let settings = 0;
    for (const [k, v] of Object.entries(state.store)) settings += k.length + (typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length);
    const images = state.images.reduce((s, i) => s + Math.round((i.size || 0) * 0.75), 0);
    return { settings, images, total: settings + images };
}

function renderUsage() {
    const u = storageBreakdown();
    const imgPct = u.total ? (u.images / u.total * 100) : 0;
    $('#usage').innerHTML = `
        <div class="usage-total"><b>${fmtSize(u.total)}</b> 사용 중</div>
        <div class="meter split"><i style="width:${imgPct.toFixed(1)}%"></i><i class="is-settings" style="width:${(100 - imgPct).toFixed(1)}%"></i></div>
        <div class="usage-rows">
            <span><i class="dot"></i>이미지 ${state.images.length}장 · ${fmtSize(u.images)}</span>
            <span><i class="dot is-settings"></i>설정·기록 · ${fmtSize(u.settings)}</span>
        </div>
        <div class="usage-note">확장 저장소는 용량 제한이 없어요.</div>`;
}

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function resolveTheme(v) {
    if (v === 'auto' || v === 'site') return darkQuery.matches ? 'dark' : 'warm';
    return ['warm', 'dark', 'light'].includes(v) ? v : 'warm';
}
function applyTheme() {
    document.documentElement.dataset.theme = resolveTheme(state.store[LS + 'csp_ext_theme'] || 'warm');
}
darkQuery.addEventListener?.('change', applyTheme);

// ── 이미지 미리보기 (지연 로딩) ────────────────────────────────
const thumbCache = new Map();
const io = new IntersectionObserver((entries) => {
    entries.forEach(async (e) => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        const id = e.target.dataset.imgId;
        const url = await getImageUrl(id);
        if (!url) return;
        if (e.target.tagName === 'IMG') e.target.src = url;
        else e.target.style.backgroundImage = `url("${url}")`;
    });
}, { rootMargin: '300px' });

async function getImageUrl(id) {
    if (thumbCache.has(id)) return thumbCache.get(id);
    const dataUrl = await DB.getImage(id).catch(() => '');
    if (!dataUrl) return '';
    const { bytes, mime } = dataUrlToBytes(dataUrl);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    thumbCache.set(id, url);
    return url;
}

function observeImages(root) {
    $$('[data-img-id]', root).forEach(el => io.observe(el));
}

// ── 화면: 보관함 ─────────────────────────────────────────────
function roomTitle(r) {
    return r.title || (r.platformId === 'legacy' ? '채팅방 밖에서 만든 삽화' : r.chatId);
}

function chatCardHtml(r) {
    const cover = r.images[0];
    return `<button class="chat-card" data-room="${esc(r.roomKey)}">
        <span class="thumb" ${cover ? `data-img-id="${esc(cover.id)}"` : ''}>${cover ? '' : '🎨'}</span>
        <span style="min-width:0">
            <span class="title">${esc(roomTitle(r))}</span>
            <span class="sub mono">${esc(r.chatId)}</span>
            <span class="stats"><span>🖼 ${r.images.length}</span><span>📝 ${r.recordCount}</span><span>${esc(fmtSize(r.bytes))}</span></span>
            <span class="sub">${r.lastVisited ? '최근 ' + esc(fmtDate(r.lastVisited)) : r.lastImageAt ? '마지막 삽화 ' + esc(fmtDate(r.lastImageAt)) : ''}</span>
        </span>
    </button>`;
}

// 보관함은 기본으로 "삽화가 있는 채팅"만 보여 준다. 캐릭터 슬롯만 저장해 둔 채팅은
// 아래 토글로 볼 수 있고, 한꺼번에 정리할 수 있다. 플랫폼 묶음은 접을 수 있고 24개씩 나눠 보인다.
function renderChats() {
    const main = $('#main');
    const all = Array.from(state.rooms.values());
    const emptyRooms = all.filter(r => !hasImages(r));
    const rooms = state.showEmpty ? all : all.filter(hasImages);
    const byPlatform = new Map();
    rooms.forEach(r => {
        if (!byPlatform.has(r.platformId)) byPlatform.set(r.platformId, []);
        byPlatform.get(r.platformId).push(r);
    });
    const q = state.query.trim().toLowerCase();
    const match = (r) => !q || [roomTitle(r), r.chatId, platformName(r.platformId)].join(' ').toLowerCase().includes(q);
    const recent = (r) => Math.max(r.lastVisited || 0, r.lastImageAt || 0);
    const chips = [['all', '전체', rooms.length], ...Array.from(byPlatform.entries()).map(([id, list]) => [id, platformName(id), list.length])];
    const groups = Array.from(byPlatform.entries())
        .filter(([id]) => state.filter === 'all' || state.filter === id)
        .sort((a, b) => Math.max(...b[1].map(recent)) - Math.max(...a[1].map(recent)))
        .map(([id, list]) => {
            const shown = list.filter(match).sort((a, b) => recent(b) - recent(a));
            if (!shown.length) return '';
            const collapsed = state.collapsed.has(id) && !q;
            const limit = q ? shown.length : (state.limit.get(id) || PAGE);
            const page = shown.slice(0, limit);
            return `<section class="platform-group ${collapsed ? 'is-collapsed' : ''}">
                <h2><button class="group-toggle" data-group="${esc(id)}" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'} ${esc(platformName(id))}</button>
                    <small>채팅 ${shown.length} · 이미지 ${shown.reduce((s, r) => s + r.images.length, 0)}</small></h2>
                ${collapsed ? '' : `<div class="chat-grid">${page.map(chatCardHtml).join('')}</div>
                ${shown.length > limit ? `<div class="more"><button class="btn" data-more="${esc(id)}">${shown.length - limit}개 더 보기</button></div>` : ''}`}
            </section>`;
        }).join('');
    main.innerHTML = `
        <div class="page-head">
            <div><h1>보관함</h1><p>삽화를 만든 채팅만 플랫폼별로 모아 둬요. 들어가 보기만 한 채팅은 쌓이지 않아요.</p></div>
            <div class="toolbar"><input type="search" id="q" placeholder="채팅 이름 · ID 검색" value="${esc(state.query)}"></div>
        </div>
        <div class="chips">${chips.map(([id, label, n]) => `<button class="chip ${state.filter === id ? 'is-active' : ''}" data-filter="${esc(id)}">${esc(label)}<b>${n}</b></button>`).join('')}</div>
        ${emptyRooms.length ? `<div class="empty-bar">
            <span>삽화 없이 설정만 저장된 채팅 <b>${emptyRooms.length}</b>개</span>
            <span class="toolbar"><button class="btn small" id="toggle-empty">${state.showEmpty ? '숨기기' : '보기'}</button><button class="btn small danger" id="clean-empty">정리</button></span>
        </div>` : ''}
        ${groups || `<div class="empty">${q ? `"${esc(state.query)}"와 맞는 채팅이 없어요.` : '아직 삽화를 만든 채팅이 없어요.<br>채팅방에서 🎨 메뉴로 삽화를 만들면 여기에 모여요.'}</div>`}`;
    $('#q').addEventListener('input', (e) => {
        state.query = e.target.value;
        const pos = e.target.selectionStart;
        renderChats();
        const q2 = $('#q'); q2.focus(); q2.setSelectionRange(pos, pos);
    });
    $$('.chip', main).forEach(c => c.onclick = () => { state.filter = c.dataset.filter; renderChats(); });
    $$('.chat-card', main).forEach(c => c.onclick = () => { location.hash = `chat=${encodeURIComponent(c.dataset.room)}`; });
    $$('[data-group]', main).forEach(b => b.onclick = () => {
        const id = b.dataset.group;
        if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
        renderChats();
    });
    $$('[data-more]', main).forEach(b => b.onclick = () => {
        const id = b.dataset.more;
        state.limit.set(id, (state.limit.get(id) || PAGE) + PAGE);
        renderChats();
    });
    const toggleEmpty = $('#toggle-empty');
    if (toggleEmpty) toggleEmpty.onclick = () => { state.showEmpty = !state.showEmpty; renderChats(); };
    const cleanEmpty = $('#clean-empty');
    if (cleanEmpty) cleanEmpty.onclick = async () => {
        if (!confirm(`삽화가 없는 채팅 ${emptyRooms.length}개의 방 설정(등장인물 슬롯 등)과 기록을 지울까요?\n삽화가 있는 채팅은 건드리지 않아요.`)) return;
        await deleteRooms(emptyRooms.map(r => r.roomKey));
        toast(`${emptyRooms.length}개 정리했어요.`);
        renderChats();
    };
    observeImages(main);
}

// ── 화면: 채팅 상세 ───────────────────────────────────────────
function renderChat(roomKey) {
    const r = state.rooms.get(roomKey);
    const main = $('#main');
    if (!r) {
        main.innerHTML = `<div class="page-head"><div><h1>채팅을 찾을 수 없어요</h1><p class="mono">${esc(roomKey)}</p></div></div>
            <a class="btn" href="#chats">← 보관함</a>`;
        return;
    }
    main.innerHTML = `
        <div class="page-head"><a class="btn ghost" href="#chats">← 보관함</a></div>
        <div class="panel">
            <div class="detail-head">
                <div style="min-width:0">
                    <span class="badge">${esc(platformName(r.platformId))}</span>
                    <div class="title" id="chat-title">${esc(roomTitle(r))}</div>
                    <dl class="kv">
                        <dt>채팅 ID</dt><dd class="mono">${esc(r.chatId)}</dd>
                        <dt>저장 키</dt><dd class="mono">${esc(r.roomKey)}</dd>
                        <dt>처음 방문</dt><dd>${esc(fmtDate(r.firstSeen))}</dd>
                        <dt>최근 방문</dt><dd>${esc(fmtDate(r.lastVisited))}</dd>
                        <dt>보관</dt><dd>이미지 ${r.images.length}장 · 장면 기록 ${r.recordCount}개 · ${esc(fmtSize(r.bytes))}${r.hasSettings ? ' · 방 설정 있음' : ''}</dd>
                    </dl>
                </div>
                <div class="actions" style="margin:0">
                    ${r.url ? `<a class="btn primary" href="${esc(r.url)}" target="_blank" rel="noopener">채팅 열기</a>` : ''}
                    <button class="btn" id="rename">이름 바꾸기</button>
                    <button class="btn" id="zip" ${r.images.length ? '' : 'disabled'}>이미지 ZIP</button>
                    <button class="btn" id="export">이 채팅 백업</button>
                    <button class="btn danger" id="delete">삭제</button>
                </div>
            </div>
        </div>
        ${r.images.length ? `<div class="img-grid">${r.images.map((img, i) => `
            <button class="img-cell" data-index="${i}"><img alt="" data-img-id="${esc(img.id)}"><span class="cap">${esc(fmtDate(img.createdAt))}</span></button>`).join('')}</div>`
            : '<div class="empty">이 채팅에는 저장된 이미지가 없어요.</div>'}`;
    observeImages(main);
    $$('.img-cell', main).forEach(c => c.onclick = () => openLightbox(r.images, Number(c.dataset.index), r));
    $('#rename').onclick = async () => {
        const name = prompt('이 채팅의 이름', roomTitle(r));
        if (name == null) return;
        const chats = (await chrome.storage.local.get(CHATS_KEY))[CHATS_KEY] || {};
        const { platformId, chatId } = P.parseRoomKey(roomKey);
        chats[roomKey] = { ...(chats[roomKey] || { roomKey, platformId, chatId, firstSeen: Date.now() }), title: name.trim(), customTitle: true };
        await chrome.storage.local.set({ [CHATS_KEY]: chats });
        await loadAll();
        renderChat(roomKey);
    };
    $('#zip').onclick = () => zipImages(r.images, `vignette_${r.roomKey}`);
    $('#export').onclick = () => exportBackup({ roomKeys: [roomKey], name: `vignette_${r.roomKey}`, format: 'zip' });
    $('#delete').onclick = async () => {
        if (!confirm(`"${roomTitle(r)}"의 이미지 ${r.images.length}장, 장면 기록, 방 설정을 모두 지울까요?\n되돌릴 수 없어요.`)) return;
        await deleteRooms([roomKey]);
        toast('삭제했어요.');
        location.hash = 'chats';
    };
}

async function deleteRooms(roomKeys) {
    const keys = [];
    const set = new Set(roomKeys);
    for (const rk of roomKeys) keys.push(LS + ROOM_SETTINGS + rk, LS + SCENE_RECORDS + rk);
    await chrome.storage.local.remove(keys);
    const chats = (await chrome.storage.local.get(CHATS_KEY))[CHATS_KEY] || {};
    roomKeys.forEach(rk => delete chats[rk]);
    await chrome.storage.local.set({ [CHATS_KEY]: chats });
    for (const img of state.images) if (set.has(roomKeyOfImage(img))) await DB.deleteImage(img.id);
    const metaIds = await DB.listMetaIds().catch(() => []);
    for (const id of metaIds) {
        const prefix = String(id).split('::')[0];
        if (set.has(prefix) || set.has(`univers__${prefix}`)) await DB.deleteMeta(id);
    }
    await loadAll();
}

// ── 라이트박스 ───────────────────────────────────────────────
function findPromptArchiveId(roomKey, imageId) {
    const records = decodeJson(state.store[LS + SCENE_RECORDS + roomKey], {});
    for (const rec of Object.values(records)) {
        for (const item of rec?.history || []) if (item?.imageId === imageId) return item.promptArchiveId || '';
        if (rec?.imageId === imageId) return rec.promptArchiveId || '';
    }
    return '';
}

function openLightbox(list, index, room) {
    const box = $('#lightbox');
    let i = index;
    const show = async () => {
        const img = list[i];
        const url = await getImageUrl(img.id);
        const rk = room?.roomKey || roomKeyOfImage(img);
        box.innerHTML = `
            <div class="stage"><img src="${esc(url)}" alt=""></div>
            ${list.length > 1 ? '<button class="nav-btn prev" aria-label="이전">‹</button><button class="nav-btn next" aria-label="다음">›</button>' : ''}
            <div class="bar">
                <span class="info">${i + 1} / ${list.length} · ${esc(fmtDate(img.createdAt))}${room ? '' : ' · ' + esc(platformName(P.parseRoomKey(rk).platformId))}</span>
                <button class="btn small" data-act="prompt">프롬프트</button>
                <button class="btn small" data-act="save">저장</button>
                ${room ? '' : '<button class="btn small" data-act="chat">채팅 보기</button>'}
                <button class="btn small danger" data-act="delete">삭제</button>
                <button class="btn small" data-act="close">닫기 (Esc)</button>
            </div>`;
        box.hidden = false;
        box.onclick = async (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (e.target.classList.contains('prev')) { i = (i - 1 + list.length) % list.length; show(); return; }
            if (e.target.classList.contains('next')) { i = (i + 1) % list.length; show(); return; }
            if (act === 'close' || e.target.classList.contains('stage')) close();
            else if (act === 'save') {
                const dataUrl = await DB.getImage(img.id);
                const { bytes, mime } = dataUrlToBytes(dataUrl);
                download(`scene_${(img.createdAt || Date.now())}.${extOf(mime)}`, new Blob([bytes], { type: mime }));
            } else if (act === 'chat') { close(); location.hash = `chat=${encodeURIComponent(rk)}`; }
            else if (act === 'prompt') {
                const pid = findPromptArchiveId(rk, img.id);
                const payload = pid ? await DB.getMeta(pid) : null;
                const text = payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)) : '이 이미지에는 저장된 프롬프트 기록이 없어요.';
                const pre = document.createElement('pre');
                pre.style.cssText = 'position:absolute;inset:20px 20px 70px;overflow:auto;margin:0;padding:16px;border-radius:12px;background:rgba(20,16,12,.95);color:#f3e9da;font:12px/1.5 var(--mono);white-space:pre-wrap';
                pre.textContent = text.slice(0, 20000);
                pre.onclick = (ev) => { ev.stopPropagation(); pre.remove(); };
                box.appendChild(pre);
            } else if (act === 'delete') {
                if (!confirm('이 이미지를 지울까요? 채팅 화면의 기록에서도 이미지가 사라져요.')) return;
                await DB.deleteImage(img.id);
                list.splice(i, 1);
                thumbCache.delete(img.id);
                await loadAll();
                if (!list.length) { close(); route(); return; }
                i = Math.min(i, list.length - 1);
                show();
            }
        };
    };
    const onKey = (e) => {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft' && list.length > 1) { i = (i - 1 + list.length) % list.length; show(); }
        else if (e.key === 'ArrowRight' && list.length > 1) { i = (i + 1) % list.length; show(); }
    };
    const close = () => { box.hidden = true; box.innerHTML = ''; document.removeEventListener('keydown', onKey); route(); };
    document.addEventListener('keydown', onKey);
    show();
}

// ── 화면: 전체 갤러리 ─────────────────────────────────────────
function renderGallery() {
    const main = $('#main');
    const all = state.images.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const platforms = Array.from(new Set(all.map(img => P.parseRoomKey(roomKeyOfImage(img)).platformId)));
    const list = state.filter === 'all' ? all : all.filter(img => P.parseRoomKey(roomKeyOfImage(img)).platformId === state.filter);
    main.innerHTML = `
        <div class="page-head">
            <div><h1>전체 갤러리</h1><p>모든 플랫폼에서 만든 삽화 ${all.length}장</p></div>
            <div class="toolbar"><button class="btn" id="zip-all" ${list.length ? '' : 'disabled'}>보이는 이미지 ZIP</button></div>
        </div>
        <div class="chips">${[['all', '전체', all.length], ...platforms.map(id => [id, platformName(id), all.filter(img => P.parseRoomKey(roomKeyOfImage(img)).platformId === id).length])]
            .map(([id, label, n]) => `<button class="chip ${state.filter === id ? 'is-active' : ''}" data-filter="${esc(id)}">${esc(label)}<b>${n}</b></button>`).join('')}</div>
        ${list.length ? `<div class="img-grid">${list.map((img, i) => {
            const rk = roomKeyOfImage(img);
            const r = state.rooms.get(rk);
            return `<button class="img-cell" data-index="${i}"><img alt="" data-img-id="${esc(img.id)}"><span class="cap">${esc(r ? roomTitle(r) : rk)}</span></button>`;
        }).join('')}</div>` : '<div class="empty">이미지가 없어요.</div>'}`;
    $$('.chip', main).forEach(c => c.onclick = () => { state.filter = c.dataset.filter; renderGallery(); });
    $$('.img-cell', main).forEach(c => c.onclick = () => openLightbox(list, Number(c.dataset.index), null));
    $('#zip-all').onclick = () => zipImages(list, 'vignette_gallery');
    observeImages(main);
}

async function zipImages(list, name) {
    toast(`이미지 ${list.length}장 묶는 중…`, 60000);
    const files = {};
    for (const img of list) {
        const dataUrl = await DB.getImage(img.id);
        if (!dataUrl) continue;
        const { bytes, mime } = dataUrlToBytes(dataUrl);
        const rk = roomKeyOfImage(img).replace(/[^A-Za-z0-9_.-]/g, '_');
        files[`${rk}/${img.createdAt || 0}_${img.id.slice(-6).replace(/[^A-Za-z0-9]/g, '')}.${extOf(mime)}`] = [bytes, { level: 0 }];
    }
    const zipped = fflate.zipSync(files);
    download(`${name}.zip`, new Blob([zipped], { type: 'application/zip' }));
    toast('ZIP 저장을 시작했어요.');
}

// ── 화면: 사이트 설정 ─────────────────────────────────────────
const FIELD_SPECS = [
    ['name', '이름', ''],
    ['hosts', '도메인', '쉼표로 구분 (예: example.com)'],
    ['chatPath', '채팅방 경로 규칙', '정규식, 첫 괄호 = 채팅 ID. 비우면 자동'],
    ['mode', '판별 방식', 'univers = 유니챗 전용 자동 인식'],
    ['messageSelector', '메시지 셀렉터', '선택 · 메시지 하나를 감싸는 요소'],
    ['bodySelector', '본문 셀렉터', 'AI 답변 본문 (🎨 메뉴 › 본문 위치 지정)'],
    ['footerSelector', '하단 셀렉터', '버튼 줄. 비우면 본문 아래에 만들어 붙임'],
    ['userSelector', '내 메시지 셀렉터', '선택 · 여기 걸리면 삽화 대상 제외'],
    ['idAttribute', '메시지 ID 속성', '선택 · 예: data-message-id']
];

function allSites() {
    const out = { ...state.sites };
    P.BUILTIN_PLATFORMS.forEach(p => { if (!out[p.id]) out[p.id] = { ...p, enabled: true }; });
    return Object.values(out).sort((a, b) => (a.custom ? 1 : 0) - (b.custom ? 1 : 0));
}

function siteCardHtml(s) {
    const builtin = P.BUILTIN_PLATFORMS.find(p => p.id === s.id);
    const ready = s.mode === 'univers' || !!s.bodySelector;
    const val = (k) => k === 'hosts' ? (s.hosts || []).join(', ') : (s[k] ?? '');
    return `<div class="site-card" data-site="${esc(s.id)}">
        <header>
            <span><b>${esc(s.name || s.id)}</b> <span class="muted">${esc((s.hosts || []).join(', '))}</span><br>
            <span class="state ${ready ? 'ok' : 'warn'}">${s.mode === 'univers' ? '자동 인식' : ready ? '위치 지정됨' : '본문 위치 지정 필요 — 채팅방에서 🎨 › 본문 위치 지정'}</span>
            ${s.userEdited && builtin ? '<span class="badge">직접 수정함</span>' : ''}${s.custom ? '<span class="badge">추가한 사이트</span>' : ''}
            ${s.custom ? '<span class="perm-slot"></span>' : ''}</span>
            <label class="switch" title="이 사이트에서 사용"><input type="checkbox" data-enabled ${s.enabled !== false ? 'checked' : ''}><span></span></label>
        </header>
        <details>
            <summary>세부 설정</summary>
            <div class="fields">
                ${FIELD_SPECS.map(([k, label, hint]) => `<label for="f-${esc(s.id)}-${k}">${label}${hint ? `<small>${hint}</small>` : ''}</label>
                ${k === 'mode'
                    ? `<select id="f-${esc(s.id)}-${k}" data-field="${k}"><option value="generic" ${s.mode !== 'univers' ? 'selected' : ''}>generic (셀렉터)</option><option value="univers" ${s.mode === 'univers' ? 'selected' : ''}>univers (유니챗 자동)</option></select>`
                    : `<input type="text" id="f-${esc(s.id)}-${k}" data-field="${k}" value="${esc(val(k))}" spellcheck="false" ${/Selector|Path|Attr/.test(k) ? 'class="mono"' : ''}>`}`).join('')}
            </div>
            <div class="actions">
                <button class="btn primary" data-act="save">저장</button>
                ${builtin ? '<button class="btn" data-act="reset">기본값으로</button>' : '<button class="btn danger" data-act="remove">사이트 삭제</button>'}
            </div>
        </details>
    </div>`;
}

function renderSites() {
    const main = $('#main');
    main.innerHTML = `
        <div class="page-head">
            <div><h1>사이트 설정</h1><p>사이트마다 본문 · 하단 위치를 기억해요. 보통은 채팅방에서 🎨 버튼 › 위치 지정으로 고르면 되고, 여기서는 직접 고칠 수 있어요.</p></div>
            <form class="add-site" id="add-site-form"><input type="text" id="add-site-host" placeholder="example.com" spellcheck="false" autocomplete="off"><button class="btn primary" type="submit">+ 사이트 추가</button></form>
        </div>
        ${allSites().map(siteCardHtml).join('')}`;
    // 사이트 추가: 그 사이트만 접근 허용을 받는다 (버튼을 누른 바로 그 순간에 물어야 크롬이 창을 띄운다)
    $('#add-site-form').onsubmit = (e) => {
        e.preventDefault();
        const clean = $('#add-site-host').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean)) { toast('도메인 형식이 아니에요. 예: example.com'); return; }
        chrome.permissions.request({ origins: [`https://${clean}/*`, `https://*.${clean}/*`] }).then(async (granted) => {
            await chrome.runtime.sendMessage({ type: 'site.addCustom', payload: { host: clean } });
            await loadAll();
            renderSites();
            toast(granted ? '추가했어요. 그 사이트 채팅방을 새로고침하면 🎨 버튼이 생겨요.' : '추가는 했지만 접근을 허용하지 않아서 아직 동작하지 않아요. 카드의 [허용]을 눌러 주세요.');
        }).catch(() => {});
    };
    // 추가한 사이트의 접근 허용 상태 표시
    $$('.site-card', main).forEach(async (card) => {
        const s = allSites().find(x => x.id === card.dataset.site);
        if (!s?.custom) return;
        const host = (s.hosts || [])[0];
        if (!host) return;
        const origins = [`https://${host}/*`];
        const ok = await chrome.permissions.contains({ origins }).catch(() => false);
        const slot = $('.perm-slot', card);
        slot.innerHTML = ok
            ? '<span class="perm-state is-ok">✓ 접근 허용됨</span>'
            : '<span class="perm-state is-need">🔒 접근 허용 필요</span><button type="button" class="btn small primary" data-grant>허용</button>';
        const btn = $('[data-grant]', slot);
        if (btn) btn.onclick = () => chrome.permissions.request({ origins: [...origins, `https://*.${host}/*`] }).then(() => renderSites()).catch(() => {});
    });
    $$('.site-card', main).forEach(card => {
        const id = card.dataset.site;
        const update = async (patch) => {
            const sites = (await chrome.storage.local.get(P.SITES_KEY))[P.SITES_KEY] || {};
            const base = sites[id] || allSites().find(s => s.id === id);
            sites[id] = { ...base, ...patch };
            await chrome.storage.local.set({ [P.SITES_KEY]: sites });
            await loadAll();
        };
        $('[data-enabled]', card).onchange = async (e) => { await update({ enabled: e.target.checked }); toast(e.target.checked ? '켰어요. 열려 있는 탭은 새로고침해줘.' : '껐어요. 열려 있는 탭은 새로고침해줘.'); };
        card.addEventListener('click', async (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (!act) return;
            if (act === 'save') {
                const patch = { userEdited: true };
                $$('[data-field]', card).forEach(f => {
                    const k = f.dataset.field;
                    patch[k] = k === 'hosts' ? f.value.split(',').map(x => x.trim()).filter(Boolean) : f.value.trim();
                });
                if (patch.chatPath) { try { new RegExp(patch.chatPath); } catch (err) { toast('채팅방 경로 규칙이 올바른 정규식이 아니에요.'); return; } }
                for (const k of ['messageSelector', 'bodySelector', 'footerSelector', 'userSelector']) {
                    if (!patch[k]) continue;
                    try { document.createDocumentFragment().querySelector(patch[k]); } catch (_) { toast(`${k} 셀렉터 문법이 틀렸어요.`); return; }
                }
                await update(patch);
                toast('저장했어요. 열려 있는 채팅 탭에 바로 반영돼요.');
                renderSites();
            } else if (act === 'reset') {
                const b = P.BUILTIN_PLATFORMS.find(p => p.id === id);
                const prev = state.sites[id];
                await update({ ...b, enabled: prev ? prev.enabled !== false : true, userEdited: false });
                toast('기본값으로 되돌렸어요.');
                renderSites();
            } else if (act === 'remove') {
                if (!confirm('이 사이트 설정을 지울까요? (저장된 삽화는 남아요)')) return;
                const sites = (await chrome.storage.local.get(P.SITES_KEY))[P.SITES_KEY] || {};
                delete sites[id];
                await chrome.storage.local.set({ [P.SITES_KEY]: sites });
                await loadAll();
                renderSites();
            }
        });
    });
}

// ── 백업 · 복원 ──────────────────────────────────────────────
const SECRET_FIELD = /(api.?key|token|secret|password|access.?key|authorization)/i;

function stripSecrets(obj) {
    if (Array.isArray(obj)) return obj.map(stripSecrets);
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = SECRET_FIELD.test(k) && typeof v === 'string' ? '' : stripSecrets(v);
    return out;
}

// roomKeys가 있으면 그 채팅만, platformId가 있으면 그 플랫폼만, 없으면 전체
// format: 'cspbak'(데이터 한 파일) · 'zip'(데이터 + 이미지 파일 폴더 정리)
async function exportBackup({ roomKeys = null, platformId = null, includeSecrets = false, includeGlobal = true, name = 'vignette_backup', format = 'cspbak' } = {}) {
    toast('백업 파일 만드는 중…', 60000);
    const store = await chrome.storage.local.get(null);
    const rkSet = roomKeys ? new Set(roomKeys) : null;
    const wantRoom = (rk) => (!rkSet || rkSet.has(rk)) && (!platformId || P.parseRoomKey(rk).platformId === platformId);
    const storage = {};
    for (const [k, v] of Object.entries(store)) {
        if (k.startsWith(LS)) {
            const key = k.slice(LS.length);
            const roomMatch = key.startsWith(ROOM_SETTINGS) ? key.slice(ROOM_SETTINGS.length) : key.startsWith(SCENE_RECORDS) ? key.slice(SCENE_RECORDS.length) : null;
            if (roomMatch != null) { if (wantRoom(roomMatch)) storage[k] = v; continue; }
            // 공용 설정(API 설정 · 프리셋 등)은 채팅 하나만 백업할 때는 뺀다
            if (!includeGlobal || rkSet) continue;
            storage[k] = key === GLOBAL_SETTINGS && !includeSecrets ? encodeJson(stripSecrets(decodeJson(v, {}))) : v;
        } else if (k === CHATS_KEY) {
            storage[k] = Object.fromEntries(Object.entries(v || {}).filter(([rk]) => wantRoom(rk)));
        } else if (k === P.SITES_KEY && !rkSet) {
            storage[k] = platformId ? { [platformId]: v?.[platformId] } : v;
        } else if (!rkSet && !platformId) {
            storage[k] = v;
        }
    }
    const images = [];
    for (const info of await DB.listImageInfo()) {
        if (!wantRoom(roomKeyOfImage(info))) continue;
        const rec = await DB.getImageRecord(info.id);
        if (rec) images.push(rec);
    }
    const metas = (await DB.listAllMeta().catch(() => [])).filter(m => {
        const prefix = String(m.id).split('::')[0];
        if (!String(m.id).includes('::')) return !rkSet && !platformId;
        const rk = prefix.includes('__') ? prefix : `univers__${prefix}`;
        return wantRoom(rk);
    });
    const payload = { format: 'scene-painter-backup', version: 1, exportedAt: new Date().toISOString(), scope: rkSet ? 'chats' : platformId ? 'platform' : 'all', includeSecrets, storage, images, meta: metas };
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'zip') {
        // ZIP: 데이터(json) + 이미지 파일을 "플랫폼/채팅/날짜.png" 폴더로 정리해서 한 번에
        const files = {};
        const used = new Set();
        const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || '_';
        const chats = store[CHATS_KEY] || {};
        const zipImages = images.map((rec, i) => {
            const rk = roomKeyOfImage(rec);
            const { platformId: pid, chatId } = P.parseRoomKey(rk);
            const chat = chats[rk];
            const folder = `images/${safe(platformName(pid))}/${safe(chat?.title ? `${chat.title} (${chatId.slice(0, 8)})` : chatId)}`;
            const { bytes, mime } = dataUrlToBytes(rec.dataUrl);
            const d = new Date(rec.createdAt || Date.now());
            const pad = n => String(n).padStart(2, '0');
            let path = `${folder}/${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${extOf(mime)}`;
            // 같은 초에 만든 이미지는 -2, -3 … 을 붙인다
            for (let n = 2; used.has(path) && n < 10000; n++) path = path.replace(/(-\d+)?\.(\w+)$/, `-${n}.$2`);
            used.add(path);
            files[path] = [bytes, { level: 0 }];   // 이미지는 이미 압축돼 있다
            const { dataUrl, ...rest } = rec;
            return { ...rest, file: path };
        });
        files['scene-painter-backup.json'] = fflate.strToU8(JSON.stringify({ ...payload, images: zipImages }));
        files['README.txt'] = fflate.strToU8([
            'Vignette 백업',
            `만든 날: ${new Date().toLocaleString()}`,
            `이미지 ${zipImages.length}장 · 범위: ${payload.scope}${includeSecrets ? ' · API 키 포함' : ' · API 키 제외'}`,
            '',
            'images/ 폴더: 플랫폼 > 채팅 > 날짜별 이미지',
            '복원: 관리 페이지 > 백업 · 복원 > 백업 파일 고르기에서 이 ZIP 파일을 그대로 고르면 됩니다.'
        ].join('\r\n'));
        const zipped = fflate.zipSync(files, { level: 6 });
        download(`${name}_${stamp}.zip`, new Blob([zipped], { type: 'application/zip' }));
        toast(`ZIP 백업 완료 — 이미지 ${zipImages.length}장 · ${fmtSize(zipped.length)}`);
        return;
    }

    const json = JSON.stringify(payload);
    const gz = fflate.gzipSync(fflate.strToU8(json), { level: 6 });
    download(`${name}_${stamp}.cspbak`, new Blob([gz], { type: 'application/gzip' }));
    toast(`백업 완료 — 이미지 ${images.length}장`);
}

async function importBackup(file, mode) {
    toast('백업 읽는 중…', 60000);
    const buf = new Uint8Array(await file.arrayBuffer());
    let data;
    try {
        if (buf[0] === 0x50 && buf[1] === 0x4b) {
            // ZIP 백업: json + 이미지 파일
            const entries = fflate.unzipSync(buf);
            const jsonName = Object.keys(entries).find(n => /scene-painter-backup\.json$/.test(n));
            if (!jsonName) { toast('ZIP 안에 scene-painter-backup.json이 없어요.'); return; }
            data = JSON.parse(fflate.strFromU8(entries[jsonName]));
            const MIME = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
            data.images = (data.images || []).map(rec => {
                if (rec.dataUrl || !rec.file || !entries[rec.file]) return rec;
                const ext = rec.file.split('.').pop().toLowerCase();
                return { ...rec, dataUrl: `data:${MIME[ext] || 'application/octet-stream'};base64,${bytesToB64(entries[rec.file])}` };
            }).filter(rec => rec.dataUrl);
        } else {
            const text = buf[0] === 0x1f && buf[1] === 0x8b ? fflate.strFromU8(fflate.gunzipSync(buf)) : fflate.strFromU8(buf);
            data = JSON.parse(text);
        }
    } catch (_) { toast('파일을 읽지 못했어요.'); return; }
    if (data?.format !== 'scene-painter-backup') { toast('Vignette 백업 파일이 아니에요.'); return; }
    const current = await chrome.storage.local.get(null);
    const toSet = {};
    let skipped = 0;
    for (const [k, v] of Object.entries(data.storage || {})) {
        if (k === CHATS_KEY || k === P.SITES_KEY) {
            toSet[k] = { ...(current[k] || {}), ...(v || {}) };
            continue;
        }
        if (mode === 'merge' && current[k] !== undefined) {
            // 장면 기록은 메시지 단위로 합친다. 나머지는 지금 값을 유지.
            const key = k.slice(LS.length);
            if (key.startsWith(SCENE_RECORDS)) {
                toSet[k] = encodeJson({ ...decodeJson(v, {}), ...decodeJson(current[k], {}) });
            } else { skipped++; }
            continue;
        }
        // 비밀값이 빠진 백업이면 지금 API 키를 지우지 않는다
        if (k === LS + GLOBAL_SETTINGS && data.includeSecrets === false && current[k]) {
            const cur = decodeJson(current[k], {});
            const inc = decodeJson(v, {});
            for (const [f, val] of Object.entries(cur)) if (SECRET_FIELD.test(f) && !inc[f]) inc[f] = val;
            toSet[k] = encodeJson(inc);
            continue;
        }
        toSet[k] = v;
    }
    await chrome.storage.local.set(toSet);
    let imgCount = 0;
    for (const rec of data.images || []) {
        if (mode === 'merge' && await DB.getImageRecord(rec.id)) continue;
        await DB.putImage(rec.id, rec.dataUrl, rec);
        imgCount++;
    }
    for (const m of data.meta || []) await DB.putMeta(m.id, m.value);
    await loadAll();
    toast(`복원 완료 — 항목 ${Object.keys(toSet).length}개 · 이미지 ${imgCount}장${skipped ? ` (기존 값 유지 ${skipped}개)` : ''}`, 4000);
    route();
}

function renderBackup() {
    const main = $('#main');
    const platforms = Array.from(new Set(Array.from(state.rooms.values()).map(r => r.platformId))).filter(id => id !== 'legacy');
    main.innerHTML = `
        <div class="page-head"><div><h1>백업 · 복원</h1><p>설정 · 방별 설정 · 장면 기록 · 이미지를 파일로 보관하고 되살려요.</p></div></div>
        <div class="panel backup-hero">
            <div>
                <h2>ZIP으로 전부 내려받기</h2>
                <p class="muted">데이터 + 모든 이미지를 <b>플랫폼 › 채팅 › 날짜</b> 폴더로 정리해서 ZIP 하나로 받아요. 이 ZIP 그대로 복원할 수도 있어요.</p>
                <p class="muted">이미지 ${state.images.length}장 · 약 ${fmtSize(storageBreakdown().total)}</p>
            </div>
            <button class="btn primary big" id="bk-zip-all">ZIP 전체 백업</button>
        </div>
        <div class="panel">
            <h2>골라서 백업</h2>
            <div class="form-row"><span class="label"><b>범위</b><small>전체 또는 플랫폼 하나만</small></span>
                <select id="bk-scope"><option value="">전체</option>${platforms.map(id => `<option value="${esc(id)}">${esc(platformName(id))}</option>`).join('')}</select></div>
            <div class="form-row"><span class="label"><b>형식</b><small>ZIP: 이미지를 파일로 꺼내 볼 수 있음 · .cspbak: 복원 전용 파일 하나</small></span>
                <select id="bk-format"><option value="zip">ZIP (데이터 + 이미지 폴더)</option><option value="cspbak">.cspbak (데이터 한 파일)</option></select></div>
            <div class="form-row"><span class="label"><b>API 키 포함</b><small>다른 사람에게 줄 파일이면 끄세요</small></span>
                <label class="switch"><input type="checkbox" id="bk-secrets"><span></span></label></div>
            <div class="actions"><button class="btn primary" id="bk-go">백업 파일 저장</button></div>
        </div>
        <div class="panel">
            <h2>복원하기</h2>
            <div class="form-row"><span class="label"><b>방식</b><small>합치기: 지금 있는 값은 그대로 두고 없는 것만 채움 · 덮어쓰기: 백업 값으로 바꿈</small></span>
                <select id="rs-mode"><option value="merge">합치기</option><option value="overwrite">덮어쓰기</option></select></div>
            <div class="actions"><label class="btn primary">백업 파일 고르기 (.zip · .cspbak)<input type="file" id="rs-file" accept=".zip,.cspbak,.json,.gz" hidden></label></div>
        </div>`;
    $('#bk-zip-all').onclick = () => exportBackup({ includeSecrets: $('#bk-secrets').checked, name: 'vignette_all', format: 'zip' });
    $('#bk-go').onclick = () => {
        const scope = $('#bk-scope').value;
        exportBackup({ platformId: scope || null, includeSecrets: $('#bk-secrets').checked, name: scope ? `vignette_${scope}` : 'vignette_all', format: $('#bk-format').value });
    };
    $('#rs-file').onchange = (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const mode = $('#rs-mode').value;
        if (mode === 'overwrite' && !confirm('같은 항목은 백업 값으로 덮어써요. 진행할까요?')) return;
        importBackup(f, mode);
        e.target.value = '';
    };
}

// ── 공통 설정 · API 키 ───────────────────────────────────────
// 채팅방 설정창의 API 탭과 같은 저장값(전역 설정)을 고친다. 모든 사이트 · 모든 채팅이 같이 쓴다.
const PROVIDERS = [
    { value: 'ai-studio', name: 'Google Gemini (AI Studio)', fields: [['googleApiKey', 'API Key', 'secret'], ['googleModel', '모델', 'text', 'gemini-3.8-flash']] },
    { value: 'vertex', name: 'Google Gemini (Vertex AI)', fields: [['vertexProjectId', 'Project ID', 'text'], ['vertexLocation', 'Location', 'text', 'us-central1'], ['vertexAccessToken', 'Access Token', 'secret'], ['googleModel', '모델', 'text']] },
    { value: 'firebase', name: 'Google Gemini (Firebase)', fields: [['firebaseConfigJson', 'Firebase Config (JSON)', 'textarea'], ['firebaseLocation', 'Location', 'text', 'global'], ['googleModel', '모델', 'text']] },
    { value: 'openai', name: 'OpenAI', fields: [['openaiApiKey', 'API Key', 'secret'], ['openaiModel', '모델', 'text']] },
    { value: 'anthropic', name: 'Anthropic Claude', fields: [['anthropicApiKey', 'API Key', 'secret'], ['claudeModel', '모델', 'text']] },
    { value: 'glm', name: 'GLM (Zhipu AI)', fields: [['glmApiKey', 'API Key', 'secret'], ['glmModel', '모델', 'text']] },
    { value: 'deepseek', name: 'DeepSeek', fields: [['deepseekApiKey', 'API Key', 'secret'], ['deepseekModel', '모델', 'text']] },
    { value: 'openrouter', name: 'OpenRouter', fields: [['openrouterApiKey', 'API Key', 'secret'], ['openrouterModel', '모델', 'text']] },
    { value: 'custom', name: '커스텀 엔드포인트 (OpenAI 호환)', fields: [['customApiUrl', '주소 (URL)', 'text', 'https://…/v1'], ['customApiKey', 'API Key', 'secret'], ['customModel', '모델', 'text'], ['customAuthMode', '인증 방식', 'auth']] }
];
const KEY_FIELD_OF = { 'ai-studio': 'googleApiKey', vertex: 'vertexAccessToken', firebase: 'firebaseConfigJson', openai: 'openaiApiKey', anthropic: 'anthropicApiKey', glm: 'glmApiKey', deepseek: 'deepseekApiKey', openrouter: 'openrouterApiKey', custom: 'customApiKey' };

function readGlobalSettings() {
    return decodeJson(state.store[LS + GLOBAL_SETTINGS], {});
}

// 키 상태: NAI + 지금 고른 분석 AI 둘 다 있어야 생성이 된다
function keyStatus(g = readGlobalSettings()) {
    const provider = g.geminiProvider || 'ai-studio';
    const analysisKey = provider === 'custom' && g.customAuthMode === 'none' ? 'none' : String(g[KEY_FIELD_OF[provider]] || '').trim();
    return { nai: !!String(g.naiApiKey || '').trim(), analysis: !!analysisKey, provider };
}

const KEY_ICONS = {
    image: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
    brain: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>',
    eye: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A10.4 10.4 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2"/><path d="M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"/></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
    shield: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>'
};

// 공급자별 키 받는 곳 안내
const PROVIDER_HINTS = {
    'ai-studio': 'Google AI Studio › Get API key 에서 발급해요.',
    vertex: 'Google Cloud 프로젝트 ID와 OAuth Access Token이 필요해요.',
    firebase: 'Firebase 콘솔 › 프로젝트 설정의 웹 앱 config(JSON)를 붙여 넣어요.',
    openai: 'platform.openai.com › API keys 에서 발급해요.',
    anthropic: 'console.anthropic.com › API Keys 에서 발급해요.',
    glm: 'Zhipu AI(bigmodel.cn / z.ai) 콘솔에서 발급해요.',
    deepseek: 'platform.deepseek.com › API keys 에서 발급해요.',
    openrouter: 'openrouter.ai › Keys 에서 발급해요. 여러 회사 모델을 한 키로 써요.',
    custom: 'OpenAI 호환 서버 주소와 그 서버의 키를 넣어요. 키가 필요 없는 서버면 인증 방식을 "인증 없음"으로.'
};

// NovelAI 안전 설정 (코어와 같은 키 · 같은 기본값)
const NAI_SAFETY_KEY = LS + 'csp_ext_nai_safety';
const NAI_LOG_KEY = LS + 'csp_ext_nai_log';
function readNaiSafety() {
    let s = {};
    try { s = JSON.parse(state.store[NAI_SAFETY_KEY] || '{}') || {}; } catch (_) {}
    const num = (v, d, max) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : d; };
    return { batchGapSec: num(s.batchGapSec, 6, 120), hourlyLimit: Math.round(num(s.hourlyLimit, 30, 1000)) };
}
function recentNaiCount() {
    let list = [];
    try { list = JSON.parse(state.store[NAI_LOG_KEY] || '[]'); } catch (_) {}
    const hourAgo = Date.now() - 3600 * 1000;
    return (Array.isArray(list) ? list : []).filter(t => Number(t) > hourAgo).length;
}
function collectSafety() {
    const out = {};
    $$('#main [data-safety]').forEach(el => { out[el.dataset.safety] = Number(el.value || 0); });
    return out;
}

function renderKeys() {
    const main = $('#main');
    const g = readGlobalSettings();
    const safety = readNaiSafety();
    const st = keyStatus(g);
    const provider = st.provider;
    const pv = PROVIDERS.find(p => p.value === provider) || PROVIDERS[0];

    const fieldHtml = ([key, label, type, placeholder = '']) => {
        const v = esc(g[key] ?? '');
        let input;
        if (type === 'textarea') {
            input = `<textarea class="key-input" data-key="${key}" rows="5" spellcheck="false" placeholder="${esc(placeholder)}">${v}</textarea>`;
        } else if (type === 'auth') {
            input = `<select data-key="${key}">${[['bearer', 'Authorization: Bearer'], ['x-api-key', 'x-api-key'], ['api-key', 'api-key'], ['none', '인증 없음']]
                .map(([val, t]) => `<option value="${val}" ${(g[key] || 'bearer') === val ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
        } else if (type === 'secret') {
            input = `<div class="secret-field">
                <input class="key-input mono" type="password" data-key="${key}" value="${v}" spellcheck="false" autocomplete="off" placeholder="${esc(placeholder || '붙여 넣기')}">
                <button type="button" class="secret-eye" data-reveal aria-label="키 보기" title="키 보기">${KEY_ICONS.eye}</button>
            </div>`;
        } else {
            input = `<input class="key-input${/model|Model|Url|Location|Project/.test(key) ? ' mono' : ''}" type="text" data-key="${key}" value="${v}" spellcheck="false" autocomplete="off" placeholder="${esc(placeholder)}">`;
        }
        return `<div class="key-field"><label>${esc(label)}</label>${input}</div>`;
    };

    const pill = (ok, okText, noText) => `<span class="key-pill ${ok ? 'is-ok' : 'is-missing'}">${ok ? '✓' : '✕'} ${ok ? okText : noText}</span>`;
    const ready = st.nai && st.analysis;
    const missing = [!st.nai && 'NovelAI 키', !st.analysis && '장면 분석 AI 키'].filter(Boolean);

    main.innerHTML = `
        <div class="keys-page">
            <div class="page-head"><div><h1>공통 설정 · API 키</h1>
                <p>여기 넣은 값은 <b>모든 사이트 · 모든 채팅</b>에서 같이 써요. 채팅방 🎨 › 설정 › API 탭과 같은 값이에요.</p></div></div>

            <div class="ready-banner ${ready ? 'is-ok' : 'is-warn'}">
                <span class="ready-icon">${ready ? '✓' : '!'}</span>
                <div><b>${ready ? '삽화를 만들 준비가 됐어요' : `${missing.join('와 ')}가 필요해요`}</b>
                <small>${ready ? '어느 채팅 사이트에서든 바로 생성할 수 있어요.' : '두 키가 모두 있어야 장면을 분석하고 그림을 그릴 수 있어요.'}</small></div>
            </div>

            <section class="key-card">
                <header>
                    <span class="key-card-icon">${KEY_ICONS.image}</span>
                    <div class="key-card-title"><b>NovelAI</b><small>이미지 생성</small></div>
                    ${pill(st.nai, '키 있음', '키 없음')}
                </header>
                <div class="key-grid">
                    ${fieldHtml(['naiApiKey', 'API Key / Persistent Token', 'secret', 'pst-…'])}
                    <div class="key-field"><label>모델</label>
                        <select data-key="naiModel">${['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview', 'nai-diffusion-3', 'nai-diffusion-furry-3']
                            .map(m => `<option value="${m}" ${(g.naiModel || 'nai-diffusion-5-full') === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
                </div>
                <p class="key-hint">novelai.net › 계정 설정 › Get Persistent API Token 에서 발급해요.</p>
            </section>

            <section class="key-card">
                <header>
                    <span class="key-card-icon">${KEY_ICONS.brain}</span>
                    <div class="key-card-title"><b>장면 분석 AI</b><small>답변을 읽고 그릴 장면 · 프롬프트를 정해요</small></div>
                    ${pill(st.analysis, '키 있음', '키 없음')}
                </header>
                <div class="key-grid">
                    <div class="key-field is-wide"><label>공급자</label>
                        <select data-key="geminiProvider" id="kp-provider">${PROVIDERS.map(p => `<option value="${p.value}" ${p.value === provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
                    ${pv.fields.map(f => fieldHtml(f).replace('class="key-field"', `class="key-field${f[2] === 'textarea' || f[0] === 'customApiUrl' ? ' is-wide' : ''}"`)).join('')}
                    ${provider === 'custom' ? '<div class="perm-row" id="kp-perm"></div>' : ''}
                </div>
                <p class="key-hint">${esc(PROVIDER_HINTS[provider] || '')}</p>
            </section>

            <section class="key-card">
                <header>
                    <span class="key-card-icon">${KEY_ICONS.shield}</span>
                    <div class="key-card-title"><b>NovelAI 안전 설정</b><small>요청이 한꺼번에 몰리지 않게 · 0이면 끔</small></div>
                    <span class="key-pill is-ok">최근 1시간 ${recentNaiCount()}장</span>
                </header>
                <div class="key-grid two">
                    <div class="key-field"><label>여러 장 생성 사이 쉬는 시간 (초)</label>
                        <input class="key-input" type="number" min="0" max="120" step="1" data-safety="batchGapSec" value="${safety.batchGapSec}">
                        <small class="field-help">스피드 생성 · 장면 2~3장을 그릴 때 장면 사이에 이만큼 (+0~2초) 쉬어요.</small></div>
                    <div class="key-field"><label>시간당 생성 한도 (장)</label>
                        <input class="key-input" type="number" min="0" max="1000" step="1" data-safety="hourlyLimit" value="${safety.hourlyLimit}">
                        <small class="field-help">최근 1시간 생성 수가 넘으면 멈추고 계속할지 물어요. 모든 사이트 합계예요.</small></div>
                </div>
                <p class="key-hint">NovelAI의 계정 정지 기준은 공개돼 있지 않아요. 이 설정은 요청을 사람이 쓰는 속도에 가깝게 맞추는 장치일 뿐, 정지를 막아 준다는 보장은 아니에요.</p>
            </section>

            <section class="key-note">
                <span class="key-note-icon">${KEY_ICONS.info}</span>
                <div><b>유저스크립트에서 쓰던 키가 있다면</b>
                <small>유니챗 채팅방에서 🎨 › <b>유저스크립트 기록 가져오기</b>를 누르면 키 · 프리셋 · 방별 설정 · 이미지가 한 번에 넘어와요.</small></div>
            </section>

            <div class="save-bar" id="kp-bar">
                <span id="kp-msg">변경사항이 없어요</span>
                <button class="btn ghost" id="kp-revert" disabled>되돌리기</button>
                <button class="btn primary" id="kp-save" disabled>저장</button>
            </div>
        </div>`;

    const bar = $('#kp-bar');
    const setDirty = (dirty) => {
        bar.classList.toggle('is-dirty', dirty);
        $('#kp-save').disabled = !dirty;
        $('#kp-revert').disabled = !dirty;
        $('#kp-msg').textContent = dirty ? '저장하지 않은 변경사항이 있어요' : '변경사항이 없어요';
    };
    const snapshot = () => JSON.stringify([collectKeyForm(), collectSafety()]);
    const initial = snapshot();
    const page = $('.keys-page');
    page.addEventListener('input', () => setDirty(snapshot() !== initial));
    page.addEventListener('change', () => setDirty(snapshot() !== initial));
    if (renderKeys._pendingDirty) { setDirty(true); renderKeys._pendingDirty = false; }

    $('#kp-provider').onchange = (e) => {
        // 공급자를 바꾸면 그 공급자 칸을 보여 준다 (저장 전 입력값은 유지)
        const draft = collectKeyForm();
        state.store[LS + GLOBAL_SETTINGS] = encodeJson({ ...readGlobalSettings(), ...draft, geminiProvider: e.target.value });
        renderKeys._pendingDirty = true;
        renderKeys();
    };
    $$('[data-reveal]', main).forEach(b => b.onclick = () => {
        const input = b.previousElementSibling;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        b.innerHTML = show ? KEY_ICONS.eyeOff : KEY_ICONS.eye;
        b.title = show ? '키 숨기기' : '키 보기';
    });
    // 커스텀 주소: 기본 목록에 없는 서버라 접속 허용이 따로 필요하다 (그 주소만)
    const customOrigin = () => {
        try { return new URL($('[data-key="customApiUrl"]')?.value.trim()).origin; } catch (_) { return ''; }
    };
    const refreshPerm = async () => {
        const box = $('#kp-perm');
        if (!box) return;
        const origin = customOrigin();
        if (!origin) { box.innerHTML = ''; return; }
        const ok = await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false);
        box.innerHTML = ok
            ? `<span class="perm-state is-ok">✓ ${esc(origin)} 접속 허용됨</span>`
            : `<span class="perm-state is-need">🔒 ${esc(origin)} 접속 허용이 필요해요</span><button type="button" class="btn small primary" id="kp-grant">허용</button>`;
        const grant = $('#kp-grant');
        if (grant) grant.onclick = () => {
            chrome.permissions.request({ origins: [`${origin}/*`] }).then(refreshPerm).catch(() => {});
        };
    };
    refreshPerm();
    $('[data-key="customApiUrl"]')?.addEventListener('change', refreshPerm);

    $('#kp-revert').onclick = async () => { await loadAll(); renderKeys(); };
    const save = async () => {
        if ($('#kp-save').disabled) return;
        // 커스텀 주소면 저장하면서 접속 허용도 같이 묻는다 (클릭 직후라야 크롬이 창을 띄운다 — await 전에 호출)
        const origin = provider === 'custom' ? customOrigin() : '';
        const permAsk = origin ? chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false) : null;
        const fresh = decodeJson((await chrome.storage.local.get(LS + GLOBAL_SETTINGS))[LS + GLOBAL_SETTINGS], {});
        const next = { ...fresh, ...collectKeyForm() };
        const safetyNext = { ...readNaiSafety(), ...collectSafety() };
        await chrome.storage.local.set({ [LS + GLOBAL_SETTINGS]: encodeJson(next), [NAI_SAFETY_KEY]: JSON.stringify(safetyNext) });
        const granted = permAsk ? await permAsk : true;
        await loadAll();
        renderKeys();
        toast(granted ? '저장했어요. 열려 있는 채팅 탭에도 바로 적용돼요.' : '저장했어요. 다만 그 주소 접속을 허용하지 않아서 아직 쓸 수 없어요.');
    };
    $('#kp-save').onclick = save;
    page.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
}

function collectKeyForm() {
    const out = {};
    $$('#main [data-key]').forEach(el => { out[el.dataset.key] = String(el.value || '').trim(); });
    return out;
}

// ── 환경설정 ─────────────────────────────────────────────────
function renderPrefs() {
    const main = $('#main');
    const theme = state.store[LS + 'csp_ext_theme'] || 'warm';
    const uiMode = state.store.csp_ui_mode_v1 || 'fab';
    main.innerHTML = `
        <div class="page-head"><div><h1>환경설정</h1><p>이미지 생성 옵션 · API 키 · 프롬프트는 채팅방의 🎨 › 설정에서 바꿔요.</p></div></div>
        <div class="panel">
            <div class="form-row"><span class="label"><b>메뉴 열기</b><small>플로팅 버튼: 채팅 화면에 🎨 버튼 · 확장 패널: 툴바의 확장 아이콘(단축키 Alt+Shift+S)</small></span>
                <select id="pf-uimode">
                    <option value="fab" ${uiMode === 'fab' ? 'selected' : ''}>플로팅 버튼</option>
                    <option value="panel" ${uiMode === 'panel' ? 'selected' : ''}>확장 패널</option>
                    <option value="both" ${uiMode === 'both' ? 'selected' : ''}>둘 다</option>
                </select></div>
            <div class="form-row"><span class="label"><b>테마</b><small>채팅 화면의 메뉴 · 설정창 · 퀵 패널 색</small></span>
                <select id="pf-theme">
                    <option value="warm" ${theme === 'warm' ? 'selected' : ''}>따뜻한 베이지 (기본)</option>
                    <option value="dark" ${theme === 'dark' ? 'selected' : ''}>다크</option>
                    <option value="light" ${theme === 'light' ? 'selected' : ''}>라이트</option>
                    <option value="auto" ${theme === 'auto' || theme === 'site' ? 'selected' : ''}>시스템 설정 따라가기 (밝게/어둡게)</option>
                </select></div>
            <div class="form-row"><span class="label"><b>위치 자동 복구</b><small>사이트가 바뀌어서 AI 답변을 못 찾으면 규칙에 따라 알아서 고쳐요 (되돌리기 가능)</small></span>
                <label class="switch"><input type="checkbox" id="pf-autorepair" ${state.store[LS + 'csp_ext_autorepair'] !== 'off' ? 'checked' : ''}><span></span></label></div>
        </div>
        <div class="panel">
            <h2>정리</h2>
            <div class="form-row"><span class="label"><b>고아 이미지 정리</b><small>어떤 장면 기록에도 연결되지 않은 이미지를 찾아 지워요</small></span>
                <button class="btn" id="pf-orphans">찾기</button></div>
            <div class="form-row"><span class="label"><b>모든 데이터 삭제</b><small>설정 · 기록 · 이미지 · 사이트 설정 전부. 되돌릴 수 없어요.</small></span>
                <button class="btn danger" id="pf-wipe">전부 삭제</button></div>
        </div>`;
    $('#pf-uimode').onchange = async (e) => {
        await chrome.storage.local.set({ csp_ui_mode_v1: e.target.value });
        await loadAll();
        toast('바꿨어요. 열려 있는 채팅 화면에 바로 반영돼요.');
    };
    $('#pf-autorepair').onchange = async (e) => {
        await chrome.storage.local.set({ [LS + 'csp_ext_autorepair']: e.target.checked ? 'on' : 'off' });
        await loadAll();
        toast(e.target.checked ? '자동 복구를 켰어요.' : '자동 복구를 껐어요.');
    };
    $('#pf-theme').onchange = async (e) => {
        await chrome.storage.local.set({ [LS + 'csp_ext_theme']: e.target.value });
        await loadAll();
        toast('바꿨어요. 채팅 화면은 메뉴를 다시 열면 반영돼요.');
    };
    $('#pf-orphans').onclick = async () => {
        const used = new Set();
        for (const [k, v] of Object.entries(state.store)) {
            if (!k.startsWith(LS + SCENE_RECORDS)) continue;
            for (const rec of Object.values(decodeJson(v, {}))) {
                if (rec?.imageId) used.add(rec.imageId);
                for (const item of rec?.history || []) if (item?.imageId) used.add(item.imageId);
            }
        }
        const orphans = state.images.filter(img => !used.has(img.id));
        if (!orphans.length) { toast('정리할 이미지가 없어요.'); return; }
        const size = orphans.reduce((s, i) => s + (i.size || 0), 0);
        if (!confirm(`기록에 연결되지 않은 이미지 ${orphans.length}장(${fmtSize(size)})을 지울까요?`)) return;
        for (const img of orphans) await DB.deleteImage(img.id);
        await loadAll();
        toast(`${orphans.length}장 지웠어요.`);
    };
    $('#pf-wipe').onclick = async () => {
        const typed = prompt('정말 전부 지우려면 "삭제"라고 입력하세요.');
        if (typed !== '삭제') return;
        await chrome.storage.local.clear();
        await DB.clearAll();
        await loadAll();
        toast('모두 지웠어요.');
        route();
    };
}

// ── 라우팅 ───────────────────────────────────────────────────
function route() {
    const hash = decodeURIComponent(location.hash.slice(1) || 'chats');
    let view = hash.split('=')[0];
    if (hash.startsWith('chat=')) view = 'chats';
    $$('.nav a').forEach(a => a.classList.toggle('is-active', a.dataset.view === view));
    if (hash.startsWith('chat=')) renderChat(hash.slice(5));
    else if (view === 'gallery') renderGallery();
    else if (view === 'keys') renderKeys();
    else if (view === 'sites') renderSites();
    else if (view === 'backup') renderBackup();
    else if (view === 'prefs') renderPrefs();
    else renderChats();
}

window.addEventListener('hashchange', route);
$$('.nav a').forEach(a => a.addEventListener('click', () => { state.filter = 'all'; }));

// 다른 탭에서 삽화가 생기면 갱신 (편집 중인 사이트 설정 화면은 건드리지 않는다)
// 채팅 탭은 설정을 자주 저장한다. 그때마다 전부 다시 읽으면 브라우저 전체가 버벅여서
//   · 보관함에 영향 있는 키만 보고   · 이 탭이 안 보이면 미뤘다가 보일 때 한 번만   · 1.5초 모아서
const RELEVANT_KEY = (k) => k === CHATS_KEY || k === P.SITES_KEY || k === LS + 'csp_ext_theme' || k === 'csp_ui_mode_v1'
    || k.startsWith(LS + SCENE_RECORDS) || k.startsWith(LS + ROOM_SETTINGS);
let refreshTimer = 0;
let refreshPending = false;
function scheduleRefresh() {
    if (document.hidden) { refreshPending = true; return; }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
        refreshPending = false;
        await loadAll();
        const view = location.hash.slice(1).split('=')[0] || 'chats';
        if (['chats', 'chat', 'gallery'].includes(view) && $('#lightbox').hidden) route();
    }, 1500);
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!Object.keys(changes).some(RELEVANT_KEY)) return;
    scheduleRefresh();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && refreshPending) scheduleRefresh(); });

try { $('#ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) {}
loadAll().then(route);
