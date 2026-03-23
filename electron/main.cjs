const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "GangOwl",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: "#0c0b14",
    show: false,
  });

  // Load the built Vite app
  mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));

  // Show when ready to prevent white flash
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Remove default menu (optional: replace with custom)
  Menu.setApplicationMenu(null);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});
