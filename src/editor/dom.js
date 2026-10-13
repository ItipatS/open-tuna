// Tiny DOM helpers for the editor.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const P = {
  play: 'M4 2.5v11l9-5.5z',
  pause: 'M4 2.5h3v11H4zM9 2.5h3v11H9z',
  stop: 'M3.5 3.5h9v9h-9z',
  start: 'M3 2.5h2v11H3zM13.5 2.5v11L6 8z',
  undo: 'M6 3 1.5 7.5 6 12V9c3.5 0 6 1 7.5 4-.5-4.5-3-7.5-7.5-8z',
  redo: 'M10 3l4.5 4.5L10 12V9c-3.5 0-6 1-7.5 4 .5-4.5 3-7.5 7.5-8z',
  eye: 'M8 3C4 3 1.5 6.5 1 8c.5 1.5 3 5 7 5s6.5-3.5 7-5c-.5-1.5-3-5-7-5zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4zM8 6.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z',
  eyeOff: 'M2.2 1.5 14.5 13.8l-.9.9-2.2-2.2c-1 .3-2.1.5-3.4.5-4 0-6.5-3.5-7-5 .3-.9 1.2-2.4 2.7-3.6L1.3 2.4zM8 3c4 0 6.5 3.5 7 5-.3.8-1 2-2.1 3.1l-2.4-2.4A3.2 3.2 0 0 0 6.3 5.5L5 4.1C5.9 3.4 6.9 3 8 3z',
  camera: 'M2 4.5h8v7H2zM10.5 7 14 5v6l-3.5-2z',
  copy: 'M5 1.5h8v10H5zM3 4.5v10h8v-1.5H4.5V4.5z',
  image: 'M1.5 3h13v10h-13zM3 11.5h10L9.5 7l-2.5 3-1.5-1.5z',
  link: 'M9 2h5v5l-1.8-1.8-4 4-1.4-1.4 4-4zM2 4h5v1.5H3.5v7h7V9H12v5H2z',
  save: 'M2 2h9.5L14 4.5V14H2zM4 3.5v3h6v-3zM4.5 9v3.5h7V9z',
  plus: 'M7 2h2v5h5v2H9v5H7V9H2V7h5z',
  auto: 'M1.5 3v10l6.5-5zM8 3v10l6.5-5z',
  more: 'M2.5 6.5h3v3h-3zM6.5 6.5h3v3h-3zM10.5 6.5h3v3h-3z',
};
export const icon = (name) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', P[name]);
  s.append(p);
  return s;
};

export const btn = (label, onclick, { title, cls = '', ico, id } = {}) =>
  h('button', { class: `ed-btn ${cls}`, title, id, onclick }, ico && icon(ico), label);

export function download(name, blobOrText, type = 'application/json') {
  const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
