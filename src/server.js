// Крошечный HTTP-сервер без зависимостей. Раздаёт UI коробки и отвечает на
// четыре запроса: карта передач, список tmux-панелей, автодетект моделей из
// живого пикера и переключение. Слушает только 127.0.0.1 — наружу не торчит.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { isAvailable, listPanes, shiftModel, detectModels } from "./tmux.js";
import { loadGears } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy(); // защита от флуда
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  // Защита от path traversal: путь обязан остаться внутри PUBLIC_DIR.
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const data = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function handleApi(req, res, url) {
  // GET /api/config — карта передач (дефолты или gearbox.config.json)
  if (url.pathname === "/api/config" && req.method === "GET") {
    try {
      return sendJson(res, 200, await loadGears());
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // GET /api/panes — все tmux-панели (кандидаты в «трансмиссию»)
  if (url.pathname === "/api/panes" && req.method === "GET") {
    if (!(await isAvailable())) {
      return sendJson(res, 200, { tmux: false, panes: [] });
    }
    try {
      return sendJson(res, 200, { tmux: true, panes: await listPanes() });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // GET /api/models?pane=%N — прочитать живой пикер /model из панели
  // (открывает пикер, снимает экран, закрывает Escape'ом)
  if (url.pathname === "/api/models" && req.method === "GET") {
    try {
      const pane = url.searchParams.get("pane");
      if (!pane) return sendJson(res, 400, { error: "нужен параметр pane" });
      return sendJson(res, 200, { models: await detectModels(pane) });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // POST /api/shift {pane, model} — воткнуть передачу
  if (url.pathname === "/api/shift" && req.method === "POST") {
    try {
      const { pane, model } = await readBody(req);
      if (!pane || !model) return sendJson(res, 400, { error: "нужны pane и model" });
      await shiftModel(pane, model);
      return sendJson(res, 200, { ok: true, pane, model });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  return sendJson(res, 404, { error: "неизвестный эндпоинт" });
}

export function createGearboxServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    return serveStatic(res, url.pathname);
  });
}

export function startServer({ port = 4321, host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const server = createGearboxServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, port, host }));
  });
}
