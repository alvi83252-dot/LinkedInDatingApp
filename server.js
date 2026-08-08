const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3456;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const users = new Map(); // userId -> { id, name, headline, photo, res }

function send(res, status, body, headers) {
  res.writeHead(status, headers || { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}
function sendJson(res, obj, status) {
  send(res, status || 200, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function broadcast(msg) {
  const line = `event: msg\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const u of users.values()) {
    try { u.res.write(line); } catch (e) {}
  }
}

function broadcastUsers() {
  broadcast({
    type: "users",
    users: [...users.values()].map((u) => ({ id: u.id, name: u.name, headline: u.headline, photo: u.photo })),
  });
}

function handleEvents(req, res, url) {
  const userId = url.searchParams.get("user");
  const name = url.searchParams.get("name") || "Guest";
  const headline = url.searchParams.get("headline") || "Online now";
  const photo = url.searchParams.get("photo") || "";
  if (!userId) return send(res, 400, "Missing user");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const prev = users.get(userId);
  if (prev) { try { prev.res.end(); } catch (e) {} }

  const user = { id: userId, name, headline, photo, res };
  users.set(userId, user);

  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (e) {}
  }, 25000);

  broadcastUsers();

  req.on("close", () => {
    clearInterval(ping);
    if (users.get(userId) === user) {
      users.delete(userId);
      broadcastUsers();
    }
  });
}

async function handlePush(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch (e) {
    return sendJson(res, { ok: false, error: "bad json" }, 400);
  }
  const type = body.type;
  const me = body.me;

  if (type === "hello" && me) {
    const u = users.get(me.id);
    if (u) {
      if (me.name) u.name = me.name;
      if (me.headline) u.headline = me.headline;
      if (me.photo != null) u.photo = me.photo;
      broadcastUsers();
    }
    return sendJson(res, { ok: true });
  }

  const fromUser = me && users.get(me.id);
  const from = fromUser ? fromUser.name : (body.from || "Someone");

  if (type === "chat") {
    const target = users.get(body.to);
    if (!target) return sendJson(res, { ok: false, error: "offline" });
    const msg = {
      type: "chat",
      from,
      fromId: fromUser ? fromUser.id : body.from,
      to: body.to,
      text: body.text,
      time: body.time || new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    };
    try { target.res.write(`event: msg\ndata: ${JSON.stringify(msg)}\n\n`); } catch (e) {}
    return sendJson(res, { ok: true });
  }

  if (type === "signal") {
    const target = users.get(body.to);
    if (!target) return sendJson(res, { ok: false, error: "offline" });
    const msg = { type: "signal", from: fromUser ? fromUser.id : body.from, data: body.data };
    try { target.res.write(`event: msg\ndata: ${JSON.stringify(msg)}\n\n`); } catch (e) {}
    return sendJson(res, { ok: true });
  }

  return sendJson(res, { ok: true });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) return send(res, 403, "Forbidden");
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, { "Content-Type": MIME[ext] || "application/octet-stream" });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/events") return handleEvents(req, res, url);
    if (req.method === "POST" && url.pathname === "/api/push") return await handlePush(req, res);
    if (url.pathname === "/api/health") return sendJson(res, { ok: true });
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    send(res, 500, "Internal error");
  }
});

server.listen(PORT, () => {
  console.log("DateIn running at http://localhost:" + PORT);
});
