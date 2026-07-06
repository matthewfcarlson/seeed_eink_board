/**
 * Static marketing/info page served at "/". Explains what the worker does and
 * links to /admin. No secrets or dynamic data here — safe to serve with no auth.
 */
export function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E-Ink Frame Server</title>
<style>
  :root { color-scheme: light; }
  body { font-family: Arial, sans-serif; max-width: 860px; margin: 0 auto; padding: 48px 16px 64px; background: #f6f7f9; color: #222; line-height: 1.5; }
  h1 { font-size: 1.9rem; margin-bottom: 4px; }
  h2 { font-size: 1.2rem; margin-top: 0; }
  .tagline { color: #555; margin-top: 0; }
  .card { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 22px 26px; margin-bottom: 20px; }
  code, pre { background: #eef1f4; border-radius: 4px; font-size: 0.88em; }
  code { padding: 2px 5px; }
  pre { padding: 14px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  ol, ul { padding-left: 1.3em; }
  li { margin-bottom: 6px; }
  .btn { display: inline-block; background: #0b67d0; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 1em; text-decoration: none; font-weight: bold; }
  .btn:hover { background: #0954ac; }
  .hint { color: #666; font-size: 0.9em; }
  .diagram { font-size: 0.8em; overflow-x: auto; }
  footer { text-align: center; color: #888; font-size: 0.85em; margin-top: 32px; }
  footer a { color: #888; }
</style>
</head>
<body>

<h1>E-Ink Frame Server</h1>
<p class="tagline">Backend for Seeed XIAO EE02 e-ink photo frames &mdash; runs on Cloudflare Workers.</p>

<div class="card">
  <h2>What this is</h2>
  <p>
    This worker is the server half of a custom firmware project for the
    <strong>Seeed Studio XIAO ePaper Display Board (EE02)</strong>, which drives a
    13.3&quot; Spectra 6 color e-ink panel. Each board runs custom firmware (not
    Seeed's stock firmware or the SenseCraft app) that wakes from deep sleep on a
    schedule, calls this API directly, displays whatever image it's given, and goes
    back to sleep to save battery.
  </p>
  <p>This worker handles, per user account:</p>
  <ul>
    <li>Registering devices by MAC address</li>
    <li>Storing and rotating images per-device (with dithering to the panel's 6-color palette)</li>
    <li>Per-device or global refresh schedules and quiet hours</li>
    <li>Battery voltage reporting from each device</li>
  </ul>
  <div class="diagram">
<pre><code>[EE02 board, deep sleep]  --wake-->  GET /device_config, /hash, /image_packed
        ^                                        |
        |                                        v
        +---------- refresh + sleep <---- this worker (Hono + D1 + KV)</code></pre>
  </div>
</div>

<div class="card">
  <h2>Manage your frames</h2>
  <p>Devices, images, and schedules are all managed from the admin dashboard.</p>
  <p><a class="btn" href="/admin">Open Admin Dashboard &rarr;</a></p>
</div>

<div class="card">
  <h2>Setting up a new user</h2>
  <p>
    Accounts are created entirely from the dashboard &mdash; there's no signup
    form, no email, no password. Creating an account is just registering a
    <strong>passkey</strong> (Face ID, Touch ID, Windows Hello, or a security key);
    the passkey <em>is</em> the account.
  </p>
  <ol>
    <li>Go to <a href="/admin">/admin</a>, open the &quot;Create account&quot; tab, and click the button.</li>
    <li>Follow your browser/OS prompt to create a passkey.</li>
    <li>Save the API key shown once after signup if you also want scripted (non-browser) access.</li>
    <li>Register your board's MAC address (shown when the board enters config mode) to start managing its images and schedule.</li>
  </ol>
  <p class="hint">Returning later? Use the same passkey to log back in from the &quot;Log in&quot; tab &mdash; no need to keep the API key around unless you're scripting against the API directly.</p>
</div>

<footer>
  Firmware, image server, and setup docs live in the
  <a href="https://github.com/matthewfcarlson/seeed_eink_board">project repository</a>.
</footer>

</body>
</html>`;
}
