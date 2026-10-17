const { app, BrowserWindow, shell, ipcMain, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { fetchOfficialUpdates } = require('./scripts/gk-updater.js');

/* ============ 窗口状态记忆（P2）：尺寸/位置/最大化，关窗时保存 ============ */
const WIN_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
function loadWinState() {
  try {
    const s = JSON.parse(fs.readFileSync(WIN_STATE_FILE(), 'utf8'));
    const width = Math.min(Math.max(Number(s.width) || 1360, 900), 3600);
    const height = Math.min(Math.max(Number(s.height) || 880, 600), 2200);
    // 位置必须落在某个显示器内，否则丢弃（防拔掉外接显示器后窗口"消失"）
    let x, y;
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      const onScreen = screen.getAllDisplays().some(d =>
        s.x >= d.workArea.x - 10 && s.x < d.workArea.x + d.workArea.width &&
        s.y >= d.workArea.y - 10 && s.y < d.workArea.y + d.workArea.height);
      if (onScreen) { x = Math.round(s.x); y = Math.round(s.y); }
    }
    return { width, height, ...(x !== undefined ? { x, y } : {}), maximized: !!s.maximized };
  } catch (e) {
    return { width: 1360, height: 880 };
  }
}
function saveWinState(win) {
  try {
    const b = win.getBounds();
    fs.writeFileSync(WIN_STATE_FILE(), JSON.stringify({
      width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized()
    }), 'utf8');
  } catch (e) { /* 忽略 */ }
}

/* ⚠️ 必须在 app.whenReady() 之前调用。
 *
 * 为什么关掉硬件加速：在虚拟机、无独显、缺显卡驱动、远程桌面等环境下，Chromium 的 GPU 进程
 * 起不来，Electron 会直接打出一行
 *     FATAL:gpu_data_manager_impl_private.cc(423)] GPU process isn't usable. Goodbye.
 * 然后**整个应用退出**（不是降级，是崩溃）。本机实测就会这样。
 *
 * 本应用只渲染表格和图表，软件渲染完全够用，用一点点渲染性能换「任何机器都能打开」很划算。
 */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
// ⚠️ 这一行是必需的，不是可选的。本机实测：只加 disable-gpu 仍会 FATAL 退出，
//    加上 no-sandbox（GPU 进程沙箱在虚拟机/受限环境下创建失败）才真正绕过。
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

function createWindow() {
  const st = loadWinState();
  const win = new BrowserWindow({
    width: st.width,
    height: st.height,
    ...(st.x !== undefined ? { x: st.x, y: st.y } : {}),
    minWidth: 1100,
    minHeight: 700,
    title: '考公岗位信息助手',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false
    },
    icon: path.join(__dirname, 'app.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa'
  });
  if (st.maximized) win.maximize();
  win.on('close', () => saveWinState(win));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 官方数据自动检查（国考报名统计等）：启动 15s 后静默跑一次，24h 限频在 updater 内部。
  // 失败完全静默——网络不可用不影响应用本身。
  setTimeout(() => {
    fetchOfficialUpdates(false).then(r => {
      if (r.updated) {
        try {
          new Notification('考公岗位信息助手', { body: '官方数据已更新：' + r.msg });
        } catch (e) { /* 无通知环境忽略 */ }
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('gk-data-updated', r.msg));
      }
    }).catch(() => { /* 静默 */ });
  }, 15000);

  // 数据管理页「检查官方数据更新」按钮（手动触发，忽略 24h 限频）
  ipcMain.handle('gk:check-update', async () => {
    try { return await fetchOfficialUpdates(true); }
    catch (e) { return { updated: false, msg: '检查失败：' + e.message }; }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
