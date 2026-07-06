const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const net = require("net");

const isDev = process.env.NODE_ENV === "development";
const SERVER_PORT = 3460;
const VITE_PORT = 5183;

const children = [];

function spawnHidden(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    windowsHide: true,
    stdio: "ignore",
    shell: true,
    ...opts,
  });
  children.push(child);
  return child;
}

function waitForPort(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      const sock = net.createConnection(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start > timeout) return reject(new Error(`Port ${port} timeout`));
        setTimeout(attempt, 300);
      });
    }
    attempt();
  });
}

function startServices() {
  const root = path.join(__dirname, "..");
  const tsxBin = path.join(root, "node_modules", ".bin", "tsx");
  const viteBin = path.join(root, "node_modules", ".bin", "vite");
  const env = { ...process.env, NODE_ENV: isDev ? "development" : "production" };

  // Express server
  spawnHidden(`"${tsxBin}" "${path.join(root, "server", "index.ts")}"`, [], { env, cwd: root });

  // Vite dev server (dev only — prod serves via express static)
  if (isDev) {
    spawnHidden(`"${viteBin}"`, [], { env, cwd: root });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "Kie Studio",
    backgroundColor: "#0f0f0f",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
  });

  const url = isDev
    ? `http://localhost:${VITE_PORT}`
    : `http://localhost:${SERVER_PORT}`;

  win.loadURL(url);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(async () => {
  startServices();

  // Wait for whichever port the window will load from
  const waitPort = isDev ? VITE_PORT : SERVER_PORT;
  try {
    await waitForPort(waitPort);
  } catch {
    // Open anyway if timeout — better than hanging
  }

  createWindow();
});

function killChildren() {
  children.forEach((c) => {
    try {
      // On Windows, shell:true spawns a cmd wrapper — taskkill /T kills the whole tree
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(c.pid)], { shell: false, stdio: "ignore" });
      } else {
        c.kill("SIGTERM");
      }
    } catch {}
  });
}

app.on("window-all-closed", () => {
  killChildren();
  app.quit();
});

app.on("before-quit", () => killChildren());
