// Which project the page shows, and where its files live. The repository is the TOOL; stories are projects:
//   demo/<id>   demos/<id>/      demo projects that ship with the tool (committed, e.g. demo/thai-union)
//   <slug>      projects/<slug>/ projects created / opened in the studio (working copies of .tuna files, gitignored)
//   built site  window.OPEN_TUNA_BUILD: the export of one project, its story.json + assets/ at the site root
// Pages: index.html (studio home), editor.html?project=…, play.html?project=… (OPEN_TUNA_PAGE says which).
// Story paths are relative to the project ("assets/logo.png"); the tool's built-in models are "models/…".
const BUILD = !!window.OPEN_TUNA_BUILD;
const q = new URLSearchParams(location.search);
const id = q.get('project') || '';

export const IS_BUILD = BUILD;
export const PAGE = BUILD ? 'play' : window.OPEN_TUNA_PAGE || 'play';
export const PROJECT = !BUILD && /^(demo\/)?[a-z0-9][a-z0-9-]{0,62}$/.test(id) ? id : '';
export const IS_DEMO = PROJECT.startsWith('demo/');
export const BASE = !PROJECT ? '' : IS_DEMO ? `demos/${PROJECT.slice(5)}/` : `projects/${PROJECT}/`;

// a story path -> a URL the page can load
export const assetURL = (src) => (src && BASE && /^assets\//.test(src) ? BASE + src : src);

// asset paths inside HTML layers (src / href / poster / url()) -> URLs
export const fixHTML = (html) => (BASE && html
  ? html.replace(/((?:src|href|poster)\s*=\s*["']|url\(\s*["']?)assets\//g, `$1${BASE}assets/`)
  : html);

// the studio pages for a project
export const editorURL = (p) => `./editor.html?project=${encodeURIComponent(p)}`;
export const playURL = (p, t) => `./play.html?project=${encodeURIComponent(p)}${t !== undefined ? `&t=${t}` : ''}`;

// the studio server's API for the open project (editor only)
export const editorAPI = (path) => `./__editor/${path}${PROJECT ? `${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(PROJECT)}` : ''}`;
