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

