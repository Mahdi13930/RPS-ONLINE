import { DurableObject } from "cloudflare:workers";

const ROOM_RE = /^[A-Z0-9]{5}$/;
const MOVES = new Set(["rock", "paper", "scissors"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function getWinner(player1Move, player2Move) {
  if (player1Move === player2Move) return "draw";
  const player1Wins =
    (player1Move === "rock" && player2Move === "scissors") ||
    (player1Move === "paper" && player2Move === "rock") ||
    (player1Move === "scissors" && player2Move === "paper");
  return player1Wins ? "host" : "guest";
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.sessions = new Map();
    this.moves = new Map();
    this.scores = { host: 0, guest: 0 };
    this.round = 0;
    this.gameOver = false;
    this.loaded = false;
    this.finishingRound = false;
  }

  async load() {
    if (this.loaded) return;
    const saved = await this.ctx.storage.get("match");
    if (saved && typeof saved === "object") {
      this.scores = saved.scores || { host: 0, guest: 0 };
      this.round = Number(saved.round || 0);
      this.gameOver = Boolean(saved.gameOver);
    }
    this.loaded = true;
  }

  async persist() {
    await this.ctx.storage.put("match", {
      scores: this.scores,
      round: this.round,
      gameOver: this.gameOver
    });
  }

  players() {
    return [...this.sessions.values()].map(player => ({
      role: player.role,
      name: player.role === "host" ? "Player 1" : "Player 2"
    }));
  }

  send(ws, message) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    } catch (_) {}
  }

  broadcast(message) {
    for (const ws of this.sessions.keys()) this.send(ws, message);
  }

  state() {
    return {
      type: "state",
      players: this.players(),
      scores: this.scores,
      round: this.round,
      gameOver: this.gameOver,
      waiting: this.sessions.size < 2,
      movesSubmitted: {
        host: this.moves.has("host"),
        guest: this.moves.has("guest")
      }
    };
  }

  async fetch(request) {
    await this.load();
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ ok: true, service: "RPS Arena Online 4" });
    }

    const url = new URL(request.url);
    const code = String(url.pathname.split("/").filter(Boolean)[1] || "").toUpperCase();
    if (!ROOM_RE.test(code)) return new Response("Invalid room code", { status: 400 });
    if (this.sessions.size >= 2) return json({ ok: false, error: "room_full" }, 409);

    const role = this.sessions.size === 0 ? "host" : "guest";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    this.sessions.set(server, { role });
    server.addEventListener("message", event => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));

    this.send(server, {
      type: "joined",
      role,
      room: code,
      name: role === "host" ? "Player 1" : "Player 2",
      players: this.players(),
      scores: this.scores,
      round: this.round
    });
    this.broadcast({ type: "players", players: this.players(), ready: this.sessions.size === 2 });
    this.broadcast(this.state());

    return new Response(null, { status: 101, webSocket: client });
  }

  async onClose(ws) {
    const player = this.sessions.get(ws);
    if (!player) return;
    this.sessions.delete(ws);
    this.moves.clear();

    // A fresh opponent starts a fresh match; no player accounts or rankings exist.
    this.scores = { host: 0, guest: 0 };
    this.round = 0;
    this.gameOver = false;

    if (player.role === "host" && this.sessions.size === 1) {
      const remaining = [...this.sessions.entries()][0];
      remaining[1].role = "host";
      this.send(remaining[0], { type: "role_changed", role: "host", name: "Player 1" });
    }

    await this.persist();
    this.broadcast({ type: "player_left", players: this.players() });
    this.broadcast(this.state());
  }

  async onMessage(ws, raw) {
    await this.load();
    const player = this.sessions.get(ws);
    if (!player) return;

    let message;
    try {
      message = JSON.parse(String(raw));
    } catch (_) {
      this.send(ws, { type: "error", message: "پیام نامعتبر است." });
      return;
    }

    if (message.type === "ping") {
      this.send(ws, { type: "pong", serverTime: Date.now() });
      return;
    }
    if (message.type === "state") {
      this.send(ws, this.state());
      return;
    }
    if (message.type === "reset") {
      if (player.role !== "host") {
        this.send(ws, { type: "error", message: "فقط Player 1 می‌تواند مسابقه را از نو شروع کند." });
        return;
      }
      this.moves.clear();
      this.scores = { host: 0, guest: 0 };
      this.round = 0;
      this.gameOver = false;
      await this.persist();
      this.broadcast({ type: "game_reset", scores: this.scores, round: 0, gameOver: false });
      this.broadcast(this.state());
      return;
    }
    if (message.type !== "move") return;

    const move = String(message.move || "").toLowerCase();
    if (!MOVES.has(move)) {
      this.send(ws, { type: "error", message: "حرکت انتخاب‌شده معتبر نیست." });
      return;
    }
    if (this.sessions.size < 2) {
      this.send(ws, { type: "error", message: "منتظر ورود Player 2 بمان." });
      return;
    }
    if (this.gameOver) {
      this.send(ws, { type: "error", message: "مسابقه تمام شده؛ Player 1 باید مسابقه جدید را شروع کند." });
      return;
    }
    if (this.moves.has(player.role)) {
      this.send(ws, { type: "error", message: "انتخاب این دور قبلاً ثبت شده است." });
      return;
    }

    this.moves.set(player.role, move);
    this.broadcast({
      type: "move_received",
      role: player.role,
      movesSubmitted: { host: this.moves.has("host"), guest: this.moves.has("guest") }
    });
    if (this.moves.has("host") && this.moves.has("guest")) await this.finishRound();
  }

  async finishRound() {
    if (this.finishingRound) return;
    this.finishingRound = true;
    try {
      const player1Move = this.moves.get("host");
      const player2Move = this.moves.get("guest");
      if (!player1Move || !player2Move) return;

      const roundWinner = getWinner(player1Move, player2Move);
      if (roundWinner === "host") this.scores.host++;
      if (roundWinner === "guest") this.scores.guest++;
      this.round++;
      this.gameOver = this.scores.host >= 3 || this.scores.guest >= 3;

      this.broadcast({
        type: "round_result",
        round: this.round,
        hostMove: player1Move,
        guestMove: player2Move,
        winner: roundWinner,
        scores: this.scores,
        gameOver: this.gameOver,
        matchWinner: this.scores.host >= 3 ? "host" : this.scores.guest >= 3 ? "guest" : null
      });

      this.moves.clear();
      await this.persist();
      this.broadcast(this.state());
    } finally {
      this.finishingRound = false;
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "RPS Arena Online 4", status: "healthy" });
    }
    if (url.pathname.startsWith("/room/")) {
      const code = String(url.pathname.split("/").filter(Boolean)[1] || "").toUpperCase();
      if (!ROOM_RE.test(code)) return new Response("Invalid room code", { status: 400 });
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
