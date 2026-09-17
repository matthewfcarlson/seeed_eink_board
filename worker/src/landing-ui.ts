/**
 * Static marketing/info page served at "/". Approachable front door for
 * non-technical visitors — the deep technical detail lives in the collapsed
 * "for the curious" section and the GitHub repo, not the main flow. No
 * secrets or dynamic data here — safe to serve with no auth.
 */
export function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E-Ink Frame</title>
<link rel="stylesheet" href="/static/style.css">
<style>
  .hero {
    display: flex;
    align-items: center;
    gap: 40px;
    padding: 28px 0 12px;
  }
  .hero-text { flex: 1 1 340px; min-width: 280px; }
  .hero-art { flex: 1 1 320px; min-width: 240px; max-width: 420px; }
  .hero-art svg { width: 100%; height: auto; display: block; }
  .hero-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .hero-brand .brand-name { font-weight: 800; font-size: 1.05rem; }
  .hero h1 {
    font-size: 2.3rem;
    margin: 0 0 14px;
  }
  .hero-sub {
    color: var(--ink-soft);
    font-size: 1.08rem;
    max-width: 46ch;
    margin: 0 0 24px;
  }
  .hero-actions { display: flex; gap: 12px; flex-wrap: wrap; }
  .hero-actions .btn { padding: 12px 22px; font-size: 0.95em; }

  .feature-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin: 8px 0 36px;
  }
  .feature-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    padding: 18px 20px;
    box-shadow: var(--shadow-sm);
  }
  .feature-dot {
    width: 30px; height: 30px;
    border-radius: 50%;
    margin-bottom: 12px;
  }
  .feature-card h3 { margin-bottom: 4px; }
  .feature-card p { color: var(--ink-soft); font-size: 0.92em; margin: 0; }

  details.curious { margin-top: 8px; }
  details.curious summary {
    cursor: pointer;
    font-weight: 700;
    color: var(--ink-soft);
    padding: 4px 0;
  }
  details.curious[open] summary { margin-bottom: 12px; }

  /* ---------- hero e-ink refresh animation ----------
     Mimics a real e-ink panel's refresh cycle: a quick full-panel
     black/white clearing flash, then the new scene builds up one color
     layer at a time instead of popping in all at once — sun first (the
     flash's own last frame is white, so the sun's yellow reads as the
     first "real" color rather than a second, redundant flash step),
     then the hills, the sky behind them, and finally the small red/black
     details. Two scenes alternate forever on one shared 20s timeline, so
     every element's keyframe percentages line up against each other.

     Layer color and paint (z-)order are independent on purpose: the SVG
     below keeps each scene's shapes in their original, visually-correct
     document order (e.g. the blue sky rect stays *before* the green hills
     that overlap it, so the hills paint on top), while these keyframes
     control only *when* a shape's opacity ramps to 1 — a shape's class
     just says which reveal step it belongs to, not where it sits in the
     stack. A color can also appear in more than one non-adjacent spot in
     the DOM (e.g. scene B's ripple is green but must paint *after* the
     blue lake to sit on top of the water) — that's fine, the same
     layer-b-green class just gets applied at both spots and both fade in
     together.

     Each layer's own keyframes only need to describe *when it fades in* —
     the parent .eink-scene-a/-b group masks it to invisible for the rest
     of the cycle, so the layer can just hold opacity:1 afterward. */
  .eink-scene { animation: 20s linear infinite; }
  .eink-scene-a { animation-name: eink-scene-a; }
  .eink-scene-b { animation-name: eink-scene-b; }
  .eink-flash { animation: eink-flash 20s linear infinite; }

  @keyframes eink-flash {
    0%   { opacity: 0; }
    45%  { opacity: 0; }
    46%  { fill: #241f1a; opacity: 1; }
    47%  { fill: #241f1a; opacity: 1; }
    48%  { fill: #ffffff; opacity: 1; }
    49%  { fill: #ffffff; opacity: 1; }
    50%  { opacity: 0; }
    95%  { opacity: 0; }
    96%  { fill: #241f1a; opacity: 1; }
    97%  { fill: #241f1a; opacity: 1; }
    98%  { fill: #ffffff; opacity: 1; }
    99%  { fill: #ffffff; opacity: 1; }
    100% { opacity: 0; }
  }
  @keyframes eink-scene-a {
    0%   { opacity: 1; }
    45%  { opacity: 1; }
    46%  { opacity: 0; }
    100% { opacity: 0; }
  }
  @keyframes eink-scene-b {
    0%   { opacity: 0; }
    49%  { opacity: 0; }
    50%  { opacity: 1; }
    95%  { opacity: 1; }
    96%  { opacity: 0; }
    100% { opacity: 0; }
  }

  /* Scene A layer build order: yellow sun, green hills, blue sky, red
     flowers, black accent. */
  .layer-a-yellow { animation: 20s linear infinite layer-a-yellow; }
  .layer-a-green  { animation: 20s linear infinite layer-a-green; }
  .layer-a-blue   { animation: 20s linear infinite layer-a-blue; }
  .layer-a-red    { animation: 20s linear infinite layer-a-red; }
  .layer-a-black  { animation: 20s linear infinite layer-a-black; }
  @keyframes layer-a-yellow { 0%, 1%  { opacity: 0; } 3%,  100% { opacity: 1; } }
  @keyframes layer-a-green  { 0%, 5%  { opacity: 0; } 7%,  100% { opacity: 1; } }
  @keyframes layer-a-blue   { 0%, 9%  { opacity: 0; } 11%, 100% { opacity: 1; } }
  @keyframes layer-a-red    { 0%, 13% { opacity: 0; } 15%, 100% { opacity: 1; } }
  @keyframes layer-a-black  { 0%, 17% { opacity: 0; } 19%, 100% { opacity: 1; } }

  /* Scene B layer build order: yellow sun, green mountains, blue lake,
     red flag, black dock/birds. */
  .layer-b-yellow { animation: 20s linear infinite layer-b-yellow; }
  .layer-b-green  { animation: 20s linear infinite layer-b-green; }
  .layer-b-blue   { animation: 20s linear infinite layer-b-blue; }
  .layer-b-red    { animation: 20s linear infinite layer-b-red; }
  .layer-b-black  { animation: 20s linear infinite layer-b-black; }
  @keyframes layer-b-yellow { 0%, 51% { opacity: 0; } 53%, 100% { opacity: 1; } }
  @keyframes layer-b-green  { 0%, 55% { opacity: 0; } 57%, 100% { opacity: 1; } }
  @keyframes layer-b-blue   { 0%, 59% { opacity: 0; } 61%, 100% { opacity: 1; } }
  @keyframes layer-b-red    { 0%, 63% { opacity: 0; } 65%, 100% { opacity: 1; } }
  @keyframes layer-b-black  { 0%, 67% { opacity: 0; } 69%, 100% { opacity: 1; } }

  @media (prefers-reduced-motion: reduce) {
    .eink-scene, .eink-flash,
    .layer-a-green, .layer-a-blue, .layer-a-yellow, .layer-a-red, .layer-a-black,
    .layer-b-green, .layer-b-blue, .layer-b-yellow, .layer-b-red, .layer-b-black {
      animation: none;
    }
    .eink-scene-a { opacity: 1; }
    .eink-scene-b, .eink-flash { opacity: 0; }
  }

  @media (max-width: 800px) {
    .hero { flex-direction: column-reverse; text-align: center; padding-top: 8px; }
    .hero-brand { justify-content: center; }
    .hero-sub { max-width: none; }
    .hero-actions { justify-content: center; }
    .feature-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<div class="page">

<section class="hero">
  <div class="hero-text">
    <div class="hero-brand">
      <div class="brand-dots"><span></span><span></span><span></span><span></span><span></span><span></span></div>
      <span class="brand-name">E-Ink Frame</span>
    </div>
    <h1>A photo frame that just works.</h1>
    <p class="hero-sub">
      Send it your favorite photos and it quietly cycles through them &mdash;
      no app to open, no cords to plug in, no glare to squint through.
    </p>
    <div class="hero-actions">
      <a class="btn" href="/admin">Open Admin Dashboard &rarr;</a>
      <a class="btn ghost" href="/provision">Set Up a New Device &rarr;</a>
    </div>
  </div>
  <div class="hero-art" aria-hidden="true">
    <svg viewBox="0 0 400 308" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="200" cy="292" rx="130" ry="12" fill="#241f1a" opacity="0.08"/>
      <rect x="46" y="20" width="308" height="268" rx="14" fill="#8a6a49"/>
      <rect x="46" y="20" width="308" height="268" rx="14" fill="none" stroke="#5d4530" stroke-width="2"/>
      <rect x="66" y="40" width="268" height="228" fill="#ffffff"/>

      <g class="eink-scene eink-scene-a">
        <g class="layer-a-blue">
          <rect x="66" y="40" width="268" height="140" fill="#2e6e8e"/>
        </g>
        <g class="layer-a-yellow">
          <circle cx="272" cy="82" r="26" fill="#c98f1c"/>
        </g>
        <g class="layer-a-green">
          <path d="M66 180 L150 118 L200 160 L250 122 L334 176 L334 268 L66 268 Z" fill="#4c7a4e"/>
          <path d="M66 210 L130 168 L188 202 L246 166 L334 214 L334 268 L66 268 Z" fill="#3d6640"/>
        </g>
        <g class="layer-a-red">
          <circle cx="120" cy="236" r="9" fill="#b23b3b"/>
          <circle cx="146" cy="248" r="6" fill="#b23b3b"/>
        </g>
        <g class="layer-a-black">
          <circle cx="106" cy="252" r="5" fill="#241f1a"/>
        </g>
      </g>

      <g class="eink-scene eink-scene-b">
        <rect x="66" y="40" width="268" height="228" fill="#ffffff"/>
        <g class="layer-b-green">
          <path d="M66 150 L110 122 L150 144 L190 116 L334 150 L334 172 L66 172 Z" fill="#4c7a4e"/>
        </g>
        <g class="layer-b-blue">
          <rect x="66" y="172" width="268" height="96" fill="#2e6e8e"/>
        </g>
        <g class="layer-b-yellow">
          <circle cx="150" cy="88" r="18" fill="#c98f1c"/>
          <polygon points="142,172 158,172 152,230 148,230" fill="#c98f1c" opacity="0.55"/>
        </g>
        <g class="layer-b-green">
          <path d="M66 172 L110 190 L150 176 L190 196 L334 172 Z" fill="#3d6640" opacity="0.45"/>
        </g>
        <g class="layer-b-black">
          <path d="M96 250 L96 268 M230 250 L230 268 M90 250 L236 250" stroke="#241f1a" stroke-width="4" fill="none" stroke-linecap="round"/>
          <path d="M250 226 Q262 214 278 226 L272 236 L256 236 Z" fill="#241f1a"/>
        </g>
        <g class="layer-b-red">
          <polygon points="264,214 264,226 272,220" fill="#b23b3b"/>
        </g>
        <g class="layer-b-black">
          <path d="M270 66 L280 60 L290 66" stroke="#241f1a" stroke-width="2.5" fill="none" stroke-linecap="round"/>
          <path d="M290 76 L300 70 L310 76" stroke="#241f1a" stroke-width="2.5" fill="none" stroke-linecap="round"/>
        </g>
      </g>

      <rect class="eink-flash" x="66" y="40" width="268" height="228" fill="#241f1a"/>
      <rect x="66" y="40" width="268" height="228" fill="none" stroke="#241f1a" stroke-width="2" opacity="0.15"/>
    </svg>
  </div>
</section>

<div class="feature-grid">
  <div class="feature-card">
    <div class="feature-dot" style="background: var(--blue);"></div>
    <h3>Send a photo over</h3>
    <p>Upload from your phone or computer and it shows up on the frame at its next check-in.</p>
  </div>
  <div class="feature-card">
    <div class="feature-dot" style="background: var(--yellow);"></div>
    <h3>Runs for weeks</h3>
    <p>It sleeps between updates and sips battery, so you're not constantly hunting for a charger.</p>
  </div>
  <div class="feature-card">
    <div class="feature-dot" style="background: var(--green);"></div>
    <h3>Looks like paper</h3>
    <p>Real ink colors, not a backlit screen &mdash; readable in any light, with no glow at night.</p>
  </div>
</div>

<div class="card">
  <h2>Setting up a new account</h2>
  <p>
    There's no signup form, no email, no password &mdash; just a
    <strong>passkey</strong> (Face ID, Touch ID, Windows Hello, or a security
    key) from your browser or phone.
  </p>
  <ol>
    <li>Go to <a href="/admin">/admin</a> and create an account with one tap.</li>
    <li>Register your frame's MAC address (shown on its screen during setup) to start sending it photos.</li>
  </ol>
  <p class="hint">Coming back later? Log in with the same passkey &mdash; no password to remember.</p>
</div>

<details class="curious">
  <summary>For the curious: how this works</summary>
  <div class="card">
    <p>
      This is the server half of a custom firmware project for the
      <strong>Seeed Studio XIAO ePaper Display Board (EE02)</strong>, driving a
      13.3&quot; Spectra 6 color e-ink panel. Each board runs custom firmware
      (not Seeed's stock firmware or the SenseCraft app) that wakes from deep
      sleep on a schedule, calls this API directly, displays whatever image
      it's given, and goes back to sleep to save battery.
    </p>
    <p>Per account, this worker handles:</p>
    <ul>
      <li>Registering devices by MAC address</li>
      <li>Storing and rotating images per-device (dithered to the panel's 6-color palette, encrypted end-to-end)</li>
      <li>Per-device or global refresh schedules and quiet hours</li>
      <li>Battery voltage reporting from each device</li>
      <li>Over-the-air firmware updates</li>
    </ul>
    <div class="diagram">
<pre><code>[EE02 board, deep sleep]  --wake-->  GET /device_config, /hash, /image_packed
        ^                                        |
        |                                        v
        +---------- refresh + sleep <---- this worker (Hono + D1 + KV)</code></pre>
    </div>
    <p class="hint">
      New device setup uses Bluetooth &mdash; hold Button 1 during boot (or just
      power it on for the first time, before any WiFi is configured), then pair
      with it from the <a href="/provision">setup page</a>. Works in Chrome or
      Edge (desktop or Android) natively, or Safari/iOS via the
      <a href="https://beacio.com" target="_blank" rel="noopener">Beacio</a>
      polyfill.
    </p>
  </div>
</details>

<footer>
  Firmware, image server, and setup docs live in the
  <a href="https://github.com/matthewfcarlson/seeed_eink_board">project repository</a>.
</footer>

</div>
</body>
</html>`;
}
