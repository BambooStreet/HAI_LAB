// Shared helpers for index.html and admin.html.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Escapes, then turns **text** into <strong>.
export function rich(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// Only allow link/image URLs with harmless schemes.
export function safeUrl(url, schemes = ['http:', 'https:', 'mailto:', 'tel:']) {
  if (!url) return '';
  try {
    const u = new URL(url, location.href);
    return schemes.includes(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}


// Paper body: **bold** plus ![caption](https://...) images.
const IMAGE_RE = /!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g;

// A caption of the form "50%" is a display width set in the editor (![50%](url)), not alt text.
export const IMAGE_SIZE_RE = /^(\d{1,3})%$/;
function image(alt, url) {
  const size = Number(IMAGE_SIZE_RE.exec(alt)?.[1]);
  const style = size >= 10 && size <= 100 ? ` style="width:${size}%;max-height:none"` : '';
  return `<img class="body-img" src="${url}" alt="${style ? '' : alt}"${style} loading="lazy" />`;
}

// With { links: true }, also [label](https://...) links and bare https:// URLs, in one pass so an
// image's URL is never re-linked. Runs on already-escaped text, so URLs stop at escaped quotes/brackets.
// ASCII only, so Korean right after a URL ("https://a.com에서") stays out of the link.
const URL_CHARS = String.raw`(?:(?!&lt;|&gt;|&quot;|&#39;)[\w\-.~:/?#@!$&*+,;=%()])+`;
const LINKED_RE = new RegExp(String.raw`(!?)\[([^\]\n]*)\]\((https?:\/\/[^\s)<]+)\)|(https?:\/\/${URL_CHARS})`, 'g');

const link = (url, label) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;

export function renderBody(text, { links = false } = {}) {
  if (!links) {
    return rich(text).replace(IMAGE_RE, (_, alt, url) => image(alt, url));
  }
  return rich(text).replace(LINKED_RE, (_, bang, label, url, bare) => {
    if (bare) {
      // "see https://x.com." / "(https://x.com)" → keep trailing punctuation and unmatched ")" outside.
      let href = bare;
      let trail = '';
      const count = (c) => href.split(c).length - 1;
      while (/[.,!?;:]$/.test(href) || (href.endsWith(')') && count(')') > count('('))) {
        trail = href.slice(-1) + trail;
        href = href.slice(0, -1);
      }
      return link(href, href) + trail;
    }
    return bang
      ? image(label, url)
      : link(url, label || url);
  });
}

export function firstImage(text) {
  const m = new RegExp(IMAGE_RE.source).exec(text || '');
  return m ? safeUrl(m[2], ['http:', 'https:']) : '';
}
