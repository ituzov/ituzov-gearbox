// Карта передач живёт здесь, чтобы её можно было менять, не трогая код UI.
// Положи `gearbox.config.json` рядом с местом запуска команды (форма та же,
// что у DEFAULT_GEARS, обёрнутых в {"gears": [...]}) — и передачи твои.
//
// Обычно UI сам считывает модели из живого пикера `/model`, а этот набор —
// запасной. Поле model = то, что печатается после `/model `. Порядок как
// тяга в машине: первая передача — самая лёгкая модель, высшая — топ:
//
//     1   3   5
//     |   |   |        1 Haiku  · 3 Opus    · 5 Fable
//     +---N---+        2 Sonnet · 4 Opus 4.8·1M · N Default
//     |   |
//     2   4
//
// col: 0..2 (колонка кулисы), null = середина рейки; row: 0=верх 1=рейка 2=низ

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_GEARS = [
  { pos: "1", col: 0, row: 0, model: "haiku",   name: "Haiku 4.5", desc: "fastest, quick answers" },
  { pos: "2", col: 0, row: 2, model: "sonnet",  name: "Sonnet 5",  desc: "efficient, routine tasks" },
  { pos: "3", col: 1, row: 0, model: "opus",    name: "Opus 4.8",  desc: "everyday, complex tasks" },
  { pos: "4", col: 1, row: 2, model: "default", name: "Opus 4.8 · 1M", desc: "recommended default" },
  { pos: "5", col: 2, row: 0, model: "fable",   name: "Fable 5",   desc: "most capable, hardest tasks" },
  { pos: "N", col: null, row: 1, model: "default", name: "Default ★", desc: "back to default" },
];

// Возвращает { gears, custom }: custom=true, если юзер положил свой конфиг —
// тогда UI не перетирает его автодетектом моделей.
export async function loadGears(cwd = process.cwd()) {
  try {
    const raw = await readFile(join(cwd, "gearbox.config.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.gears) && parsed.gears.length) {
      return { gears: parsed.gears, custom: true };
    }
  } catch {
    // файла нет или он битый → едем на дефолтах
  }
  return { gears: DEFAULT_GEARS, custom: false };
}
