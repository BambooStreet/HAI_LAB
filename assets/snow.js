// Snowfall over the whole page, drawn on a single canvas.
//
// One canvas rather than a few hundred <div>s: the browser then has one thing to composite
// instead of one per flake, which is what keeps this from costing anything noticeable on a
// phone. The canvas never takes a click, and it sits below <dialog> (the top layer always
// wins), so the photo viewer and the composer stay clear of snow.
//
// The movement is kept out of the drawing so it can be tested without a browser: everything
// above startSnow() is plain arithmetic.

const MAX_STEP = 0.05; // a backgrounded tab hands back a huge gap; cap it so flakes don't jump

// Roughly one flake per 9,000 px² of screen: about forty on a phone, a hundred and fifty on a
// desktop — enough to read as snowfall rather than as a few specks.
export const flakeCount = (w, h) => Math.min(220, Math.round((w * h) / 9000));

export function makeFlake(w, h, fromTop = false) {
  // Bigger flakes are treated as nearer: they fall faster and show up brighter, which reads as
  // depth without having to draw anything more complicated than a circle.
  const r = 1 + Math.random() * 2.4;
  return {
    x: Math.random() * w,
    y: fromTop ? -r - Math.random() * 40 : Math.random() * h,
    r,
    fall: 10 + r * 14, // px per second
    drift: (Math.random() - 0.5) * 12,
    sway: Math.random() * Math.PI * 2,
    swaySpeed: 0.4 + Math.random() * 0.7,
    alpha: 0.2 + r * 0.17,
  };
}

// Moves every flake on by dt seconds. One that has fallen past the bottom comes back as a new
// flake at the top, and one that drifts off a side comes in at the other, so the snow never
// thins out however long the page is left open.
export function stepFlakes(flakes, dt, w, h) {
  for (const f of flakes) {
    f.sway += f.swaySpeed * dt;
    f.y += f.fall * dt;
    f.x += (f.drift + Math.sin(f.sway) * 9) * dt;

    if (f.y - f.r > h) Object.assign(f, makeFlake(w, h, true));
    else if (f.x < -f.r) f.x += w + f.r * 2;
    else if (f.x > w + f.r) f.x -= w + f.r * 2;
  }
  return flakes;
}

export function startSnow() {
  const calm = matchMedia('(prefers-reduced-motion: reduce)');

  const canvas = document.createElement('canvas');
  canvas.className = 'snow';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');

  let w = 0;
  let h = 0;
  const flakes = [];
  let raf = 0;
  let last = 0;

  function resize() {
    // On a phone the address bar sliding away changes the height constantly; only redo the
    // canvas when the size really changed, or every scroll would reallocate it.
    if (innerWidth === w && innerHeight === h) return;
    w = innerWidth;
    h = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const want = flakeCount(w, h);
    while (flakes.length < want) flakes.push(makeFlake(w, h));
    flakes.length = Math.min(flakes.length, want);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, MAX_STEP);
    last = now;

    stepFlakes(flakes, dt, w, h);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    for (const f of flakes) {
      ctx.globalAlpha = f.alpha;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Always ask for a fresh frame. A frame requested while the page was hidden may never be
  // delivered, so treating a left-over id as "already running" would leave the snow stopped
  // for good once the page came back.
  function run() {
    cancelAnimationFrame(raf);
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function halt() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function apply() {
    if (calm.matches) {
      halt();
      canvas.remove();
      return;
    }
    if (!canvas.isConnected) document.body.append(canvas);
    resize();
    if (!document.hidden) run();
  }

  addEventListener('resize', resize);
  // A hidden tab still gets frames in some browsers; stopping saves a phone's battery.
  document.addEventListener('visibilitychange', () => (document.hidden || calm.matches ? halt() : run()));
  calm.addEventListener('change', apply);
  apply();

  return { stop: () => { halt(); canvas.remove(); } };
}
