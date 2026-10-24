/**
 * Релей для чата: Стоит перед сайтом и просто передаёт трафик.
 * Интегрирован обход ограничений WebRTC (Voice/Video) через Xirsys TURN.
 *
 * Запуск локально:
 *   deno run --allow-net --allow-env main.ts
 * Переменные:
 *   ORIGIN  — куда проксировать (по умолчанию https://sosint.fun)
 *   PORT    — локальный порт (по умолчанию 8000)
 */

const ORIGIN = (Deno.env.get("ORIGIN") ?? "https://sosint.fun").replace(/\/$/, "");
const ORIGIN_HOST = new URL(ORIGIN).host;
const ORIGIN_WS = ORIGIN.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
const PORT = Number(Deno.env.get("PORT") ?? 8000);

// Заголовки, которые нельзя передавать дальше как есть.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding",
]);

function forwardHeaders(src: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of src) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    // accept-encoding не передаём: иначе Cloudflare отдаёт сжатое тело,
    // fetch его не распаковывает, а заголовок мы вырезаем — и браузер
    // получает бинарный мусор вместо страницы.
    if (key === "accept-encoding") continue;
    out.set(name, value);
  }
  out.set("host", ORIGIN_HOST);
  return out;
}

async function proxyHttp(req: Request, url: URL): Promise<Response> {
  const init: RequestInit = {
    method: req.method,
    headers: forwardHeaders(req.headers),
    redirect: "manual",
  };

  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    init.body = req.body;
    // Нужно для потоковой передачи тела в Deno.
    (init as RequestInit & { duplex?: string }).duplex = "half";
  }

  const upstream = await fetch(ORIGIN + url.pathname + url.search, init);

  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    headers.set(name, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function proxyWebSocket(req: Request, url: URL): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const upstream = new WebSocket(ORIGIN_WS + url.pathname + url.search);

  // Пока исходящее соединение не открылось, всё пришедшее от клиента копим.
  const pending: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = [];

  socket.onmessage = (event) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(event.data);
    } else {
      pending.push(event.data);
    }
  };

  upstream.onopen = () => {
    for (const item of pending) {
      try {
        upstream.send(item as string);
      } catch { /* соединение уже закрылось */ }
    }
    pending.length = 0;
  };

  upstream.onmessage = (event) => {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(event.data);
      } catch { /* клиент отвалился */ }
    }
  };

  const close = (code = 1000, reason = "closed") => {
    try { socket.close(code, reason); } catch { /* уже закрыт */ }
    try { upstream.close(); } catch { /* уже закрыт */ }
  };

  socket.onclose = () => close();
  upstream.onclose = () => close();
  upstream.onerror = () => close(1011, "upstream error");
  socket.onerror = () => close(1011, "client error");

  return response;
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);

  // === ИНТЕГРАЦИЯ XIRSYS TURN ДЛЯ ГОЛОСА ===
  if (url.pathname === "/api/ice") {
    // Обработка Preflight CORS-запросов браузера
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const ident = "affaff";
    const secret = "ad5839b2-cfc8-11f1-91c7-4037728939b8";
    const channel = "channel0e399448";

    try {
      const response = await fetch(`https://xirsys.net{channel}`, {
        method: "PUT",
        headers: {
          "Authorization": "Basic " + btoa(`${ident}:${secret}`),
          "Content-Type": "application/json",
        },
      });
      const data = await response.json();

      return new Response(JSON.stringify({ iceServers: data.v.iceServers }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  }
  // === КОНЕЦ ИНТЕГРАЦИИ XIRSYS ===

  const upgrade = req.headers.get("upgrade")?.toLowerCase();

  if (upgrade === "websocket") {
    return proxyWebSocket(req, url);
  }

  return proxyHttp(req, url).catch((error) =>
    new Response("upstream error: " + (error instanceof Error ? error.message : String(error)), {
      status: 502,
    })
  );
});

console.log(`релей запущен на порту ${PORT}, цель ${ORIGIN}`);
