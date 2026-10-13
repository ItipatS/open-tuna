// Review mode of the player (play.html?project=<id>&review, served by the studio server): a "Leave a note" button.
// A note is pinned to the moment on screen (story time) and goes straight into the shared story through the live
// sync endpoint (tools/collab.py) — everyone in the editor sees it on the timeline right away, with the author's name.
// For clients and reviewers who shouldn't need the editor. Not part of built sites.
const USER_KEY = 'openTuna.user';
const css = `
#rv-btn{position:fixed;right:18px;bottom:18px;z-index:60;font:600 13px Inter,system-ui,sans-serif;color:#0b1a24;background:#ffd166;border:0;border-radius:22px;padding:11px 16px;box-shadow:0 6px 24px rgba(0,0,0,.35);cursor:pointer}
#rv-btn:hover{background:#ffe08f}
#rv-box{position:fixed;right:18px;bottom:70px;z-index:61;width:min(360px,calc(100vw - 36px));background:rgba(18,22,28,.96);color:#e8eef5;border:1px solid #3a414c;border-radius:12px;padding:14px;font:13px/1.4 Inter,system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.45);display:none}
#rv-box.on{display:block}
#rv-box b{font-weight:600}
#rv-box textarea,#rv-box input{width:100%;box-sizing:border-box;margin:8px 0 0;background:#0e1116;color:#e8eef5;border:1px solid #3a414c;border-radius:8px;padding:8px;font:inherit;resize:vertical}
#rv-box .row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
#rv-box button{font:600 12px Inter,system-ui,sans-serif;border-radius:8px;border:1px solid #4a525e;background:#262b33;color:#e8eef5;padding:7px 12px;cursor:pointer}
#rv-box button.go{background:#ffd166;border-color:#ffd166;color:#0b1a24}
#rv-box small{color:#9aa4b2}
#rv-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:62;background:rgba(18,22,28,.95);color:#e8eef5;font:13px Inter,system-ui,sans-serif;padding:9px 14px;border-radius:10px;display:none}`;

const fmt = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
const rid = () => Math.random().toString(36).slice(2, 8).replace(/^\d/, 'n');

export function startReview(story) {
  const project = new URLSearchParams(location.search).get('project');
  document.head.append(Object.assign(document.createElement('style'), { textContent: css }));
  const btn = Object.assign(document.createElement('button'), { id: 'rv-btn', textContent: '💬 Leave a note' });
  const box = Object.assign(document.createElement('div'), { id: 'rv-box' });
  const toast = Object.assign(document.createElement('div'), { id: 'rv-toast' });
  let user = '';
  try { user = JSON.parse(localStorage.getItem(USER_KEY) || 'null')?.name || ''; } catch { /* storage unavailable */ }
  box.innerHTML = `<b>Note at <span class="at"></span></b> <small>— your team sees it in the editor</small>
    <textarea rows="3" placeholder="What should change here?"></textarea>
    <input type="text" placeholder="Your name" maxlength="32">
    <div class="row"><button class="no">Cancel</button><button class="go">Post note</button></div>`;
  document.body.append(btn, box, toast);
  const ta = box.querySelector('textarea'), name = box.querySelector('input'), at = box.querySelector('.at');
  name.value = user;
  let t = 0;
  const say = (msg) => { toast.textContent = msg; toast.style.display = 'block'; clearTimeout(say.k); say.k = setTimeout(() => { toast.style.display = 'none'; }, 3500); };
  btn.addEventListener('click', () => {
    t = Math.round(story.x * 100) / 100; // the moment on screen (story time)
    at.textContent = fmt(t);
    box.classList.toggle('on');
    if (box.classList.contains('on')) setTimeout(() => ta.focus(), 0);
  });
  box.querySelector('.no').addEventListener('click', () => box.classList.remove('on'));
  // keep the page from scrolling while typing
  for (const el of [ta, name]) el.addEventListener('keydown', (e) => e.stopPropagation());
  box.querySelector('.go').addEventListener('click', async () => {
    const text = ta.value.trim(), author = name.value.trim() || 'Reviewer';
    if (!text) return ta.focus();
    try { localStorage.setItem(USER_KEY, JSON.stringify({ name: author })); } catch { /* storage unavailable */ }
    const id = rid();
    try {
      const r = await fetch(`./__editor/sync/push?project=${encodeURIComponent(project)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: `review-${rid()}`, user: author, id, label: `Left a review note at ${fmt(t)}`, changes: [{ e: `n:${id}`, add: { t, text, author, at: Date.now(), review: true } }] }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      ta.value = '';
      box.classList.remove('on');
      say(`Note posted at ${fmt(t)} — thank you`);
    } catch (e) { say(`Couldn’t post the note (${e.message}) — review notes need the studio server`); }
  });
}
