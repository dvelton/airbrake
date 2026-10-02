'use strict';

function renderControlPage({
  chord,
  command,
  generation,
  heartbeatMs,
  leaseMs,
  sessionId,
}) {
  const pageData = JSON.stringify({
    chord,
    command,
    generation,
    heartbeatMs,
    leaseMs,
    sessionId,
  })
    .replaceAll('<', '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Airbrake Control</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: #111418;
      color: #f6f7f8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, #25313d 0, #111418 45%),
        #111418;
    }
    main {
      width: min(760px, calc(100vw - 32px));
      display: grid;
      gap: 18px;
    }
    .panel {
      border: 1px solid #37424d;
      background: rgba(20, 24, 29, 0.94);
      border-radius: 14px;
      padding: 20px;
      box-shadow: 0 18px 70px rgba(0, 0, 0, 0.35);
    }
    h1 { margin: 0 0 8px; font-size: 26px; }
    p { line-height: 1.55; color: #bac3cc; margin: 8px 0; }
    code { color: #f5c46b; overflow-wrap: anywhere; }
    #status {
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #ff7b72;
    }
    #hold {
      width: 100%;
      min-height: 270px;
      border: 2px solid #7f3232;
      border-radius: 18px;
      background: linear-gradient(180deg, #4a2020, #2b1515);
      color: #fff;
      font: inherit;
      font-size: clamp(22px, 5vw, 42px);
      font-weight: 800;
      cursor: pointer;
      user-select: none;
      touch-action: none;
    }
    #hold.armed {
      border-color: #3fb950;
      background: linear-gradient(180deg, #1f6330, #123b1d);
      box-shadow: 0 0 42px rgba(63, 185, 80, 0.25);
    }
    #hold:focus-visible { outline: 3px solid #58a6ff; outline-offset: 4px; }
    .details {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      font-size: 13px;
      color: #9ba7b2;
    }
    .warning {
      border-left: 4px solid #d29922;
      padding-left: 12px;
      color: #d8c18d;
    }
  </style>
</head>
<body>
  <main>
    <section class="panel">
      <h1>Airbrake</h1>
      <p>Proof-of-concept hold-to-run control for a local coding agent.</p>
      <p>Command: <code id="command"></code></p>
      <p>State: <span id="status">BRAKED</span></p>
    </section>

    <button id="hold" type="button" aria-pressed="false">
      HOLD TO RUN
    </button>

    <section class="panel">
      <div class="details">
        <div>Mouse: hold the button</div>
        <div>Keyboard: hold <span id="chord"></span></div>
        <div>Lease: <span id="lease"></span> ms</div>
      </div>
      <p class="warning">
        Keep this page visible. Releasing the control, hiding the page, closing it,
        or losing heartbeats applies the brake.
      </p>
    </section>
  </main>
  <script>
    'use strict';
    const data = ${pageData};
    const controlToken = location.hash.slice(1);
    history.replaceState(null, '', location.pathname);

    const button = document.querySelector('#hold');
    const chord = document.querySelector('#chord');
    const command = document.querySelector('#command');
    const lease = document.querySelector('#lease');
    const status = document.querySelector('#status');
    let holding = false;
    let heartbeatTimer = null;
    const pressed = new Set();
    let generation = data.generation;
    let activeGeneration = 0;

    chord.textContent = data.chord.join(' + ');
    command.textContent = data.command;
    lease.textContent = data.leaseMs;

    async function request(path, keepalive = false) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + controlToken },
        keepalive,
      });
      if (!response.ok) {
        throw new Error('Control request failed: ' + response.status);
      }
      return response.json();
    }

    function render(armed) {
      button.classList.toggle('armed', armed);
      button.setAttribute('aria-pressed', String(armed));
      button.textContent = armed ? 'RUNNING - RELEASE TO BRAKE' : 'HOLD TO RUN';
      status.textContent = armed ? 'ARMED' : 'BRAKED';
      status.style.color = armed ? '#56d364' : '#ff7b72';
    }

    async function startHold(event) {
      if (holding || !controlToken) return;
      if (event && event.pointerId !== undefined) {
        button.setPointerCapture(event.pointerId);
      }
      holding = true;
      const startedGeneration = ++generation;
      activeGeneration = startedGeneration;
      heartbeatTimer = setInterval(async () => {
        try {
          const next = await request(
            '/api/hold/heartbeat?generation=' + startedGeneration
          );
          generation = Math.max(generation, next.controlGeneration || 0);
          if (!holding || activeGeneration !== startedGeneration) {
            return;
          }
          render(next.armed);
        } catch {
          if (activeGeneration === startedGeneration) {
            stopHold('heartbeat-failed');
          }
        }
      }, data.heartbeatMs);
      try {
        const snapshot = await request('/api/hold/start?generation=' + startedGeneration);
        generation = Math.max(generation, snapshot.controlGeneration || 0);
        if (!holding || activeGeneration !== startedGeneration) {
          return;
        }
        render(snapshot.armed);
      } catch {
        if (activeGeneration === startedGeneration) {
          stopHold('start-failed');
        }
      }
    }

    async function stopHold(reason = 'released') {
      const hadActiveHold =
        holding || activeGeneration !== 0 || heartbeatTimer !== null;
      holding = false;
      activeGeneration = 0;
      pressed.clear();
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      render(false);
      if (!hadActiveHold) {
        return;
      }
      try {
        const releasedGeneration = ++generation;
        await request(
          '/api/hold/release?reason=' + encodeURIComponent(reason) +
          '&generation=' + releasedGeneration,
          true
        );
      } catch {}
    }

    button.addEventListener('pointerdown', startHold);
    button.addEventListener('pointerup', () => stopHold('pointer-released'));
    button.addEventListener('pointercancel', () => stopHold('pointer-cancelled'));
    button.addEventListener('lostpointercapture', () => stopHold('pointer-capture-lost'));
    window.addEventListener('keydown', (event) => {
      if (data.chord.includes(event.code)) {
        event.preventDefault();
        pressed.add(event.code);
        if (data.chord.every((code) => pressed.has(code))) {
          startHold(event);
        }
      }
    });
    window.addEventListener('keyup', (event) => {
      if (data.chord.includes(event.code)) {
        event.preventDefault();
        pressed.delete(event.code);
        stopHold('key-released');
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopHold('page-hidden');
    });
    window.addEventListener('blur', () => stopHold('window-blurred'));
    window.addEventListener('pagehide', () => stopHold('page-closed'));

    setInterval(async () => {
      try {
        const response = await fetch('/api/status', {
          headers: { Authorization: 'Bearer ' + controlToken },
          cache: 'no-store',
        });
        if (response.ok) {
          const snapshot = await response.json();
          generation = Math.max(generation, snapshot.controlGeneration || 0);
          if (!holding || !snapshot.armed) render(snapshot.armed);
        }
      } catch {
        render(false);
      }
    }, 250);
  </script>
</body>
</html>`;
}

module.exports = { renderControlPage };
