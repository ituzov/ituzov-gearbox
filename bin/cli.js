#!/usr/bin/env node
// Точка входа: `npx ituzov-gearbox` (или `gearbox` при глобальной установке).
// Поднимает локальный сервер и открывает окно-гаджет с коробкой передач.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";
import { isAvailable } from "../src/tmux.js";

const DEFAULT_PORT = 4321;

// Размер окна подогнан ровно под консоль коробки.
const WIN_W = 440;
const WIN_H = 706;
const MARGIN = 12; // отступ от краёв экрана

// Chromium-браузеры, умеющие --app (окно без вкладок и адресной строки).
const CHROME_PATHS = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ],
};

// Ширина экрана — чтобы прижать окно к правому верхнему углу.
function screenWidth() {
  return new Promise((resolve) => {
    if (process.platform === "darwin") {
      execFile(
        "osascript",
        ["-e", 'tell application "Finder" to get bounds of window of desktop'],
        (err, out) => {
          // Ответ вида "0, 0, 2560, 1440" → третье число — ширина.
          const w = err ? NaN : Number(out.split(",")[2]);
          resolve(Number.isFinite(w) ? w : null);
        }
      );
    } else if (process.platform === "linux") {
      execFile("sh", ["-c", "xdpyinfo | awk '/dimensions/{print $2}' | cut -dx -f1"], (err, out) => {
        const w = err ? NaN : Number(out.trim());
        resolve(Number.isFinite(w) ? w : null);
      });
    } else {
      resolve(null); // Windows: позицию не задаём, откроется по умолчанию
    }
  });
}

// Открывает окно-гаджет: без вкладок, размером с коробку, в правом верхнем
// углу — если найден Chromium-браузер. Иначе фолбэк на обычную вкладку.
async function openWindow(url) {
  const bin = (CHROME_PATHS[process.platform] || []).find((p) => existsSync(p));
  if (bin) {
    const sw = await screenWidth();
    // Отдельный профиль заставляет Chrome стартовать новым процессом — только
    // так флаги размера/позиции гарантированно применяются (окно, «усыновлённое»
    // уже запущенным Chrome, игнорирует их и наследует фулскрин).
    const profile = join(homedir(), ".gearbox", "chrome-profile");
    mkdirSync(profile, { recursive: true });
    const args = [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${WIN_W},${WIN_H}`,
    ];
    if (sw) args.push(`--window-position=${sw - WIN_W - MARGIN},${MARGIN}`);
    execFile(bin, args, () => {});
    return;
  }
  // Фолбэк: браузер по умолчанию, обычное окно.
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "cmd" :
    "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}

// Пробуем желаемый порт; если занят — шагаем вперёд по диапазону.
async function listenWithFallback(port, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await startServer({ port: port + i });
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`Нет свободного порта в диапазоне ${port}..${port + attempts - 1}`);
}

async function main() {
  const portArg = Number(process.argv[2]) || DEFAULT_PORT;

  if (!(await isAvailable())) {
    console.error("⚠️  tmux не найден. Сначала поставь его:  brew install tmux");
    console.error("    Затем запусти Claude Code внутри tmux и стартуй коробку заново.");
  }

  const { port } = await listenWithFallback(portArg);
  const url = `http://127.0.0.1:${port}`;

  console.log("");
  console.log("  🚗  Gearbox for Claude Code");
  console.log(`      ${url}`);
  console.log("      Запусти Claude Code внутри tmux, выбери его панель — и переключай.");
  console.log("      Ctrl+C — выход.");
  console.log("");

  if (!process.env.GEARBOX_NO_OPEN) await openWindow(url);
}

main().catch((e) => {
  console.error("Не удалось запустить gearbox:", e.message);
  process.exit(1);
});
