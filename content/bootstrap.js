// Scene Painter 확장 — 콘텐츠 부트스트랩
// core.js(원래 유저스크립트)가 기대하는 환경을 만들어 준다.
//  · localStorage  → chrome.storage.local 미러 (동기 읽기 · 비동기 쓰기)
//  · GM_xmlhttpRequest → 백그라운드 fetch 대리
//  · CSP_EXT: 현재 플랫폼/채팅방, 이미지 저장소, 위치 지정(피커), 관리 페이지 열기
(function () {
    'use strict';
    if (window.__CSP_EXT_BOOTSTRAPPED__) return;
    window.__CSP_EXT_BOOTSTRAPPED__ = true;

    const P = globalThis.CSP_PLATFORMS;
    const LS_PREFIX = 'ls:';
    const CHATS_KEY = 'csp_chats_v1';
    const SITE_UI_KEY = 'csp_site_ui_v1';

    // ── localStorage 미러 ────────────────────────────────────
    const cache = new Map();
    const pendingSet = new Map();
    const pendingRemove = new Set();
    let flushTimer = 0;
    let extAlive = true;

    function isContextAlive() {
        try { return !!chrome.runtime?.id; } catch (_) { return false; }
    }

    // 확장을 업데이트/새로고침하면 이미 열려 있던 탭의 이 스크립트는 확장과 끊긴다.
    // 그 상태에서 chrome.* 을 부르면 "Extension context invalidated" 오류가 난다.
    // → 끊긴 걸 알아채면 한 번만 안내를 띄우고, 이후 확장 기능 호출은 조용히 건너뛴다.
    let staleNotified = false;
    function notifyStale() {
        if (staleNotified) return;
        staleNotified = true;
        try {
            const bar = document.createElement('div');
            bar.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:10px;align-items:center;padding:10px 12px 10px 16px;border-radius:14px;background:#2a2118;color:#f6ecdc;font:600 13px/1.4 "Pretendard","Malgun Gothic",system-ui,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.35)';
            bar.innerHTML = '<span>Vignette가 업데이트됐어요. 이 탭을 새로고침하면 다시 동작해요.</span>';
            const reload = document.createElement('button');
            reload.textContent = '새로고침';
            reload.style.cssText = 'all:unset;cursor:pointer;padding:5px 11px;border-radius:9px;background:#e8833a;color:#fff;font-weight:700';
            reload.onclick = () => location.reload();
            const close = document.createElement('button');
            close.textContent = '✕';
            close.style.cssText = 'all:unset;cursor:pointer;padding:4px 6px;opacity:.7';
            close.onclick = () => bar.remove();
            bar.append(reload, close);
            document.documentElement.appendChild(bar);
        } catch (_) {}
    }
    // 확장 호출 전에 확인: 끊겼으면 안내하고 false
    function ensureAlive() {
        if (isContextAlive()) return true;
        notifyStale();
        return false;
    }
    // 어디선가 놓친 끊김 오류는 콘솔/확장 오류 목록에 남기지 않고 안내로 바꾼다
    window.addEventListener('unhandledrejection', (e) => {
        if (/Extension context invalidated/i.test(String(e.reason?.message || e.reason || ''))) {
            e.preventDefault();
            notifyStale();
        }
    });
    window.addEventListener('error', (e) => {
        if (/Extension context invalidated/i.test(String(e.message || ''))) {
            e.preventDefault();
            notifyStale();
        }
    });

    function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = setTimeout(flush, 60);
    }

    function flush() {
        flushTimer = 0;
        if (!isContextAlive()) { extAlive = false; notifyStale(); return; }
        if (pendingSet.size) {
            const batch = {};
            pendingSet.forEach((v, k) => { batch[LS_PREFIX + k] = v; });
            pendingSet.clear();
            chrome.storage.local.set(batch).catch(err => console.info('[Vignette] storage write failed', err));
        }
        if (pendingRemove.size) {
            const keys = Array.from(pendingRemove).map(k => LS_PREFIX + k);
            pendingRemove.clear();
            chrome.storage.local.remove(keys).catch(() => {});
        }
    }
    window.addEventListener('pagehide', flush);

    const storageApi = {
        getItem(key) { key = String(key); return cache.has(key) ? cache.get(key) : null; },
        setItem(key, value) {
            key = String(key); value = String(value);
            cache.set(key, value);
            pendingRemove.delete(key);
            pendingSet.set(key, value);
            scheduleFlush();
            noteRoomDataWrite(key);
        },
        removeItem(key) {
            key = String(key);
            cache.delete(key);
            pendingSet.delete(key);
            pendingRemove.add(key);
            scheduleFlush();
        },
        clear() { Array.from(cache.keys()).forEach(k => storageApi.removeItem(k)); },
        key(i) { return Array.from(cache.keys())[i] ?? null; },
        get length() { return cache.size; }
    };

    // Object.keys(localStorage) 를 그대로 쓰는 코드가 많아서 Proxy로 흉내 낸다.
    // 메서드는 한 번만 묶어 둔다 (예전엔 localStorage.getItem 을 부를 때마다 bind로 새 함수를 만들었다)
    const boundApi = {
        getItem: storageApi.getItem.bind(storageApi),
        setItem: storageApi.setItem.bind(storageApi),
        removeItem: storageApi.removeItem.bind(storageApi),
        clear: storageApi.clear.bind(storageApi),
        key: storageApi.key.bind(storageApi)
    };
    const lsShim = new Proxy({}, {
        get(_, prop) {
            if (prop in boundApi) return boundApi[prop];
            if (prop === 'length') return cache.size;
            if (typeof prop === 'string' && cache.has(prop)) return cache.get(prop);
            return undefined;
        },
        set(_, prop, value) { storageApi.setItem(prop, value); return true; },
        deleteProperty(_, prop) { storageApi.removeItem(prop); return true; },
        has(_, prop) { return cache.has(String(prop)); },
        ownKeys() { return Array.from(cache.keys()); },
        getOwnPropertyDescriptor(_, prop) {
            if (!cache.has(String(prop))) return undefined;
            return { value: cache.get(String(prop)), writable: true, enumerable: true, configurable: true };
        }
    });

    // ── 사이트/채팅방 ─────────────────────────────────────────
    let sites = {};
    let platform = null;
    const listeners = new Set();
    // 메뉴를 어디서 열지: 'fab'(플로팅 버튼) · 'panel'(확장 아이콘 패널) · 'both'
    const UI_MODE_KEY = 'csp_ui_mode_v1';
    let uiMode = 'fab';
    let panelHandler = null;

    function refreshPlatform() {
        platform = P.matchPlatform(new URL(location.href), sites);
    }

    function getChatId() {
        if (!platform) return '';
        return P.extractChatId(platform, location);
    }

    let _roomKeyMemo = { pid: null, chatId: null, key: 'global_room' };
    function getRoomKey() {
        const chatId = getChatId();
        if (!chatId) return 'global_room';
        if (_roomKeyMemo.pid !== platform.id || _roomKeyMemo.chatId !== chatId) {
            _roomKeyMemo = { pid: platform.id, chatId, key: P.makeRoomKey(platform.id, chatId) };
        }
        return _roomKeyMemo.key;
    }

    async function saveSiteConfig(patch) {
        if (!platform || !ensureAlive()) return;
        const res = await chrome.storage.local.get(P.SITES_KEY);
        const all = res[P.SITES_KEY] || {};
        const base = all[platform.id] || { ...platform };
        all[platform.id] = { ...base, userEdited: true, ...patch };
        sites = all;
        refreshPlatform();
        await chrome.storage.local.set({ [P.SITES_KEY]: all });
        listeners.forEach(fn => { try { fn('site'); } catch (_) {} });
    }

    // ── 채팅방 목록 (관리 페이지가 보는 색인) ─────────────────────
    // 들어가 본 채팅을 전부 적으면 보관함이 금방 넘친다. 색인은
    //   · 삽화를 만들었거나 (extra.lastImageAt)
    //   · 그 방 설정/장면 기록을 저장했을 때 (extra.create)
    // 처음 만든다. 그냥 방문하면 이미 있는 항목의 최근 방문 시각만 갱신한다.
    let chatTouchTimer = 0;
    let pendingCreate = false;
    function touchChat(extra = {}) {
        clearTimeout(chatTouchTimer);
        if (extra.create || extra.lastImageAt) pendingCreate = true;
        chatTouchTimer = setTimeout(async () => {
            const create = pendingCreate;
            pendingCreate = false;
            if (!isContextAlive() || !platform) return;
            const chatId = getChatId();
            if (!chatId) return;
            const roomKey = P.makeRoomKey(platform.id, chatId);
            const res = await chrome.storage.local.get(CHATS_KEY);
            const chats = res[CHATS_KEY] || {};
            if (!chats[roomKey] && !create) return;
            const prev = chats[roomKey] || {};
            const title = (document.title || '').trim().slice(0, 120);
            // 이미 있는 항목이고 1분 안에 갱신했고 제목도 그대로면 쓰지 않는다
            // (설정을 저장할 때마다 색인을 다시 쓰면 열려 있는 관리 페이지까지 매번 깨운다)
            if (chats[roomKey] && !extra.lastImageAt && Date.now() - (prev.lastVisited || 0) < 60000 && (prev.customTitle || prev.title === title)) return;
            chats[roomKey] = {
                ...prev,
                roomKey,
                platformId: platform.id,
                platformName: platform.name || platform.id,
                chatId,
                url: location.origin + location.pathname,
                title: extra.title || (prev.customTitle ? prev.title : title) || prev.title || chatId,
                firstSeen: prev.firstSeen || Date.now(),
                lastVisited: Date.now(),
                ...(extra.lastImageAt ? { lastImageAt: extra.lastImageAt } : {})
            };
            await chrome.storage.local.set({ [CHATS_KEY]: chats });
        }, extra.lastImageAt ? 50 : 1500);
    }

    // 이 방의 설정/장면 기록이 저장되면 보관함에 올린다.
    const ROOM_DATA_PREFIXES = ['csp_scene_painter_room_settings_', 'csp_scene_painter_scene_records_'];
    function noteRoomDataWrite(key) {
        if (!ROOM_DATA_PREFIXES.some(p => key.startsWith(p))) return;
        if (key.endsWith('_' + getRoomKey())) touchChat({ create: true });
    }

    // ── RPC ─────────────────────────────────────────────────
    function rpc(type, payload) {
        return new Promise((resolve, reject) => {
            if (!isContextAlive()) {
                notifyStale();
                reject(new Error('확장 프로그램이 업데이트/재시작됐어요. 페이지를 새로고침해줘.'));
                return;
            }
            chrome.runtime.sendMessage({ type, payload }, (res) => {
                const err = chrome.runtime.lastError;
                if (err) { reject(new Error(err.message)); return; }
                if (!res?.ok) { reject(new Error(res?.error || '확장 통신 실패')); return; }
                resolve(res.result);
            });
        });
    }

    // ── GM_xmlhttpRequest ─────────────────────────────────────
    function base64ToArrayBuffer(b64) {
        // 최신 크롬은 내장 변환이 훨씬 빠르다 (수 MB 이미지 응답)
        if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64 || '').buffer;
        const bin = atob(b64 || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    function GM_xmlhttpRequest(details) {
        let port = null;
        let done = false;
        let keepAlive = 0;
        const finish = (cb, arg) => {
            if (done) return;
            done = true;
            clearInterval(keepAlive);
            try { cb?.(arg); } catch (e) { console.error(e); }
        };
        try {
            if (!isContextAlive()) throw new Error('extension context invalidated');
            port = chrome.runtime.connect({ name: 'csp-xhr' });
        } catch (err) {
            setTimeout(() => finish(details.onerror, { status: 0, statusText: String(err.message || err), responseText: '' }), 0);
            return { abort() {} };
        }
        port.onMessage.addListener((msg) => {
            if (msg.type === 'load') {
                const response = {
                    status: msg.status,
                    statusText: msg.statusText,
                    responseText: msg.responseText || '',
                    responseHeaders: msg.responseHeaders || '',
                    finalUrl: msg.finalUrl,
                    readyState: 4
                };
                const rt = details.responseType;
                if (msg.base64 != null) {
                    const buf = base64ToArrayBuffer(msg.base64);
                    response.response = rt === 'blob' ? new Blob([buf], { type: msg.contentType || '' }) : buf;
                } else if (rt === 'json') {
                    try { response.response = JSON.parse(response.responseText); } catch (_) { response.response = null; }
                } else {
                    response.response = response.responseText;
                }
                finish(details.onload, response);
            } else if (msg.type === 'timeout') {
                finish(details.ontimeout, { status: 0, statusText: 'timeout' });
            } else if (msg.type === 'abort') {
                finish(details.onabort, { status: 0, statusText: 'abort' });
            } else if (msg.type === 'error') {
                finish(details.onerror, { status: 0, statusText: msg.error, responseText: '', error: msg.error });
            }
        });
        port.onDisconnect.addListener(() => {
            if (!done) finish(details.onerror, { status: 0, statusText: 'disconnected', responseText: '' });
        });
        let body = details.data;
        if (body != null && typeof body !== 'string') {
            // FormData/Blob은 지금 코드에서 쓰지 않는다 — 문자열로만 보낸다.
            body = typeof body === 'object' ? JSON.stringify(body) : String(body);
        }
        port.postMessage({
            type: 'request',
            method: details.method || 'GET',
            url: details.url,
            headers: details.headers || {},
            data: body,
            responseType: details.responseType || 'text',
            timeout: details.timeout || 0
        });
        // 서비스 워커는 30초 동안 아무 이벤트가 없으면 잠든다. 오래 걸리는 이미지 생성 중엔 깨워 둔다.
        keepAlive = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch (_) { clearInterval(keepAlive); } }, 20000);
        return {
            abort() {
                if (done) return;
                try { port.postMessage({ type: 'abort' }); } catch (_) {}
                finish(details.onabort, { status: 0, statusText: 'abort' });
                try { port.disconnect(); } catch (_) {}
            }
        };
    }

    // ── 위치 지정 피커 ─────────────────────────────────────────
    const VOLATILE_CLASS = /^(?:hover|focus|active|selected|is-|has-|animate|transition|duration-|ease-|opacity-|group$|peer$|last|first|odd|even|show|open|visible|hidden$|ng-|v-|css-[a-z0-9]{5,}$|sc-[a-zA-Z]{5,}$|jsx-\d+|csp-)/;

    function stableClasses(el) {
        return Array.from(el.classList || [])
            .filter(c => c && c.length < 60
                && !VOLATILE_CLASS.test(c)
                && !/\d{4,}/.test(c)
                // styled-components 같은 무작위 이름(kXpLgH)은 배포마다 바뀐다
                && !/^(?=.*[a-z])(?=.*[A-Z])[a-zA-Z]{5,8}$/.test(c)
                // 상태에 따라 붙었다 떨어지는 Tailwind 변형(hover:, data-[state=open]: …)
                && !/^(?:hover|focus|active|group-hover|data-\[|aria-)/.test(c))
            .slice(0, 6);
    }

    // 상태 따라 바뀌거나 메시지마다 다른 값이라 셀렉터에 넣으면 안 되는 속성
    const VOLATILE_ATTR = /^(?:data-(?:state|headlessui-state|active|selected|hover|focus|highlighted|open|index|item-index|known-size|nimg|radix.*|testid-index|scroll.*|edit.*|orientation|side|align|disabled|loading|pressed|expanded)|aria-.*|style|class|id|href|src|title|alt|tabindex|role|dir|lang|width|height|draggable|contenteditable|spellcheck)$/;

    // 역할을 알려 주는 속성은 셀렉터에 넣는다. 내 메시지와 AI 답변의 구조가 똑같은 사이트
    // (예: data-message-id="assistant-12" / "user-12")에서 둘을 가를 수 있는 유일한 단서다.
    //   · "assistant-130" 처럼 글자+숫자 → [attr^="assistant"]
    //   · "true", "char" 처럼 짧은 낱말 → [attr="char"]
    //   · uuid · 순번 · 긴 값 → 버린다 (메시지마다 다르다)
    function stableAttrs(el) {
        const out = [];
        for (const attr of Array.from(el.attributes || [])) {
            const name = attr.name;
            if (!name.startsWith('data-') || VOLATILE_ATTR.test(name)) continue;
            const v = String(attr.value || '');
            const prefix = v.match(/^([a-zA-Z][a-zA-Z_]*?)[-_:]?\d/);
            if (prefix && prefix[1].length >= 2) {
                out.push(`[${name}^="${CSS.escape(prefix[1])}"]`);
            } else if (/^[a-zA-Z][a-zA-Z_-]{0,15}$/.test(v)) {
                out.push(`[${name}="${CSS.escape(v)}"]`);
            } else if (v === '') {
                out.push(`[${name}]`);
            }
            if (out.length >= 3) break;
        }
        return out;
    }

    function sigOf(el) {
        const tag = el.tagName.toLowerCase();
        const cls = stableClasses(el).map(c => '.' + CSS.escape(c)).join('');
        return tag + cls + stableAttrs(el).join('');
    }

    function sameSet(a, b) {
        if (a.length !== b.length) return false;
        const s = new Set(a);
        return b.every(x => s.has(x));
    }

    // 고른 요소와 "같은 자리"에 있는 다른 메시지 요소들까지 잡히는 셀렉터를 만든다.
    // 1) 맨 위(body)까지 조상 시그니처를 > 로 이은 전체 경로를 만든다.
    // 2) 위에서부터 한 칸씩 떼어 보며, 잡히는 집합이 그대로면 뗀다 (짧고 덜 깨지게).
    function buildSelector(target) {
        const chain = [];
        let el = target;
        while (el && el !== document.body && el !== document.documentElement && chain.length < 14) {
            chain.unshift(el);
            el = el.parentElement;
        }
        const parts = chain.map(sigOf);
        const full = parts.join(' > ');
        let base;
        try { base = Array.from(document.querySelectorAll(full)); } catch (_) { return full; }
        if (!base.includes(target)) return full;
        let start = 0;
        while (start < parts.length - 1) {
            const candidate = parts.slice(start + 1).join(' > ');
            let found;
            try { found = Array.from(document.querySelectorAll(candidate)); } catch (_) { break; }
            if (!sameSet(found, base)) break;
            start++;
        }
        // 3) 가운데 래퍼들을 건너뛰어도(맨 위 + 맨 아래) 같은 집합이면 그걸 쓴다.
        //    사이트가 래퍼 div 하나 끼워 넣는 정도의 변경엔 깨지지 않는다.
        const last = parts.length - 1;
        if (last - start >= 2) {
            const short = `${parts[start]} ${parts[last]}`;
            try { if (sameSet(Array.from(document.querySelectorAll(short)), base)) return short; } catch (_) {}
        }
        return parts.slice(start).join(' > ');
    }

    // 위치 지정 안내 — 무엇을 눌러야 하는지 그림(예시)과 함께 보여 준다.
    // hl: 예시 그림에서 강조할 칸 (body · footer · user)
    const PICK_LABELS = {
        body: {
            title: '본문 위치 지정',
            hint: 'AI 답변의 <b>글 부분</b>을 클릭해줘. 문단 하나만 눌러도 답변 전체로 자동으로 잡혀.',
            good: ['답변 글(서술·대사) 아무 곳', '여러 문단이 있으면 그중 아무 문단'],
            bad: ['캐릭터 이름 · 프로필 사진', '상태창 · 이미지 · 버튼 줄', '내가 보낸 메시지']
        },
        footer: {
            title: '하단 위치 지정',
            hint: 'AI 답변 <b>아래(또는 위) 버튼 줄</b>을 클릭해줘. 버튼 하나만 눌러도 줄 전체로 잡혀. 삽화 버튼이 여기에 붙어.',
            good: ['복사 · 재생성 · 수정 버튼이 모인 줄', '버튼 아무거나 하나'],
            bad: ['입력창 옆 전송 버튼', '화면 위쪽 메뉴']
        },
        user: {
            title: '내 메시지 제외',
            hint: '<b>내가 보낸 메시지의 글</b>을 클릭해줘. 같은 자리는 삽화 대상에서 빠져. 내 메시지에도 삽화 버튼이 붙을 때만 쓰면 돼.',
            good: ['내가 보낸 메시지 글'],
            bad: ['AI 답변']
        }
    };

    // 채팅 화면을 단순하게 그린 예시. 고를 칸만 주황 테두리로 강조한다.
    function pickExampleHtml(kind) {
        const hl = (k) => (k === kind ? ' is-hl' : '');
        return `<div class="csp-ex-chat" aria-hidden="true">
            <div class="csp-ex-user${hl('user')}"><i style="width:70%"></i></div>
            <div class="csp-ex-ai">
                <div class="csp-ex-head"><span class="csp-ex-ava"></span><i style="width:38px"></i></div>
                <div class="csp-ex-body${hl('body')}"><i></i><i style="width:92%"></i><i style="width:96%"></i><i style="width:60%"></i></div>
                <div class="csp-ex-foot${hl('footer')}"><b></b><b></b><b></b><b></b></div>
            </div>
        </div>`;
    }

    const PICKER_CSS = `
.csp-picker-box{position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #e8833a;background:rgba(232,131,58,.14);border-radius:4px;transition:all .06s}
.csp-picker-box.is-peer{border-style:dashed;background:rgba(232,131,58,.06)}
.csp-picker-bar{position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);display:grid;grid-template-columns:auto 1fr;gap:10px 14px;width:min(640px,calc(100vw - 24px));padding:12px 14px;border-radius:14px;background:#2a2118;color:#f6ecdc;font:13px/1.5 "Pretendard","Malgun Gothic",system-ui,sans-serif;box-shadow:0 14px 36px rgba(0,0,0,.4);user-select:none}
.csp-picker-bar.is-bottom{top:auto;bottom:12px}
.csp-picker-bar.is-compact{grid-template-columns:1fr}.csp-picker-bar.is-compact .csp-ex-wrap{display:none}
.csp-picker-bar b{color:#ffb877}
.csp-picker-main{display:grid;gap:6px;min-width:0}
.csp-picker-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px}
.csp-picker-lists{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:12px}
.csp-picker-lists ul{margin:0;padding:0;list-style:none}.csp-picker-lists li{margin:1px 0}
.csp-picker-lists .ok li::before{content:"✔ ";color:#7fd39a}.csp-picker-lists .no li::before{content:"✘ ";color:#ff8a7a}
.csp-picker-live{font-size:12px;padding:5px 8px;border-radius:8px;background:#3a2d20}
.csp-picker-live.is-warn{background:#5a2e22}
.csp-picker-bar.is-shake{animation:csp-picker-shake .35s ease}
@keyframes csp-picker-shake{20%{transform:translateX(calc(-50% - 7px))}40%{transform:translateX(calc(-50% + 6px))}60%{transform:translateX(calc(-50% - 4px))}80%{transform:translateX(calc(-50% + 2px))}}
.csp-picker-keys{opacity:.7;font-size:11.5px}
.csp-picker-path{font:11px/1.4 ui-monospace,monospace;opacity:.6;word-break:break-all;max-height:30px;overflow:hidden}
.csp-picker-btns{display:flex;gap:6px;flex-wrap:wrap}
.csp-picker-bar button{all:unset;cursor:pointer;padding:3px 9px;border-radius:7px;background:#4a3a2a;font-size:12px}.csp-picker-bar button:hover{background:#6b4f33}
.csp-ex-wrap{display:grid;gap:4px;justify-items:center;font-size:11px;opacity:.85}
.csp-ex-chat{width:132px;padding:8px;border-radius:10px;background:#f4ecdf;display:grid;gap:6px}
.csp-ex-chat i{display:block;height:5px;border-radius:3px;background:#c9b8a2;width:100%}
.csp-ex-user{justify-self:end;width:70%;padding:5px;border-radius:8px;background:#d8e6f6}
.csp-ex-user i{background:#9db6d3}
.csp-ex-ai{display:grid;gap:5px}
.csp-ex-head{display:flex;align-items:center;gap:5px}.csp-ex-ava{width:12px;height:12px;border-radius:50%;background:#b08a68}
.csp-ex-body{display:grid;gap:4px;padding:5px;border-radius:6px;background:#fffaf2}
.csp-ex-foot{display:flex;gap:4px;padding:3px 5px;border-radius:6px}.csp-ex-foot b{width:12px;height:9px;border-radius:3px;background:#cdbba5}
.csp-ex-chat .is-hl{outline:2px solid #e8833a;outline-offset:1px;background:rgba(232,131,58,.22);animation:csp-ex-blink 1.2s ease-in-out infinite}
@keyframes csp-ex-blink{50%{outline-color:rgba(232,131,58,.35)}}`;

    function pick(kind) {
        return new Promise((resolve) => {
            const spec = PICK_LABELS[kind] || PICK_LABELS.body;
            const box = document.createElement('div');
            box.className = 'csp-picker-box';
            const bar = document.createElement('div');
            bar.className = 'csp-picker-bar';
            const compact = storageApi.getItem('csp_picker_example_hidden') === '1';
            bar.classList.toggle('is-compact', compact);
            bar.innerHTML = `
                <div class="csp-ex-wrap">${pickExampleHtml(kind)}<span>예시: 주황색 칸</span></div>
                <div class="csp-picker-main">
                    <div class="csp-picker-title"><b>${spec.title}</b>
                        <span class="csp-picker-btns"><button type="button" data-act="example">${compact ? '예시 보기' : '예시 접기'}</button><button type="button" data-act="move">위/아래로</button></span></div>
                    <span>${spec.hint}</span>
                    <div class="csp-picker-lists">
                        <ul class="ok">${spec.good.map(t => `<li>${t}</li>`).join('')}</ul>
                        <ul class="no">${spec.bad.map(t => `<li>${t}</li>`).join('')}</ul>
                    </div>
                    <div class="csp-picker-live">마우스를 답변 위에 올려 봐.</div>
                    <span class="csp-picker-path"></span>
                    <span class="csp-picker-keys">휠 · ↑↓ : 범위 넓히기·좁히기 · 클릭/Enter: 확정 · Esc: 취소</span>
                    <span class="csp-picker-btns"><button type="button" data-act="up">범위 넓히기 ▲</button><button type="button" data-act="down">좁히기 ▼</button><button type="button" data-act="cancel">취소</button></span>
                </div>`;
            const style = document.createElement('style');
            style.textContent = PICKER_CSS;
            document.documentElement.append(style, box, bar);

            let hovered = null;   // 마우스 아래 요소
            let depth = 0;        // 0 = 자동 보정, n = 거기서 n단계 위
            let liveTimer = 0;

            // 본문인데 문단 하나를 가리키면(옆에 같은 모양 형제가 여럿) 문단들을 품은 부모로 올린다.
            //  · 혼자 들어 있는 감싸기 칸(div > span 처럼)은 먼저 건너뛰고 올라간다
            //  · 같은 모양 형제가 있는 층(= 문단 층)을 만나면 그 부모가 본문
            // 확장이 붙인 요소(삽화 버튼 줄 · 삽화 이미지)는 구조 판단에서 뺀다
            // (잘못 고른 뒤 다시 고를 때, 이미 붙은 자동 줄 때문에 판단이 틀어졌다)
            const isExtEl = (c) => typeof c.className === 'string' && c.className.includes('csp-');
            const kids = (p) => Array.from(p.children).filter(c => !isExtEl(c));
            const textOf = (n) => {
                let len = 0;
                n.childNodes.forEach(c => { if (c.nodeType === 3) len += c.textContent.trim().length; else if (c.nodeType === 1 && !isExtEl(c)) len += textOf(c); });
                return len;
            };
            const promoteToBody = (el) => {
                let cur = el;
                let promoted = false;
                for (let i = 0; i < 6 && cur?.parentElement && cur.parentElement !== document.body; i++) {
                    const parent = cur.parentElement;
                    const sig = sigOf(cur);
                    const same = kids(parent).filter(c => c !== cur && sigOf(c) === sig && textOf(c));
                    if (same.length) { cur = parent; promoted = true; continue; }
                    if (promoted) break;
                    // 형제 없이 혼자 감싸진 칸이면 한 칸 올라가서 다시 본다 (단, 글이 훨씬 많은 큰 덩어리로는 안 올라감)
                    if (kids(parent).length === 1 && textOf(parent) <= textOf(cur) + 12) { cur = parent; continue; }
                    break;
                }
                return cur;
            };
            // 하단인데 버튼 하나(또는 아이콘)를 가리키면 버튼 두 개 이상을 품은 줄로 올린다.
            const promoteToFooter = (el) => {
                let cur = el;
                for (let i = 0; i < 5 && cur.parentElement && cur.parentElement !== document.body; i++) {
                    if (cur.querySelectorAll('button, [role="button"]').length >= 2) break;
                    cur = cur.parentElement;
                }
                return cur;
            };
            // 실제로 고르게 될 요소 = 자동 보정 + 사용자가 넓힌 단계
            const current = () => {
                if (!hovered) return null;
                let el = hovered;
                if (kind === 'body' || kind === 'user') el = promoteToBody(el);
                else if (kind === 'footer') el = promoteToFooter(el);
                for (let i = 0; i < depth && el?.parentElement && el.parentElement !== document.body; i++) el = el.parentElement;
                return el;
            };
            const updateLive = () => {
                clearTimeout(liveTimer);
                liveTimer = setTimeout(() => {
                    const el = current();
                    const live = bar.querySelector('.csp-picker-live');
                    if (!el) return;
                    let count = 0;
                    try { count = document.querySelectorAll(buildSelector(el)).length; } catch (_) {}
                    const len = (el.textContent || '').trim().length;
                    let warn = '';
                    if (kind !== 'footer' && len < 20) warn = ' · 글자가 너무 적어. 범위를 넓혀 봐 (▲)';
                    else if (kind === 'footer' && el.querySelectorAll('button, [role="button"]').length < 1) warn = ' · 버튼이 없는 칸이야';
                    else if (count <= 1) warn = ' · 다른 답변에서 같은 자리를 못 찾았어. 답변이 2개 이상 보일 때 해 봐';
                    live.textContent = `지금 확정하면 화면에서 ${count}곳이 잡혀${warn}`;
                    live.classList.toggle('is-warn', !!warn);
                }, 140);
            };
            const draw = () => {
                const el = current();
                if (!el) { box.style.display = 'none'; return; }
                const r = el.getBoundingClientRect();
                Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
                // 가리킨 칸이 안내창 밑에 깔리면 안내창을 반대쪽(위↔아래)으로 비켜 준다
                const visTop = Math.max(r.top, 0), visBottom = Math.min(r.bottom, innerHeight);
                const hits = (b) => visTop < b.bottom + 12 && visBottom > b.top - 12 && r.left < b.right && r.right > b.left;
                if (hits(bar.getBoundingClientRect())) {
                    bar.classList.toggle('is-bottom');
                    // 옮겨도 겹치면(아주 큰 칸) 원래 자리로
                    if (hits(bar.getBoundingClientRect())) bar.classList.toggle('is-bottom');
                }
                bar.querySelector('.csp-picker-path').textContent = sigOf(el).slice(0, 160) + `  ·  글자 ${(el.textContent || '').trim().length}`;
                updateLive();
            };
            const isOurs = (t) => t === bar || bar.contains(t) || t === box;
            // 안내창 밑에 고를 칸이 깔려 있으면: 버튼이 아닌 곳에 마우스를 잠깐 올려 두면 반대쪽으로 비켜난다
            let dodgeTimer = 0;
            bar.addEventListener('mousemove', (e) => {
                clearTimeout(dodgeTimer);
                if (e.target.closest('button')) return;
                dodgeTimer = setTimeout(() => bar.classList.toggle('is-bottom'), 350);
            });
            bar.addEventListener('mouseleave', () => clearTimeout(dodgeTimer));
            // 페이지 전체(html/body)는 고를 수 없다 — 빈 여백 위에 마우스가 있으면 이전 대상을 유지
            const isPageRoot = (t) => !t || t === document.documentElement || t === document.body;
            const onMove = (e) => {
                if (isOurs(e.target) || isPageRoot(e.target)) return;
                if (hovered !== e.target) { hovered = e.target; depth = 0; }
                draw();
            };
            const onWheel = (e) => {
                if (!hovered || isOurs(e.target)) return;
                e.preventDefault(); e.stopPropagation();
                depth = Math.max(0, depth + (e.deltaY < 0 ? 1 : -1));
                draw();
            };
            const cleanup = (result) => {
                clearTimeout(liveTimer);
                document.removeEventListener('mousemove', onMove, true);
                document.removeEventListener('click', onClick, true);
                document.removeEventListener('mousedown', block, true);
                document.removeEventListener('mouseup', block, true);
                document.removeEventListener('keydown', onKey, true);
                document.removeEventListener('wheel', onWheel, { capture: true });
                box.remove(); bar.remove(); style.remove();
                resolve(result);
            };
            // 잘못된 선택은 저장하지 않고 그 자리에서 다시 고르게 한다
            const refuse = (msg) => {
                const live = bar.querySelector('.csp-picker-live');
                live.textContent = msg;
                live.classList.add('is-warn');
                bar.classList.remove('is-shake'); void bar.offsetWidth; bar.classList.add('is-shake');
            };
            const confirm = () => {
                const el = current();
                if (isPageRoot(el)) { refuse('⚠️ 그 자리는 고를 수 없어. 답변 글 위에 마우스를 올리고 다시 클릭해 줘.'); return; }
                const selector = buildSelector(el);
                let count = 0;
                try { count = selector ? document.querySelectorAll(selector).length : 0; } catch (_) {}
                if (!selector || !count) { refuse('⚠️ 이 칸으로는 찾을 수 있는 곳이 없어. 다른 곳을 클릭해 줘.'); return; }
                if (kind !== 'footer' && (el.textContent || '').trim().length < 8) { refuse('⚠️ 글이 거의 없는 칸이야. 답변 글 위를 클릭하거나 ▲로 범위를 넓혀 줘.'); return; }
                if (kind === 'footer' && !el.querySelector('button, [role="button"], a') && !el.matches('button, [role="button"], a')) { refuse('⚠️ 버튼이 없는 칸이야. 복사·재생성 같은 버튼 줄을 클릭해 줘.'); return; }
                // 잡힌 곳 표시는 코어의 "저장됨" 반응이 맡는다 (여기서 따로 그리면 두 번 겹쳐 보였다)
                cleanup({ selector, count, picked: el });
            };
            const block = (e) => { if (isOurs(e.target)) return; e.preventDefault(); e.stopPropagation(); };
            const onClick = (e) => {
                if (isOurs(e.target)) {
                    const act = e.target.closest?.('button')?.dataset.act;
                    if (act === 'cancel') cleanup(null);
                    else if (act === 'up') { depth++; draw(); }
                    else if (act === 'down') { depth = Math.max(0, depth - 1); draw(); }
                    else if (act === 'move') bar.classList.toggle('is-bottom');
                    else if (act === 'example') {
                        const hidden = bar.classList.toggle('is-compact');
                        storageApi.setItem('csp_picker_example_hidden', hidden ? '1' : '0');
                        e.target.textContent = hidden ? '예시 보기' : '예시 접기';
                    }
                    return;
                }
                e.preventDefault(); e.stopPropagation();
                // 클릭한 곳을 기준으로 한다 (예전엔 마우스가 마지막으로 지나간 곳을 써서 엉뚱한 칸이 잡혔다)
                if (!isPageRoot(e.target) && e.target !== hovered) { hovered = e.target; depth = 0; draw(); }
                confirm();
            };
            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
                else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
                else if (e.key === '[' || e.code === 'BracketLeft' || e.key === 'ArrowUp') { e.preventDefault(); depth++; draw(); }
                else if (e.key === ']' || e.code === 'BracketRight' || e.key === 'ArrowDown') { e.preventDefault(); depth = Math.max(0, depth - 1); draw(); }
            };
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('click', onClick, true);
            document.addEventListener('mousedown', block, true);
            document.addEventListener('mouseup', block, true);
            document.addEventListener('keydown', onKey, true);
            document.addEventListener('wheel', onWheel, { capture: true, passive: false });
        });
    }

    // ── 확장 API (core.js에서 CSP_EXT로 쓴다) ──────────────────
    const CSP_EXT = {
        get platform() { return platform; },
        get platformId() { return platform?.id || 'unknown'; },
        get platformName() { return platform?.name || location.hostname; },
        getChatId,
        getRoomKey,
        isChatRoom() { return !!getChatId(); },
        saveSiteConfig,
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        touchChat,
        pick,
        buildSelector,
        rpc,
        isContextAlive,
        async putImage(id, dataUrl) {
            const chatId = getChatId();
            await rpc('img.put', { id, dataUrl, meta: { roomKey: getRoomKey(), platformId: platform?.id || '', chatId } });
            touchChat({ lastImageAt: Date.now() });
        },
        getImage(id) { return rpc('img.get', { id }); },
        deleteImage(id) { return rpc('img.delete', { id }); },
        putMeta(id, value) { return rpc('meta.put', { id, value }); },
        getMeta(id) { return rpc('meta.get', { id }); },
        deleteMeta(id) { return rpc('meta.delete', { id }); },
        openManager(hash) { return rpc('manager.open', { hash }); },
        get uiMode() { return uiMode; },
        // core가 등록: 확장 패널(팝업)에서 온 요청을 처리한다
        setPanelHandler(fn) { panelHandler = fn; },
        async getSiteUi() {
            if (!isContextAlive()) return {};
            const res = await chrome.storage.local.get(SITE_UI_KEY);
            return (res[SITE_UI_KEY] || {})[platform?.id || location.hostname] || {};
        },
        async setSiteUi(patch) {
            if (!isContextAlive()) return;
            const res = await chrome.storage.local.get(SITE_UI_KEY);
            const all = res[SITE_UI_KEY] || {};
            const id = platform?.id || location.hostname;
            all[id] = { ...(all[id] || {}), ...patch };
            await chrome.storage.local.set({ [SITE_UI_KEY]: all });
        },
        flush
    };
    window.CSP_EXT = CSP_EXT;

    // 다른 탭/관리 페이지에서 바꾼 값 반영
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        let siteChanged = false;
        for (const [key, change] of Object.entries(changes)) {
            if (key.startsWith(LS_PREFIX)) {
                const k = key.slice(LS_PREFIX.length);
                if (pendingSet.has(k) || pendingRemove.has(k)) continue; // 내가 막 쓴 값이 우선
                if (change.newValue === undefined) cache.delete(k);
                else cache.set(k, String(change.newValue));
            } else if (key === P.SITES_KEY) {
                sites = change.newValue || {};
                siteChanged = true;
            } else if (key === UI_MODE_KEY) {
                uiMode = change.newValue || 'fab';
                listeners.forEach(fn => { try { fn('ui'); } catch (_) {} });
            }
        }
        if (siteChanged) {
            refreshPlatform();
            listeners.forEach(fn => { try { fn('site'); } catch (_) {} });
        }
    });

    // 확장 패널(툴바 팝업)에서 오는 요청 — 상태 묻기 / 메뉴 동작 실행
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg?.type !== 'csp.panel') return false;
        if (!panelHandler) { sendResponse({ ok: false, error: '아직 준비 중이에요. 잠시 후 다시 열어주세요.' }); return false; }
        Promise.resolve()
            .then(() => panelHandler(msg.action, msg.payload || {}))
            .then(result => sendResponse({ ok: true, result }))
            .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
        return true;
    });

    // ── 시작: 저장소를 다 읽고 나서 core를 띄운다 ───────────────────
    let coreFactory = null;
    let ready = false;
    let started = false;

    function startCore() {
        if (started || !ready || !coreFactory) return;
        started = true;
        try {
            coreFactory(lsShim, GM_xmlhttpRequest, CSP_EXT);
        } catch (err) {
            console.error('[Vignette] core start failed', err);
        }
        touchChat();
        // SPA 이동 감지 → 채팅방 색인 갱신
        let lastPath = location.pathname;
        setInterval(() => {
            if (location.pathname !== lastPath) { lastPath = location.pathname; touchChat(); }
        }, 1000);
    }

    window.__CSP_BOOT__ = (factory) => { coreFactory = factory; startCore(); };

    chrome.storage.local.get(null).then((all) => {
        for (const [k, v] of Object.entries(all || {})) {
            if (k.startsWith(LS_PREFIX)) cache.set(k.slice(LS_PREFIX.length), String(v));
        }
        sites = all?.[P.SITES_KEY] || {};
        uiMode = all?.[UI_MODE_KEY] || 'fab';
        refreshPlatform();
        ready = true;
        startCore();
    });
})();
