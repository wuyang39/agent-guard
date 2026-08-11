const { app, BrowserWindow, dialog, session, shell } = require("electron");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  isExternalHttpUrl,
  isTrustedRendererUrl,
  normalizeElectronRequestDetails,
  probeApiOwnership,
  withControlTokenHeaders,
} = require("./control-plane-security.cjs");

const API_PORT = process.env.API_PORT || "3100";
const SAMPLE_PORT = process.env.SAMPLE_AGENT_PORT || process.env.DEMO_SAMPLE_PORT || "7001";
const FRONTEND_PORT = process.env.DEMO_FRONTEND_PORT || "5173";
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const FRONTEND_BASE = `http://127.0.0.1:${FRONTEND_PORT}`;
const HEALTH_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 450;
const PRODUCT_NAME = "AgentSleuth";
const CONTROL_TOKEN = process.env.AGENT_GUARD_CONTROL_TOKEN || randomBytes(32).toString("base64url");
const UI_PARTITION = "agent-guard-ui";

const isDev = !app.isPackaged || process.env.AGENT_GUARD_DESKTOP_DEV === "1";
const appRoot = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "..");
const PACKAGED_INDEX_URL = pathToFileURL(
  path.join(appRoot, "dist", "frontend", "index.html"),
).href;
const childProcesses = [];

let mainWindow;
let uiSession;
let shuttingDown = false;

app.setAppUserModelId("cn.agentsleuth.desktop");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  try {
    process.chdir(appRoot);
    applyBundledOpenClawDefaults();
    uiSession = session.fromPartition(UI_PARTITION, { cache: false });
    installApiControlTokenHeader(uiSession);
    if (process.env.AGENT_GUARD_DESKTOP_SMOKE === "1") {
      await ensureServicesReady();
      console.log(`${PRODUCT_NAME} desktop smoke check passed.`);
      shutdownChildren();
      app.quit();
      return;
    }
    createMainWindow();
    ensureServicesReady()
      .then(() => loadFrontend())
      .catch((error) => showStartupError(error));
  } catch (error) {
    await showStartupError(error);
  }
});

app.on("before-quit", () => {
  shuttingDown = true;
  shutdownChildren();
});

app.on("window-all-closed", () => {
  shutdownChildren();
  app.quit();
});

function createMainWindow() {
  if (!uiSession) throw new Error("AgentSleuth UI session is unavailable.");
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: PRODUCT_NAME,
    backgroundColor: "#081111",
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: uiSession,
      webviewTag: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isTrustedRendererUrl(url, rendererTrustContext()) && isExternalHttpUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url, rendererTrustContext())) return;
    event.preventDefault();
    if (isExternalHttpUrl(url)) void shell.openExternal(url);
  });

  mainWindow.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame && isTrustedRendererUrl(details.url, rendererTrustContext())) {
      return;
    }
    details.preventDefault();
    if (details.isMainFrame && isExternalHttpUrl(details.url)) {
      void shell.openExternal(details.url);
    }
  });

  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
    if (!shuttingDown) shutdownChildren();
  });

  void mainWindow.loadURL(buildBootScreenUrl());
}

function loadFrontend() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isDev) {
    void mainWindow.loadURL(FRONTEND_BASE);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  void mainWindow.loadFile(path.join(appRoot, "dist", "frontend", "index.html"));
}

async function ensureServicesReady() {
  ensureDirectory(path.join(appRoot, "outputs", "runs"));

  const sampleHealthUrl = `http://127.0.0.1:${SAMPLE_PORT}/health`;
  ensureSampleAgentReadyOptional(sampleHealthUrl);

  const ownership = await probeApiOwnership({
    apiBase: API_BASE,
    controlToken: CONTROL_TOKEN,
  });
  if (ownership.kind === "wrong_service") {
    throw new Error(`Port ${API_PORT} is occupied by a different service.`);
  }
  if (ownership.kind === "token_mismatch") {
    throw new Error("The existing AgentSleuth API uses a different desktop control token.");
  }
  if (ownership.kind === "ownership_unavailable") {
    throw new Error("The existing AgentSleuth API control endpoint is unavailable.");
  }
  if (ownership.kind === "unreachable") {
    startNodeChild("api", ["--import", "tsx", "backend/src/server.ts"], {
      API_PORT,
      API_HOST: "127.0.0.1",
      SAMPLE_AGENT_PORT: SAMPLE_PORT,
      SAMPLE_AGENT_HOST: "127.0.0.1",
      VITE_AGENT_GUARD_API_BASE: API_BASE,
      AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN,
    });
  }
  await waitForApi(API_BASE, `${PRODUCT_NAME} API`);

  if (isDev && !(await isHttpReady(FRONTEND_BASE))) {
    startNodeChild(
      "frontend",
      [
        "node_modules/vite/bin/vite.js",
        "--config",
        "frontend/vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        FRONTEND_PORT,
      ],
      {
        VITE_AGENT_GUARD_API_BASE: API_BASE,
        VITE_OPENCLAW_CLI_PATH: process.env.OPENCLAW_CLI || "",
      },
    );
    await waitForHttp(FRONTEND_BASE, `${PRODUCT_NAME} Frontend`);
  }
}

function installApiControlTokenHeader(targetSession) {
  targetSession.webRequest.onBeforeSendHeaders(
    { urls: [`${API_BASE}/*`] },
    (details, callback) => {
      const requestHeaders = withControlTokenHeaders(
        normalizeElectronRequestDetails(details),
        rendererTrustContext(),
        CONTROL_TOKEN,
      );
      callback({ requestHeaders });
    },
  );
}

function ensureSampleAgentReadyOptional(sampleHealthUrl) {
  void (async () => {
    if (!(await isHttpReady(sampleHealthUrl))) {
      startNodeChild("sample-agent", ["scripts/sample-agent-server.mjs"], {
        SAMPLE_AGENT_PORT: SAMPLE_PORT,
        SAMPLE_AGENT_HOST: "127.0.0.1",
      });
    }
    await waitForHttp(sampleHealthUrl, "Sample Agent");
  })().catch((error) => {
    console.warn(
      `[desktop:sample-agent] optional service unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

function startNodeChild(label, args, extraEnv = {}) {
  const logDir = path.join(appRoot, "outputs", "runs");
  ensureDirectory(logDir);
  const outPath = path.join(logDir, `desktop-${label}.log`);
  const errPath = path.join(logDir, `desktop-${label}.err.log`);
  const outStream = fs.createWriteStream(outPath, { flags: "a" });
  const errStream = fs.createWriteStream(errPath, { flags: "a" });
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.AGENT_GUARD_CONTROL_TOKEN;
  delete inheritedEnv.VITE_AGENT_GUARD_CONTROL_TOKEN;

  const child = spawn(process.execPath, args, {
    cwd: appRoot,
    env: {
      ...inheritedEnv,
      ...extraEnv,
      ELECTRON_RUN_AS_NODE: "1",
      AGENT_GUARD_DESKTOP: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.pipe(outStream);
  child.stderr.pipe(errStream);

  if (isDev) {
    child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  }

  child.on("exit", (code, signal) => {
    outStream.end();
    errStream.end();
    if (!shuttingDown && code && code !== 0) {
      console.error(`[desktop:${label}] exited with code ${code}${signal ? ` (${signal})` : ""}`);
    }
  });

  childProcesses.push({ label, child });
  return child;
}

function shutdownChildren() {
  shuttingDown = true;
  for (const { child } of [...childProcesses].reverse()) {
    if (child.killed) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      continue;
    }
    child.kill();
  }
}

async function waitForApi(apiBase, label) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ownership = await probeApiOwnership({
      apiBase,
      controlToken: CONTROL_TOKEN,
    });
    if (ownership.kind === "ready") return;
    if (ownership.kind === "wrong_service") {
      throw new Error(`Port ${API_PORT} is occupied by a different service.`);
    }
    if (ownership.kind === "token_mismatch") {
      throw new Error("The AgentSleuth API rejected the desktop control token.");
    }
    if (ownership.kind === "ownership_unavailable") {
      throw new Error("The AgentSleuth API control endpoint did not become ready.");
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} did not become ready at ${apiBase}. See outputs/runs/desktop-api.err.log.`);
}

async function waitForHttp(url, label) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHttpReady(url)) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} did not become ready at ${url}.`);
}

async function isHttpReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1600) });
    return response.ok;
  } catch {
    return false;
  }
}

function rendererTrustContext() {
  return {
    apiBase: API_BASE,
    mainWebContentsId: mainWindow?.webContents.id,
    currentRendererUrl: mainWindow?.webContents.getURL() || "",
    trustedViteOrigin: FRONTEND_BASE,
    packagedIndexUrl: PACKAGED_INDEX_URL,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function buildBootScreenUrl() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${PRODUCT_NAME}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        linear-gradient(rgba(31, 64, 92, 0.022) 1px, transparent 1px),
        linear-gradient(90deg, rgba(31, 64, 92, 0.018) 1px, transparent 1px),
        #eef3f1;
      background-size: 32px 32px;
      color: #142126;
      font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }
    main {
      width: min(420px, calc(100vw - 48px));
      display: grid;
      gap: 14px;
    }
    strong {
      font-size: 24px;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: #607177;
      font-size: 14px;
    }
    .bar {
      height: 3px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(15, 118, 110, 0.14);
    }
    .bar::before {
      content: "";
      display: block;
      width: 42%;
      height: 100%;
      border-radius: inherit;
      background: #0f766e;
      animation: slide 1.1s ease-in-out infinite;
    }
    @keyframes slide {
      0% { transform: translateX(-110%); }
      100% { transform: translateX(250%); }
    }
  </style>
</head>
<body>
  <main>
    <strong>${PRODUCT_NAME}</strong>
    <p>启动本地服务</p>
    <div class="bar" aria-hidden="true"></div>
  </main>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function showStartupError(error) {
  await dialog.showMessageBox({
    type: "error",
    title: `${PRODUCT_NAME} 启动失败`,
    message: "桌面程序未能启动本地服务。",
    detail: error instanceof Error ? error.stack || error.message : String(error),
  });
  shutdownChildren();
  app.quit();
}

function applyBundledOpenClawDefaults() {
  if (process.env.OPENCLAW_CLI) return;
  const candidates = [
    path.join(appRoot, "openclaw-runtime", "openclaw-local.cmd"),
    path.join(path.dirname(process.execPath), "openclaw-runtime", "openclaw-local.cmd"),
    process.resourcesPath
      ? path.join(process.resourcesPath, "openclaw-runtime", "openclaw-local.cmd")
      : undefined,
    path.join(path.resolve(appRoot, ".."), "openclaw-runtime", "openclaw-local.cmd"),
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) return;

  process.env.OPENCLAW_CLI = found;
  process.env.OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(path.dirname(found), "home");
  process.env.OPENCLAW_WORKSPACE =
    process.env.OPENCLAW_WORKSPACE || path.join(path.dirname(found), "workspace");
}
