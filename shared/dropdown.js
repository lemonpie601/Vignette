// 관리 페이지 · 팝업용 커스텀 드롭다운
// <select>는 그대로 두고(값 · change 이벤트 · 기존 코드 전부 그대로) 겉모양과 펼침 목록만 새로 그린다.
// 키보드: ↑↓ 이동 · Enter/Space 선택 · Esc 닫기 · 글자 입력으로 찾아가기
(function () {
    'use strict';
    if (window.CSP_DROPDOWN) return;

    let open = null; // { select, pop, button, index }

    function labelOf(select) {
        const opt = select.options[select.selectedIndex];
        return opt ? opt.textContent : '';
    }

    function close(focusButton = false) {
        if (!open) return;
        const { pop, button } = open;
        pop.remove();
        button.setAttribute('aria-expanded', 'false');
        button.classList.remove('is-open');
        if (focusButton) button.focus();
        open = null;
    }

    function choose(select, index) {
        if (index < 0 || select.options[index]?.disabled) return;
        if (select.selectedIndex !== index) {
            select.selectedIndex = index;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        sync(select);
    }

    function setActive(index) {
        if (!open) return;
        const items = open.pop.querySelectorAll('.dd-opt');
        items.forEach((el, i) => el.classList.toggle('is-active', i === index));
        open.index = index;
        items[index]?.scrollIntoView({ block: 'nearest' });
    }

    function openFor(select, button) {
        close();
        const pop = document.createElement('div');
        pop.className = 'dd-pop';
        pop.setAttribute('role', 'listbox');
        pop.innerHTML = Array.from(select.options).map((o, i) => `
            <div class="dd-opt${i === select.selectedIndex ? ' is-selected' : ''}${o.disabled ? ' is-disabled' : ''}" role="option" data-i="${i}" aria-selected="${i === select.selectedIndex}">
                <span class="dd-check" aria-hidden="true">✓</span><span>${o.textContent.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</span>
            </div>`).join('');
        document.body.appendChild(pop);
        const r = button.getBoundingClientRect();
        const h = pop.offsetHeight;
        const below = innerHeight - r.bottom - 8;
        const top = below >= h || below > r.top ? r.bottom + 4 : r.top - h - 4;
        pop.style.minWidth = r.width + 'px';
        pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
        pop.style.top = Math.max(8, top) + 'px';
        pop.style.maxHeight = Math.max(160, Math.max(below, r.top - 12)) + 'px';
        button.setAttribute('aria-expanded', 'true');
        button.classList.add('is-open');
        open = { select, pop, button, index: select.selectedIndex };
        setActive(select.selectedIndex);
        pop.addEventListener('mousedown', (e) => e.preventDefault());
        pop.addEventListener('click', (e) => {
            const opt = e.target.closest('.dd-opt');
            if (!opt || opt.classList.contains('is-disabled')) return;
            choose(select, Number(opt.dataset.i));
            close(true);
        });
        pop.addEventListener('mousemove', (e) => {
            const opt = e.target.closest('.dd-opt');
            if (opt && Number(opt.dataset.i) !== open?.index) setActive(Number(opt.dataset.i));
        });
    }

    function sync(select) {
        const button = select._ddButton;
        if (button) {
            button.querySelector('.dd-label').textContent = labelOf(select);
            button.disabled = select.disabled;
        }
    }

    function enhance(select) {
        if (select._ddButton || select.multiple || select.size > 1 || select.closest('[data-no-dd]')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dd-button';
        button.setAttribute('aria-haspopup', 'listbox');
        button.setAttribute('aria-expanded', 'false');
        if (select.id) button.setAttribute('aria-describedby', select.id);
        const aria = select.getAttribute('aria-label') || document.querySelector(`label[for="${select.id}"]`)?.textContent?.trim();
        if (aria) button.setAttribute('aria-label', aria);
        button.innerHTML = '<span class="dd-label"></span><svg class="dd-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
        select.classList.add('dd-native');
        select.tabIndex = -1;
        select.after(button);
        select._ddButton = button;
        sync(select);
        select.addEventListener('change', () => sync(select));
        button.addEventListener('click', () => {
            if (open?.select === select) close(); else openFor(select, button);
        });
        let typed = ''; let typedTimer = 0;
        button.addEventListener('keydown', (e) => {
            const isOpen = open?.select === select;
            const n = select.options.length;
            const step = (dir) => {
                let i = isOpen ? open.index : select.selectedIndex;
                for (let k = 0; k < n; k++) { i = (i + dir + n) % n; if (!select.options[i].disabled) break; }
                return i;
            };
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const i = step(e.key === 'ArrowDown' ? 1 : -1);
                if (isOpen) setActive(i); else choose(select, i);
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (isOpen) { choose(select, open.index); close(true); } else openFor(select, button);
            } else if (e.key === 'Escape' && isOpen) {
                e.preventDefault(); close(true);
            } else if (e.key.length === 1) {
                typed += e.key.toLowerCase();
                clearTimeout(typedTimer); typedTimer = setTimeout(() => { typed = ''; }, 600);
                const i = Array.from(select.options).findIndex(o => o.textContent.toLowerCase().startsWith(typed));
                if (i >= 0) { if (isOpen) setActive(i); else choose(select, i); }
            }
        });
    }

    function enhanceAll(root = document) {
        root.querySelectorAll('select').forEach(enhance);
    }

    document.addEventListener('mousedown', (e) => {
        if (!open) return;
        if (open.pop.contains(e.target) || open.button.contains(e.target)) return;
        close();
    }, true);
    window.addEventListener('resize', () => close());
    document.addEventListener('scroll', (e) => { if (open && !open.pop.contains(e.target)) close(); }, true);
    new MutationObserver(() => enhanceAll()).observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState !== 'loading') enhanceAll(); else document.addEventListener('DOMContentLoaded', () => enhanceAll());

    window.CSP_DROPDOWN = { enhance, enhanceAll, close };
})();
