import { is } from "@electron-toolkit/utils";
import { BaseWindow, BrowserWindow } from "electron";
import { join } from "path";

export class AgentOverlay {
  private win: BrowserWindow;
  private ready: boolean = false;
  private baseWindow: BaseWindow;

  constructor(baseWindow: BaseWindow) {
    this.baseWindow = baseWindow;
    this.win = this.createWindow(baseWindow);
  }

  private createWindow(baseWindow: BaseWindow): BrowserWindow {
    const parentAny = baseWindow as any;

    const win = new BrowserWindow({
      parent: parentAny,
      modal: false,
      show: true,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      focusable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
      },
    });

    try {
      win.setIgnoreMouseEvents(true, { forward: true });
    } catch {
      // ignore
    }

    try {
      win.setAlwaysOnTop(true, "screen-saver");
    } catch {
      // ignore
    }

    win.webContents.on("dom-ready", async () => {
      try {
        await win.webContents.insertCSS(`
          html, body, #root {
            background: transparent !important;
          }
        `);
      } catch {
        // ignore
      }

      try {
        await win.webContents.executeJavaScript(`(() => {
          try {
            document.documentElement.style.background = 'transparent';
            document.body && (document.body.style.background = 'transparent');
            const root = document.getElementById('root');
            if (root) root.style.background = 'transparent';
          } catch {
            // ignore
          }
        })();`);
      } catch {
        // ignore
      }
    });

    win.webContents.on("did-finish-load", () => {
      this.ready = true;
    });

    if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
      const overlayUrl = new URL("/overlay/", process.env["ELECTRON_RENDERER_URL"]);
      win.loadURL(overlayUrl.toString());
    } else {
      win.loadFile(join(__dirname, "../renderer/overlay.html"));
    }

    return win;
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    try {
      const parentAny = this.baseWindow as any;
      const parentBounds = this.baseWindow.getBounds();
      const contentBounds =
        typeof parentAny.getContentBounds === "function" ? parentAny.getContentBounds() : null;

      const originX = contentBounds && typeof contentBounds.x === "number" ? contentBounds.x : parentBounds.x;
      const originY = contentBounds && typeof contentBounds.y === "number" ? contentBounds.y : parentBounds.y;

      this.win.setBounds(
        {
          x: originX + bounds.x,
          y: originY + bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
        false
      );
    } catch {
      // ignore
    }
  }

  async sendEvent(event: any): Promise<void> {
    if (!this.ready) return;
    const payload = JSON.stringify(event ?? {});
    const js = `(() => {\n      try {\n        return window.__bbAgentOverlay && typeof window.__bbAgentOverlay.onEvent === 'function'\n          ? window.__bbAgentOverlay.onEvent(${payload})\n          : false;\n      } catch {\n        return false;\n      }\n    })();`;

    try {
      await this.win.webContents.executeJavaScript(js);
    } catch {
      // ignore
    }
  }

  show(): void {
    try {
      this.win.showInactive();
    } catch {
      // ignore
    }

    try {
      this.win.setIgnoreMouseEvents(true, { forward: true });
    } catch {
      // ignore
    }

    try {
      this.win.setAlwaysOnTop(true, "screen-saver");
    } catch {
      // ignore
    }
  }

  hide(): void {
    try {
      this.win.hide();
    } catch {
      // ignore
    }
  }

  destroy(): void {
    try {
      this.win.close();
    } catch {
      // ignore
    }
  }
}
