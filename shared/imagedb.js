// 확장 origin IndexedDB — 생성한 삽화 이미지와 큰 메타(태그북 캐시 등)를 보관한다.
// 백그라운드와 관리 페이지가 같은 DB를 연다. (콘텐츠 스크립트는 백그라운드를 거친다)
(function (root) {
    'use strict';
    if (root.CSP_IMAGEDB) return;

    const DB_NAME = 'csp_ext_image_db';
    const DB_VERSION = 1;
    let dbPromise = null;

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('images')) {
                    const store = db.createObjectStore('images', { keyPath: 'id' });
                    store.createIndex('roomKey', 'roomKey', { unique: false });
                    store.createIndex('platformId', 'platformId', { unique: false });
                }
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => { dbPromise = null; reject(req.error || new Error('IndexedDB를 열지 못했어요.')); };
        });
        return dbPromise;
    }

    function tx(storeName, mode, fn) {
        return open().then(db => new Promise((resolve, reject) => {
            const t = db.transaction(storeName, mode);
            const store = t.objectStore(storeName);
            let result;
            const r = fn(store);
            if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
            t.oncomplete = () => resolve(result);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error || new Error('IndexedDB 작업이 취소됐어요.'));
        }));
    }

    async function putImage(id, dataUrl, meta = {}) {
        if (!id || !dataUrl) return;
        const prev = await tx('images', 'readonly', s => s.get(id)).catch(() => null);
        await tx('images', 'readwrite', s => s.put({
            id,
            dataUrl,
            createdAt: prev?.createdAt || Date.now(),
            roomKey: meta.roomKey || prev?.roomKey || '',
            platformId: meta.platformId || prev?.platformId || '',
            chatId: meta.chatId || prev?.chatId || '',
            size: String(dataUrl).length
        }));
    }

    async function getImage(id) {
        if (!id) return '';
        const rec = await tx('images', 'readonly', s => s.get(id));
        return rec?.dataUrl || '';
    }

    async function getImageRecord(id) {
        return id ? await tx('images', 'readonly', s => s.get(id)) : null;
    }

    function deleteImage(id) {
        return id ? tx('images', 'readwrite', s => s.delete(id)) : Promise.resolve();
    }

    async function putMeta(id, value) {
        if (!id) return;
        await tx('meta', 'readwrite', s => s.put({ id, value, updatedAt: Date.now() }));
    }

    async function getMeta(id) {
        if (!id) return null;
        const rec = await tx('meta', 'readonly', s => s.get(id));
        return rec?.value ?? null;
    }

    function deleteMeta(id) {
        return id ? tx('meta', 'readwrite', s => s.delete(id)) : Promise.resolve();
    }

    // 관리 페이지용: dataUrl 없이 목록만 (커서로 훑는다)
    function listImageInfo() {
        return open().then(db => new Promise((resolve, reject) => {
            const out = [];
            const t = db.transaction('images', 'readonly');
            const req = t.objectStore('images').openCursor();
            req.onsuccess = () => {
                const c = req.result;
                if (!c) return;
                const v = c.value;
                out.push({ id: v.id, createdAt: v.createdAt, roomKey: v.roomKey, platformId: v.platformId, chatId: v.chatId, size: v.size || String(v.dataUrl || '').length });
                c.continue();
            };
            t.oncomplete = () => resolve(out);
            t.onerror = () => reject(t.error);
        }));
    }

    function listAllImages() {
        return tx('images', 'readonly', s => s.getAll());
    }

    function listAllMeta() {
        return tx('meta', 'readonly', s => s.getAll());
    }

    async function clearAll() {
        await tx('images', 'readwrite', s => s.clear());
        await tx('meta', 'readwrite', s => s.clear());
    }

    root.CSP_IMAGEDB = {
        open, putImage, getImage, getImageRecord, deleteImage,
        putMeta, getMeta, deleteMeta,
        listImageInfo, listAllImages, listAllMeta, clearAll
    };
})(typeof globalThis !== 'undefined' ? globalThis : self);
