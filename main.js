const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

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
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
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
});

app.on('window-all-closed', () => {
  app.quit();
});
