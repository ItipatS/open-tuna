// Context menus, the menu bar's drop-downs, and modal dialogs.
//   openMenu(x, y, items)   items: { label, onClick, shortcut, disabled, checked, danger, items: [...] } | '-'
//   dialog({ title, body, buttons: [{ label, onClick, primary, danger }] }) -> { close, el }
import { h } from './dom.js';

let current = null;

export function closeMenu() {
  if (!current) return;
  current.remove();
  current = null;
  removeEventListener('pointerdown', outside, true);
  removeEventListener('keydown', esc, true);
  removeEventListener('blur', closeMenu);
}
function outside(e) { if (current && !current.contains(e.target)) closeMenu(); }
function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }

function build(items, onPick) {
  const el = h('div', { class: 'ed-menu', oncontextmenu: (e) => e.preventDefault() });
  let lastSep = true;
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { if (!lastSep) el.append(h('div', { class: 'sep' })); lastSep = true; continue; }
    lastSep = false;
    const row = h('div', { class: `mi ${it.disabled ? 'off' : ''} ${it.danger ? 'danger' : ''} ${it.items ? 'sub' : ''}` },
      h('span', { class: 'ck' }, it.checked ? '✓' : ''),
      h('span', { class: 'lb' }, it.label),
      h('span', { class: 'sc' }, it.items ? '▸' : it.shortcut || ''));
    if (it.items) {
      let sub = null;
      row.addEventListener('pointerenter', () => {
        el.querySelectorAll(':scope > .ed-menu').forEach((m) => m.remove());
        sub = build(it.items, onPick);
        el.append(sub);
        const r = row.getBoundingClientRect(), pr = el.getBoundingClientRect();
        sub.style.left = `${r.right - pr.left - 2}px`;
        sub.style.top = `${r.top - pr.top - 4}px`;
        const sr = sub.getBoundingClientRect();
        if (sr.right > innerWidth - 4) sub.style.left = `${-sr.width + 2}px`;
        if (sr.bottom > innerHeight - 4) sub.style.top = `${r.top - pr.top - (sr.bottom - innerHeight) - 8}px`;
      });
    } else {
      row.addEventListener('pointerenter', () => el.querySelectorAll(':scope > .ed-menu').forEach((m) => m.remove()));
      if (!it.disabled) row.addEventListener('click', () => { onPick(); it.onClick?.(); });
    }
    el.append(row);
  }
  return el;
}

export function openMenu(x, y, items) {
  closeMenu();
  const el = build(items, closeMenu);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  document.getElementById('ed')?.append(el) ?? document.body.append(el);
  const r = el.getBoundingClientRect();
  if (r.right > innerWidth - 4) el.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
  if (r.bottom > innerHeight - 4) el.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`;
  current = el;
  setTimeout(() => {
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', esc, true);
    addEventListener('blur', closeMenu);
  }, 0);
  return el;
}

export function dialog({ title, body, buttons = [], wide = false, onClose }) {
  closeMenu();
  const close = () => { back.remove(); removeEventListener('keydown', key, true); onClose?.(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const btns = buttons.map((b) => h('button', {
    class: `ed-btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
    onclick: async () => { if ((await b.onClick?.()) !== false) close(); },
  }, b.label));
  const box = h('div', { class: `ed-dialog ${wide ? 'wide' : ''}` },
    h('div', { class: 'dh' }, h('b', {}, title), h('button', { class: 'x', onclick: close, title: 'Close (Esc)' }, '✕')),
    h('div', { class: 'db' }, body),
    btns.length ? h('div', { class: 'df' }, btns) : null);
  const back = h('div', { class: 'ed-modal', onpointerdown: (e) => { if (e.target === back) close(); } }, box);
  (document.getElementById('ed') ?? document.body).append(back);
  addEventListener('keydown', key, true);
  setTimeout(() => box.querySelector('input, textarea')?.focus(), 0);
  return { close, el: box };
}
