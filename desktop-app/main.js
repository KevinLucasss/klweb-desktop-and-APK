const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'KL Web - Gestão Inteligente'
  });

  // Carrega os arquivos locais do KL Web
  mainWindow.loadFile(path.join(__dirname, 'www', 'index.html'));

  // Avisa ao site que ele está rodando dentro do App para esconder botões de download
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript("document.body.classList.add('is-app');");
  });

  // Menu da aplicação
  const menu = Menu.buildFromTemplate([
    {
      label: 'Arquivo',
      submenu: [
        {
          label: 'Recarregar',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            mainWindow.reload();
          }
        },
        {
          label: 'DevTools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            mainWindow.webContents.openDevTools();
          }
        },
        { type: 'separator' },
        {
          label: 'Sair',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: 'Visualizar',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Ajuda',
      submenu: [
        {
          label: 'Sobre o KL Web',
          click: () => {
            shell.openExternal('https://klweb.com.br');
          }
        },
        {
          label: 'Documentação',
          click: () => {
            shell.openExternal('https://github.com/KevinLucasss/Replit');
          }
        },
        {
          label: 'Relatar Problema',
          click: () => {
            shell.openExternal('https://github.com/KevinLucasss/Replit/issues');
          }
        }
      ]
    }
  ]);

  Menu.setApplicationMenu(menu);

  // Abre links externos no navegador padrão
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App events
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Prevenir navegação para outros domínios
app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    
    if (parsedUrl.origin !== 'https://klweb.com.br' &&
        parsedUrl.origin !== 'https://kl-web.onrender.com' &&
        !navigationUrl.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(navigationUrl);
    }
  });
});
