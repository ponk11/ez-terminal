import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

document.querySelector("#app").innerHTML = `
  <main class="shell-app">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">&gt;_</span>
        <span>EZ-Terminal</span>
      </div>
      <div class="sidebar-section">
        <div class="section-label">Session</div>
        <button class="session-row active" id="currentSession">
          <span class="status-dot"></span>
          <span>
            <strong>Local terminal</strong>
            <small id="sessionState">Connecting...</small>
          </span>
        </button>
      </div>
      <button class="new-session" id="newSession">
        <span>+</span> New session
      </button>
      <div class="sidebar-footer">
        <span class="shield">◆</span>
        <span id="storageLabel">Local only</span>
      </div>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <button class="icon-button menu-button" id="menuButton" aria-label="Toggle sidebar">☰</button>
        <div class="tab">
          <span class="status-dot"></span>
          <span>bash</span>
          <button class="tab-close" id="tabClose" aria-label="Close terminal">×</button>
        </div>
        <div class="top-actions">
          <button class="icon-button" id="clearButton" title="Clear terminal">⌫</button>
          <span class="shortcut"><kbd>Ctrl</kbd><kbd>L</kbd></span>
        </div>
      </header>
      <div class="terminal-wrap" id="terminalWrap">
        <div id="terminal"></div>
      </div>
    </section>
  </main>
`;

const terminalElement = document.querySelector("#terminal");
const terminalWrap = document.querySelector("#terminalWrap");
const sessionState = document.querySelector("#sessionState");
const terminal = new Terminal({
  cursorBlink: true,
  cursorStyle: "block",
  fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  fontSize: 14,
  lineHeight: 1.35,
  theme: {
    background: "#111214",
    foreground: "#e6e8eb",
    cursor: "#f4f4f5",
    cursorAccent: "#111214",
    selectionBackground: "#3a3d43",
    black: "#151619",
    red: "#f87171",
    green: "#86efac",
    yellow: "#fde68a",
    blue: "#93c5fd",
    magenta: "#d8b4fe",
    cyan: "#67e8f9",
    white: "#d4d4d8",
  },
  allowProposedApi: true,
});

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalElement);

let socket;
let reconnectTimer;
function fit() {
  fitAddon.fit();
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: "resize",
      cols: terminal.cols,
      rows: terminal.rows,
    }));
  }
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (socket) socket.close();
  sessionState.textContent = "Connecting...";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let sessionId = localStorage.getItem("ez-terminal-session");
  if (!sessionId || !/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) {
    sessionId = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
    localStorage.setItem("ez-terminal-session", sessionId);
  }
  socket = new WebSocket(`${protocol}//${location.host}/terminal?session=${encodeURIComponent(sessionId)}`);

  socket.addEventListener("open", () => {
    sessionState.textContent = "Connected";
    fit();
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "data") terminal.write(message.data);
    if (message.type === "session") {
      localStorage.setItem("ez-terminal-session", message.id);
    }
    if (message.type === "error") terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
    if (message.type === "exit") {
      sessionState.textContent = "Session ended";
    }
  });

  const thisSocket = socket;
  thisSocket.addEventListener("close", () => {
    if (socket !== thisSocket) return;
    sessionState.textContent = "Disconnected";
    reconnectTimer = setTimeout(() => {
      if (document.visibilityState === "visible") connect();
    }, 1500);
  });
}

terminal.onData((data) => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "input", data }));
  }
});

new ResizeObserver(() => fit()).observe(terminalWrap);
window.addEventListener("resize", fit);
function startNewSession() {
  localStorage.removeItem("ez-terminal-session");
  if (socket) socket.close();
  terminal.clear();
  terminal.reset();
  connect();
}
document.querySelector("#newSession").addEventListener("click", startNewSession);
document.querySelector("#tabClose").addEventListener("click", startNewSession);
document.querySelector("#clearButton").addEventListener("click", () => {
  terminal.clear();
  terminal.focus();
});
document.querySelector("#menuButton").addEventListener("click", () => {
  document.querySelector(".sidebar").classList.toggle("open");
});

fetch("/api/status")
  .then((response) => response.json())
  .then((status) => {
    document.querySelector("#storageLabel").textContent =
      status.mode === "docker" ? "Docker storage" : "Local host storage";
  })
  .catch(() => {});

connect();
