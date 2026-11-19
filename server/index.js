import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
const dockerMode = process.env.EZ_TERMINAL_MODE === "docker";
const execFileAsync = promisify(execFile);
const sessions = new Map();
const sessionLifetimeMs = 30 * 60 * 1000;
const maxOutputBuffer = 256 * 1024;

function resolveHostShell() {
  if (os.platform() === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  const configuredShell = process.env.SHELL;
  if (configuredShell && fs.existsSync(configuredShell)) return configuredShell;
  return fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

async function waitForDockerContainer(containerName) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await execFileAsync("docker", ["exec", containerName, "test", "-f", "/tmp/.ez-ready"], {
        timeout: 5000,
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Docker container did not finish starting");
}

app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.get("/api/status", (_req, res) => {
  res.json({
    mode: dockerMode ? "docker" : "host",
    os: os.platform(),
    arch: os.arch(),
    persistentStorage: dockerMode ? "Docker named volume" : "Host directory",
  });
});

const development = process.argv.includes("--dev");
if (!development) {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(root, "dist", "index.html"));
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

server.on("upgrade", (request, socket, head) => {
  if (!request.url?.startsWith("/terminal")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (socket) => {
    wss.emit("connection", socket, request);
  });
});

wss.on("connection", async (socket, request) => {
  const requestedSession = new URL(request.url, "http://localhost").searchParams.get("session");
  const sessionId =
    requestedSession && /^[a-zA-Z0-9_-]{8,80}$/.test(requestedSession)
      ? requestedSession
      : crypto.randomBytes(12).toString("hex");

  let session = sessions.get(sessionId);
  if (!session) {
    try {
      let shellPath;
      let shellArgs = [];
      let cwd = process.env.EZ_TERMINAL_HOME || process.cwd();
      let env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };

      if (dockerMode) {
        await execFileAsync("docker", ["version"], { timeout: 10000 });
        const volumeName = `ez-terminal-${sessionId}`;
        const containerName = `ez-terminal-${sessionId}`;
        await execFileAsync("docker", ["volume", "create", volumeName]);
        await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => {});
        await execFileAsync("docker", [
          "run",
          "-dit",
          "--name",
          containerName,
          "--hostname",
          "ez-terminal",
          "-v",
          `${volumeName}:/workspace`,
          "-w",
          "/workspace",
          "ubuntu:24.04",
          "/bin/bash",
          "-lc",
          "apt-get update >/dev/null 2>&1; apt-get install -y bash curl git openssh-client iputils-ping less nano procps >/dev/null 2>&1 || true; touch /tmp/.ez-ready; exec sleep infinity",
        ]);
        await waitForDockerContainer(containerName);
        shellPath = "docker";
        shellArgs = ["exec", "-it", containerName, "/bin/bash", "-l"];
        env = { ...env, HOME: "/root" };
        cwd = process.cwd();
      } else {
        shellPath = resolveHostShell();
      }

      const shell = pty.spawn(shellPath, shellArgs, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,
        env,
      });
      session = {
        id: sessionId,
        shell,
        socket: null,
        outputBuffer: "",
        lastActive: Date.now(),
        dockerMode,
      };
      sessions.set(sessionId, session);

      shell.onData((data) => {
        session.lastActive = Date.now();
        session.outputBuffer =
          (session.outputBuffer + data).slice(-maxOutputBuffer);
        if (session.socket && session.socket.readyState === session.socket.OPEN) {
          session.socket.send(JSON.stringify({ type: "data", data }));
        }
      });
      shell.onExit(({ exitCode, signal }) => {
        session.lastActive = Date.now();
        if (session.socket && session.socket.readyState === session.socket.OPEN) {
          session.socket.send(JSON.stringify({ type: "exit", exitCode, signal }));
        }
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
        if (session.dockerMode) {
          execFileAsync("docker", ["rm", "-f", `ez-terminal-${sessionId}`]).catch(() => {});
        }
      });
    } catch (error) {
      socket.send(JSON.stringify({
        type: "error",
        message: `Could not start terminal: ${error.message}`,
      }));
      socket.close();
      return;
    }
  }

  session.socket = socket;
  session.lastActive = Date.now();
  socket.isAlive = true;
  socket.send(JSON.stringify({ type: "session", id: sessionId }));
  if (session.outputBuffer) {
    socket.send(JSON.stringify({ type: "data", data: session.outputBuffer }));
  }

  socket.on("pong", () => {
    socket.isAlive = true;
  });
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "input") session.shell.write(message.data);
      if (message.type === "resize") {
        session.shell.resize(
          Math.max(2, Math.min(500, Number(message.cols) || 100)),
          Math.max(1, Math.min(200, Number(message.rows) || 30)),
        );
      }
    } catch {
      // Ignore malformed browser messages.
    }
  });
  socket.on("close", () => {
    session.lastActive = Date.now();
    if (session.socket === socket) session.socket = null;
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    socket.ping();
  });
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

setInterval(() => {
  for (const [id, session] of sessions) {
    if (!session.socket && Date.now() - session.lastActive > sessionLifetimeMs) {
      session.shell.kill();
      sessions.delete(id);
      if (session.dockerMode) {
        execFileAsync("docker", ["rm", "-f", `ez-terminal-${id}`]).catch(() => {});
      }
    }
  }
}, 5 * 60 * 1000).unref();

const portWasExplicit = Boolean(process.env.PORT);
let listeningPort = port;

function listen() {
  server.listen(listeningPort, host);
}

server.on("listening", () => {
  console.log(`EZ-Terminal is running at http://localhost:${listeningPort}`);
  console.log(`Local host only: ${host}:${listeningPort}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && !portWasExplicit && listeningPort < port + 10) {
    listeningPort += 1;
    console.warn(
      `Port ${listeningPort - 1} is already in use; trying http://${host}:${listeningPort}`,
    );
    setImmediate(listen);
    return;
  }

  if (error.code === "EADDRINUSE") {
    console.error(`Could not start EZ-Terminal: port ${listeningPort} is already in use.`);
  } else {
    console.error(`Could not start EZ-Terminal: ${error.message}`);
  }
  process.exit(1);
});

listen();
