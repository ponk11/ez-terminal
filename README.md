# EZ-Terminal

EZ-Terminal is a fast, dark, browser-based terminal for macOS, Linux, and Windows. It opens a real local shell and connects to it over a WebSocket.

## Requirements

- Node.js 20 or newer
- A C++ build toolchain for `node-pty` on your platform

## Run locally

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000`. The server binds to `127.0.0.1` by default, so it is not exposed to other devices on the network.

## Reliable sessions

- PTY sessions remain alive while you temporarily lose or replace a browser connection.
- Reconnecting with the same browser restores the same session.
- The browser reconnects automatically after a dropped WebSocket.
- Terminal output is buffered by the server, and WebSocket heartbeats detect stalled connections.
- Browser sessions are retained locally for 30 minutes after the last disconnected use.

For development with hot reload:

```bash
npm install
npm run dev
```

Set a custom host or port when needed:

```bash
HOST=127.0.0.1 PORT=3000 npm start
```

When `PORT` is not specified and port 3000 is occupied, EZ-Terminal tries ports 3001 through 3009 and reports the port it selected. Set `PORT` explicitly when you need a fixed port; startup will then report an occupied port clearly instead of changing it.

## Shell behavior

- macOS and Linux use `$SHELL`, falling back to `/bin/bash`
- Windows uses `COMSPEC`, falling back to `powershell.exe`
- The initial working directory is the directory used to start EZ-Terminal

This application runs commands with the permissions of the user who started it. It has no command allowlist or sandbox. Only expose it beyond localhost if you understand and accept that risk.

## Optional Docker mini-VPS mode

Docker mode gives each browser session an isolated Ubuntu container with a persistent named volume mounted at `/workspace`. The storage is bounded only by the Docker host's available disk.

SSH and other command-line tools are available inside each mini-VPS container. SSH keys and files placed under `/workspace` remain stored in the session's Docker volume across browser reconnects and server restarts. Containers are automatically recreated from the same volume when needed.

Start it with Docker Compose:

```bash
docker compose up --build
```

The Docker Compose setup mounts the Docker socket, which grants EZ-Terminal control of Docker on the host. Run it only on a machine you trust and keep it bound to localhost.
