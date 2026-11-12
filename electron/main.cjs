/**
 * Desktop shell. It shows the same web app that runs in the browser, served
 * from the application bundle through the app:// scheme, with two additions:
 *
 *  - AI endpoints can be reached whatever their CORS settings are, so a local
 *    Ollama or LM Studio works out of the box;
 *  - links open in the system browser.
 *
 * The page gets no Node.js access.
 */
const { app, BrowserWindow, Menu, nativeTheme, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://superprocess';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

/** Serves files from the bundled web app; anything outside it is refused. */
function serveApp() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(DIST, relative));
    if (!file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

/**
 * The app talks to whichever AI endpoint the user configured. Browsers only
 * allow that when the endpoint opts in with CORS headers, which local servers
 * often do not. The shell answers on their behalf for requests made by the app.
 */
function relaxCors() {
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const headers = {};
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      if (!/^access-control-/i.test(name)) headers[name] = value;
    }
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Headers'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
    headers['Access-Control-Expose-Headers'] = ['*'];
    // Servers without CORS support reject the preflight request; accept it for them.
    const preflight = details.method === 'OPTIONS';
    callback(preflight ? { responseHeaders: headers, statusLine: 'HTTP/1.1 204 No Content' } : { responseHeaders: headers });
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'SuperProcess',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0e15' : '#f4f5f9',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  window.once('ready-to-show', () => window.show());

  // Only the app itself is shown in the window; everything else opens in the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  void window.loadURL(`${ORIGIN}/index.html`);
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(() => {
    serveApp();
    relaxCors();
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
