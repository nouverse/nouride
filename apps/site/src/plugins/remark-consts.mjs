/**
 * Substitute `@@TOKEN@@` with the values in `src/consts.mjs`, everywhere on the site.
 *
 * The download domain appears on roughly thirty pages across two languages. Written out by hand it
 * was already wrong when this plugin was added, the landing page said one host, the installation
 * page said a second and the installer itself downloaded from a third, so the URLs are one
 * constant and the pages name it.
 *
 * Runs over `text`, `inlineCode`, `code` and link/image URLs, which is every place a value can
 * appear in Markdown. MDX gets it too: Starlight passes `markdown.remarkPlugins` to both.
 *
 * A token with no value is left alone rather than replaced with `undefined`: a visible `@@TYPO@@`
 * on the page is found immediately; the string "undefined" in a curl command is not.
 */

import { TOKENS } from '../consts.mjs';

const PATTERN = /@@([A-Z0-9_]+)@@/g;

const substitute = (value) =>
  value.replace(PATTERN, (whole, name) => (name in TOKENS ? TOKENS[name] : whole));

/** Cheap guard so a tree with no tokens costs one `indexOf` per node instead of a regex. */
const hasToken = (value) => typeof value === 'string' && value.includes('@@');

export function remarkConsts() {
  return (tree) => {
    walk(tree);
  };
}

function walk(node) {
  if (!node || typeof node !== 'object') return;

  if (hasToken(node.value) && (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code' || node.type === 'html')) {
    node.value = substitute(node.value);
  }
  if (hasToken(node.url)) node.url = substitute(node.url);
  if (hasToken(node.alt)) node.alt = substitute(node.alt);
  if (hasToken(node.title)) node.title = substitute(node.title);

  for (const child of node.children ?? []) walk(child);
}

export default remarkConsts;
