// 확장 origin IndexedDB — 생성한 삽화 이미지와 큰 메타(태그북 캐시 등)를 보관한다.
// 백그라운드와 관리 페이지가 같은 DB를 연다. (콘텐츠 스크립트는 백그라운드를 거친다)
//
// 저장소:
//   images  { id, dataUrl, ... }  — 이미지 본체 (무겁다)
//   info    { id, createdAt, roomKey, platformId, chatId, size } — 목록용 (가볍다)
//   meta    { id, value }
// 목록·개수·용량은 info만 읽는다. 예전엔 목록을 볼 때마다 이미지 본체까지 전부 읽었다.
(function (root) {
    'use strict';
    if (root.CSP_IMAGEDB) return;

    const DB_NAME = 'csp_ext_image_db';
    const DB_VERSION = 2;
    let dbPromise = null;

    const infoOf = (v) => ({
        id: v.id, createdAt: v.createdAt || 0, roomKey: v.roomKey || '', platformId: v.platformId || '',
        chatId: v.chatId || '', size: v.size || String(v.dataUrl || '').length
    });

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = req.result;
                const tx = req.transaction;
                if (!db.objectStoreNames.contains('images')) {
                    const store = db.createObjectStore('images', { keyPath: 'id' });
                    store.createIndex('roomKey', 'roomKey', { unique: false });
                    store.createIndex('platformId', 'platformId', { unique: false });
                }
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('info')) {
                    const info = db.createObjectStore('info', { keyPath: 'id' });
                    // v1 → v2: 이미 있는 이미지의 목록 정보를 한 번 채운다
                    if (e.oldVersion >= 1) {
                        const cur = tx.objectStore('images').openCursor();
                        cur.onsuccess = () => {
                            const c = cur.result;
                            if (!c) return;
                            info.put(infoOf(c.value));
                            c.continue();
                        };
                    }
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => { dbPromise = null; reject(req.error || new Error('IndexedDB를 열지 못했어요.')); };
        });
        return dbPromise;
    }

    function tx(storeNames, mode, fn) {
        return open().then(db => new Promise((resolve, reject) => {
            const t = db.transaction(storeNames, mode);
            let result;
            const r = fn(t);
            if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
            t.oncomplete = () => resolve(result);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error || new Error('IndexedDB 작업이 취소됐어요.'));
        }));
    }

    async function putImage(id, dataUrl, meta = {}) {
        if (!id || !dataUrl) return;
        const prev = await tx('info', 'readonly', t => t.objectStore('info').get(id)).catch(() => null);
        const rec = {
            id,
            dataUrl,
            createdAt: prev?.createdAt || meta.createdAt || Date.now(),
            roomKey: meta.roomKey || prev?.roomKey || '',
            platformId: meta.platformId || prev?.platformId || '',
            chatId: meta.chatId || prev?.chatId || '',
            size: String(dataUrl).length
        };
        await tx(['images', 'info'], 'readwrite', t => {
            t.objectStore('images').put(rec);
            t.objectStore('info').put(infoOf(rec));
        });
    }

    async function getImage(id) {
        if (!id) return '';
        const rec = await tx('images', 'readonly', t => t.objectStore('images').get(id));
        return rec?.dataUrl || '';
    }

    async function getImageRecord(id) {
        return id ? await tx('images', 'readonly', t => t.objectStore('images').get(id)) : null;
    }

    function deleteImage(id) {
        if (!id) return Promise.resolve();
        return tx(['images', 'info'], 'readwrite', t => {
            t.objectStore('images').delete(id);
            t.objectStore('info').delete(id);
        });
    }

    async function putMeta(id, value) {
        if (!id) return;
        await tx('meta', 'readwrite', t => t.objectStore('meta').put({ id, value, updatedAt: Date.now() }));
    }

    async function getMeta(id) {
        if (!id) return null;
        const rec = await tx('meta', 'readonly', t => t.objectStore('meta').get(id));
        return rec?.value ?? null;
    }

    function deleteMeta(id) {
        return id ? tx('meta', 'readwrite', t => t.objectStore('meta').delete(id)) : Promise.resolve();
    }

    // 목록용: 이미지 본체 없이 가벼운 정보만
    function listImageInfo() {
        return tx('info', 'readonly', t => t.objectStore('info').getAll()).then(list => list || []);
    }

    function listAllImages() {
        return tx('images', 'readonly', t => t.objectStore('images').getAll());
    }

    // meta는 태그북 캐시처럼 큰 값이 있어 id만 필요할 때를 따로 둔다
    function listMetaIds() {
        return tx('meta', 'readonly', t => t.objectStore('meta').getAllKeys()).then(keys => keys || []);
    }

    function listAllMeta() {
        return tx('meta', 'readonly', t => t.objectStore('meta').getAll());
    }

    async function clearAll() {
        await tx(['images', 'info', 'meta'], 'readwrite', t => {
            t.objectStore('images').clear();
            t.objectStore('info').clear();
            t.objectStore('meta').clear();
        });
    }

    root.CSP_IMAGEDB = {
        open, putImage, getImage, getImageRecord, deleteImage,
        putMeta, getMeta, deleteMeta,
        listImageInfo, listAllImages, listMetaIds, listAllMeta, clearAll
    };
})(typeof globalThis !== 'undefined' ? globalThis : self);
