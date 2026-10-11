// 플랫폼(사이트) 정의 · 매칭 · 채팅 ID 추출
// 백그라운드(서비스 워커) · 콘텐츠 스크립트 · 관리 페이지가 같이 쓴다.
(function (root) {
    'use strict';
    if (root.CSP_PLATFORMS) return;

    const SITES_KEY = 'csp_sites_v1';

    // 위치(본문/하단) 셀렉터는 비워 두면 플로팅 버튼 › "위치 지정"으로 고른다.
    // chatPath: 경로에서 채팅 ID를 뽑는 정규식 (첫 번째 괄호가 ID). 맞지 않는 경로는 채팅방이 아니다.
    const BUILTIN_PLATFORMS = [
        {
            id: 'univers', name: '유니챗', hosts: ['univers.chat'],
            chatPath: '^/play/([^/?#]+)', mode: 'univers',
            bodySelector: '', footerSelector: '', userSelector: ''
        },
        {
            // 2026-10 확인(첫 인사말 기준): 버튼 줄[data-chat-content-id]이 본문 위에 있다.
            // 내 메시지 구조가 같으면 🎨 › 내 메시지 제외 지정으로 걸러 준다.
            id: 'caveduck', name: '케이브덕', hosts: ['caveduck.io', 'cvdk.io'],
            chatPath: '^/(?:[a-z]{2}/)?talk/([^/?#]+)', mode: 'generic',
            messageSelector: '',
            bodySelector: 'div.flex.flex-col.gap-2 > div.\\[contain\\:paint\\]',
            footerSelector: 'div.flex.h-8.items-center.justify-end[data-chat-content-id]',
            userSelector: '', idAttribute: 'data-chat-content-id'
        },
        {
            // 2026-10 확인: [data-message-id="assistant-N" | "user-N"]
            id: 'elyn', name: '엘린', hosts: ['elyn.ai'],
            chatPath: '^/chat/([^/?#]+)', mode: 'generic',
            messageSelector: '[data-message-id^="assistant-"]',
            bodySelector: 'div.break-words.space-y-6',
            footerSelector: 'div.justify-between[data-chat-interactive="true"]',
            userSelector: '', idAttribute: 'data-message-id'
        },
        {
            // 2026-10 확인: 한 턴(div[data-turn]) = 버튼 줄 + (내 말 p + AI 답변 div.mt-1)
            id: 'rofan', name: '로판 AI', hosts: ['rofan.ai'],
            chatPath: '^/chat/([^/?#]+)', mode: 'generic',
            messageSelector: '[data-turn]',
            bodySelector: ':scope > div > div.mt-1',
            footerSelector: ':scope > div.justify-end',
            userSelector: '', idAttribute: ''
        },
        {
            id: 'teapot', name: '티팟', hosts: ['teapotchat.com'],
            chatPath: '^/chat/([^/?#]+)', mode: 'generic',
            bodySelector: '', footerSelector: '', userSelector: ''
        },
        {
            // 2026-10 확인: 가상 스크롤(virtuoso) — 화면에 보이는 메시지만 DOM에 있다
            id: 'riru', name: '리루', hosts: ['riru.ai'],
            chatPath: '^/chat/(?:[^/]+/)?([^/?#]+)', mode: 'generic',
            messageSelector: '[data-chat-message-role="assistant"]',
            bodySelector: '.markdown-content',
            footerSelector: 'div.mt-2.flex.justify-start',
            userSelector: '', idAttribute: 'data-chat-message-id'
        },
        {
            // 2026-10 확인: [data-message-id] 하나에 내 말 + 캐릭터 답변이 같이 들어 있다
            id: 'uumm', name: '우마이', hosts: ['uumm.ai'],
            chatPath: '^/chats/([^/?#]+)', mode: 'generic',
            messageSelector: '[data-message-id]',
            bodySelector: '[data-capture-sender="char"] > div',
            footerSelector: ':scope > div:last-child div.items-center.justify-between',
            userSelector: '', idAttribute: 'data-message-id'
        }
    ];

    function hostMatches(hostname, host) {
        const h = String(hostname || '').toLowerCase();
        const t = String(host || '').toLowerCase().replace(/^\*\./, '');
        return h === t || h.endsWith('.' + t);
    }

    // sites: chrome.storage에 저장된 { id: config } — 내장값 위에 사용자가 고친 값이 얹혀 있다.
    function matchPlatform(url, sites) {
        const u = url instanceof URL ? url : new URL(String(url));
        const all = Object.values(sites || {});
        BUILTIN_PLATFORMS.forEach(p => { if (!sites || !sites[p.id]) all.push({ ...p, enabled: true }); });
        return all.find(p => (p.hosts || []).some(h => hostMatches(u.hostname, h))) || null;
    }

    function sanitizeId(id) {
        return String(id || '').replace(/[^A-Za-z0-9_\-.]/g, '_').slice(0, 120);
    }

    // 채팅방이면 ID, 아니면 ''.
    // 코어가 아주 자주 부른다(저장 키를 만들 때마다). 같은 주소 · 같은 규칙이면 지난 결과를 쓴다.
    const regexCache = new Map();
    let lastChatIdKey = '';
    let lastChatId = '';
    function extractChatId(platform, loc) {
        const pathname = loc.pathname || '/';
        const memoKey = `${platform?.id || ''}|${platform?.chatPath || ''}|${pathname}`;
        if (memoKey === lastChatIdKey) return lastChatId;
        lastChatIdKey = memoKey;
        lastChatId = computeChatId(platform, pathname);
        return lastChatId;
    }

    function computeChatId(platform, pathname) {
        if (platform?.chatPath) {
            try {
                let re = regexCache.get(platform.chatPath);
                if (!re) { re = new RegExp(platform.chatPath); regexCache.set(platform.chatPath, re); }
                const m = pathname.match(re);
                return m ? sanitizeId(m[1] || m[0]) : '';
            } catch (_) { /* 잘못된 정규식이면 아래 기본 규칙 */ }
        }
        // 기본: 경로 마지막 조각이 ID처럼 생겼으면 채팅방으로 본다.
        const parts = pathname.split('/').filter(Boolean);
        const last = parts[parts.length - 1] || '';
        if (last.length >= 8 && /[0-9]/.test(last)) return sanitizeId(parts.slice(-2).join('_'));
        return '';
    }

    function makeRoomKey(platformId, chatId) {
        return `${sanitizeId(platformId)}__${sanitizeId(chatId)}`;
    }

    function parseRoomKey(roomKey) {
        const s = String(roomKey || '');
        const i = s.indexOf('__');
        if (i < 0) return { platformId: 'legacy', chatId: s };
        return { platformId: s.slice(0, i), chatId: s.slice(i + 2) };
    }

    root.CSP_PLATFORMS = {
        SITES_KEY,
        BUILTIN_PLATFORMS,
        hostMatches,
        matchPlatform,
        extractChatId,
        makeRoomKey,
        parseRoomKey,
        sanitizeId
    };
})(typeof globalThis !== 'undefined' ? globalThis : self);
