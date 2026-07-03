// Тонкая обёртка над tmux CLI. Это ЕДИНСТВЕННОЕ место, которое трогает твой
// терминал — прочитал этот файл и точно знаешь, что умеет приложение:
// перечислить панели и «напечатать» команду `/model ...` в выбранную. Всё.

import { execFile } from "node:child_process";

const FIELD = "\x1f"; // unit separator — безопасный разделитель, в полях не встречается

function run(args) {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout);
    });
  });
}

// Установлен ли tmux вообще?
export async function isAvailable() {
  try {
    await run(["-V"]);
    return true;
  } catch {
    return false;
  }
}

// Список всех панелей во всех сессиях. Панели, похожие на Claude Code,
// помечаем — UI предвыберет подходящую цель сам.
export async function listPanes() {
  const fmt = [
    "#{pane_id}",
    "#{session_name}",
    "#{window_index}",
    "#{pane_index}",
    "#{pane_current_command}",
    "#{pane_title}",
  ].join(FIELD);

  let out;
  try {
    out = await run(["list-panes", "-a", "-F", fmt]);
  } catch (e) {
    // Сервер tmux ещё не запущен → панелей нет, но это не ошибка.
    if (/no server running|no current client/i.test(e.message)) return [];
    throw e;
  }

  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, session, win, pane, command, title] = line.split(FIELD);
      const looksLikeClaude = /claude|node/i.test(command) || /claude/i.test(title || "");
      return {
        id, // например "%3" — стабильный адрес, переживает перенумерацию окон
        session,
        label: `${session}:${win}.${pane}`,
        command,
        title: title || "",
        looksLikeClaude,
      };
    });
}

// Ради чего всё затевалось: напечатать `/model <model>` + Enter в панель.
export async function shiftModel(paneId, model) {
  if (!/^%\d+$/.test(paneId)) throw new Error(`Некорректный id панели: ${paneId}`);
  if (!/^[a-z0-9._-]+$/i.test(model)) throw new Error(`Некорректное имя модели: ${model}`);
  // send-keys печатает строку буквально, затем — отдельное нажатие Enter.
  await run(["send-keys", "-t", paneId, `/model ${model}`, "Enter"]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Автодетект моделей: открываем пикер `/model` в панели, снимаем текст экрана,
// парсим список и закрываем пикер Escape'ом. Никакого API — читаем то, что
// реально видит пользователь.
export async function detectModels(paneId) {
  if (!/^%\d+$/.test(paneId)) throw new Error(`Некорректный id панели: ${paneId}`);

  // Панель занята (Claude генерит)? Тогда не лезем — Escape прервал бы ответ.
  const before = await run(["capture-pane", "-t", paneId, "-p"]);
  if (/esc to interrupt/i.test(before)) {
    throw new Error("панель занята — Claude сейчас отвечает");
  }

  // Esc заранее очищает недопечатанный ввод/открытые меню, чтобы «/model»
  // не приклеился к чужому тексту и Enter не отправил его как промпт.
  await run(["send-keys", "-t", paneId, "Escape"]);
  await sleep(150);
  await run(["send-keys", "-t", paneId, "/model", "Enter"]);
  await sleep(1200); // пикеру нужно время отрисоваться

  const screen = await run(["capture-pane", "-t", paneId, "-p"]);
  await run(["send-keys", "-t", paneId, "Escape"]); // закрываем пикер в любом случае

  if (!/select model/i.test(screen)) {
    throw new Error("пикер моделей не открылся (не та панель или старая версия CLI?)");
  }

  // Строки вида: «  ❯ 3. Fable ✔     Fable 5 · Most capable...»
  const models = [];
  for (const line of screen.split("\n")) {
    const m = line.match(/^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s{2,}(.+?)\s*$/);
    if (!m) continue;
    models.push({
      index: Number(m[1]),
      alias: m[2].replace(/\s*✔\s*$/, "").trim(), // «Fable ✔» → «Fable»
      desc: m[3].trim(),                           // «Fable 5 · Most capable...»
      current: /✔/.test(m[2]),
    });
  }
  if (!models.length) throw new Error("не удалось распарсить список моделей");
  return models;
}
