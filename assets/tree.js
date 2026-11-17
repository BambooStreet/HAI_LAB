// A Christmas tree, as one inline SVG so it scales to any size without a file to download.
// Where it stands is each page's business: index puts it on the waves in the hero, admin keeps
// a small one in the top bar. Colours come from the site's own palette rather than the usual
// red and green, so it belongs to the page instead of sitting on top of it.

// Baubles: x, y and which palette colour, placed by eye along the tiers.
const BAUBLES = [
  [50, 34, 'var(--accent)'], [41, 52, 'var(--water)'], [59, 50, '#f5c45e'],
  [50, 70, '#f5c45e'], [35, 80, 'var(--danger)'], [64, 82, 'var(--accent)'], [47, 90, 'var(--water)'],
  [27, 112, 'var(--water)'], [40, 104, '#f5c45e'], [58, 106, 'var(--danger)'],
  [72, 114, 'var(--accent)'], [50, 119, 'var(--accent)'],
];

const STAR = 'M50 1 L52.2 6.9 L58.6 7.2 L53.6 11.2 L55.3 17.3 L50 13.8 '
  + 'L44.7 17.3 L46.4 11.2 L41.4 7.2 L47.8 6.9 Z';

export function treeSvg(className = '') {
  const baubles = BAUBLES.map(([x, y, fill], i) =>
    // Each light is given its own delay so they blink out of step, the way a real string does.
    `<circle class="tree-light" cx="${x}" cy="${y}" r="3" fill="${fill}" style="--d:${(i * 0.37).toFixed(2)}s" />`).join('');

  return `<svg class="tree ${className}" viewBox="0 0 100 140" aria-hidden="true" focusable="false">
    <rect x="45" y="122" width="10" height="18" rx="2" fill="#6b4a2f" />
    <path class="tree-tier" d="M50 76 L92 126 L8 126 Z" />
    <path class="tree-tier" d="M50 48 L82 96 L18 96 Z" />
    <path class="tree-tier" d="M50 22 L72 60 L28 60 Z" />
    ${baubles}
    <path class="tree-star" d="${STAR}" fill="#f5c45e" />
  </svg>`;
}

// Puts a tree at `target` — inside it by default, or beside it with 'afterend' and the like.
// Returns the <svg>, or null when there is nowhere to put it. The node is built first and then
// inserted, so the right element comes back whether it ended up inside the target or next to it.
export function plantTree(target, className = '', where = 'beforeend') {
  if (!target) return null;
  const holder = document.createElement('div');
  holder.innerHTML = treeSvg(className);
  const svg = holder.firstElementChild;
  target.insertAdjacentElement(where, svg);
  return svg;
}
