// Where the open story's files live.
//   repo story      story.json + assets/ at the site root (the default, and every built site)
//   .tuna project   ?project=<slug>  ->  projects/<slug>/story.json + projects/<slug>/assets/ (the editor unpacks
//                   an opened .tuna file there, see src/editor/project.js)
// Story paths stay relative to the story ("assets/logo.png"); built-in models are root files ("tuna_fish.glb").
const BUILD = !!window.OPEN_TUNA_BUILD; // set by the built index.html: no editor, no projects
const q = new URLSearchParams(location.search);
const slug = q.get('project') || '';

export const PROJECT = !BUILD && /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) ? slug : '';
export const BASE = PROJECT ? `projects/${PROJECT}/` : '';
export const IS_BUILD = BUILD;

// a story path -> a URL the page can load
export const assetURL = (src) => (src && BASE && /^assets\//.test(src) ? BASE + src : src);

// asset paths inside HTML layers (src / href / poster / url()) -> URLs
export const fixHTML = (html) => (BASE && html
  ? html.replace(/((?:src|href|poster)\s*=\s*["']|url\(\s*["']?)assets\//g, `$1${BASE}assets/`)
  : html);

// the editor's dev-server API for the open story (editor only)
export const editorAPI = (path) => `./__editor/${path}${PROJECT ? `${path.includes('?') ? '&' : '?'}project=${PROJECT}` : ''}`;
