(() => {
  const $ = id => document.getElementById(id);
  const state = {
    ws: null,
    role: null,
    connected: false,
    submitted: false,
    room: "",
    canPlay: false,
    lastRoundKey: ""
  };
  const movesFa = { rock: "سنگ", paper: "کاغذ", scissors: "قیچی" };
  let toastTimer;

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function status(message, isError = false) {
    $("statusText").textContent = message;
    $("statusBox").classList.toggle("error", isError);
  }

  function setMovesDisabled(disabled) {
    document.querySelectorAll("[data-move]").forEach(button => {
      button.disabled = disabled;
    });
  }

  function showRoom(code) {
    $("roomCode").textContent = code;
    $("matchRoom").textContent = code;
    $("roomShare").hidden = false;
  }

  function randomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => chars[byte % chars.length]).join("");
  }

  function appendHistory(message, detail = "") {
    const list = $("historyList");
    const empty = list.querySelector(".empty");
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = "history-entry";
    const left = document.createElement("span");
    left.textContent = message;
    const right = document.createElement("b");
    right.textContent = detail;
    row.append(left, right);
    list.prepend(row);
  }

  function updateScores(scores = {}) {
    const first = Number(scores.host || 0);
    const second = Number(scores.guest || 0);
    $("score1").textContent = first;
    $("score2").textContent = second;
  }

  function resetLocalMatch() {
    state.submitted = false;
    state.lastRoundKey = "";
    updateScores({ host: 0, guest: 0 });
    $("historyList").innerHTML = '<p class="empty">هنوز دوری انجام نشده است.</p>';
  }

  function connect(code) {
    if (!/^[A-Z0-9]{5}$/.test(code)) {
      toast("کد اتاق باید ۵ حرف یا عدد باشد.");
      return;
    }
    if (state.ws) {
      try { state.ws.close(); } catch (_) {}
    }

    state.room = code;
    state.role = null;
    state.connected = false;
    state.submitted = false;
    state.canPlay = false;
    resetLocalMatch();
    showRoom(code);
    $("lobbyPanel").hidden = true;
    $("matchPanel").hidden = false;
    $("opponentState").textContent = "در انتظار ورود";
    status("در حال اتصال به اتاق " + code + " ...");
    setMovesDisabled(true);

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const url = `${scheme}://${location.host}/room/${encodeURIComponent(code)}`;
    try {
      state.ws = new WebSocket(url);
    } catch (_) {
      status("اتصال ساخته نشد. صفحه را دوباره بارگذاری کن.", true);
      return;
    }

    state.ws.addEventListener("open", () => {
      state.connected = true;
      status("اتصال برقرار شد؛ منتظر بازیکن دیگر هستیم.");
    });
    state.ws.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      handleMessage(message);
    });
    state.ws.addEventListener("error", () => {
      status("ارتباط با سرور برقرار نشد. کمی بعد دوباره تلاش کن.", true);
    });
    state.ws.addEventListener("close", () => {
      state.connected = false;
      state.submitted = false;
      state.canPlay = false;
      setMovesDisabled(true);
      if (!$("matchPanel").hidden) status("اتصال بسته شد. می‌توانی دوباره وارد اتاق شوی.", true);
    });
  }

  function handleMessage(message) {
    if (message.type === "joined") {
      state.role = message.role;
      updateScores(message.scores);
      status(state.role === "host" ? "اتاق ساخته شد؛ کد را برای دوستت بفرست." : "وارد اتاق شدی؛ منتظر Player 1 بمان.");
      return;
    }

    if (message.type === "role_changed") {
      state.role = message.role || state.role;
      status("اکنون نقش تو Player 1 است.");
      return;
    }

    if (message.type === "players" || message.type === "state") {
      updateScores(message.scores);
      const count = Array.isArray(message.players) ? message.players.length : (message.waiting ? 1 : 2);
      const ready = count === 2;
      $("opponentState").textContent = ready ? "متصل و آماده" : "در انتظار ورود";
      state.canPlay = ready && !message.gameOver;
      if (!ready) {
        status("منتظر ورود بازیکن دوم هستیم...");
        setMovesDisabled(true);
      } else if (message.gameOver) {
        status("مسابقه تمام شده؛ Player 1 می‌تواند مسابقه جدید را شروع کند.");
        setMovesDisabled(true);
      } else {
        status(state.submitted ? "انتخاب تو ثبت شد؛ منتظر حریف باش." : "هر دو بازیکن آماده‌اند؛ حرکتت را انتخاب کن.");
        setMovesDisabled(state.submitted);
      }
      return;
    }

    if (message.type === "move_received") {
      if (message.role === state.role) {
        state.submitted = true;
        setMovesDisabled(true);
        status("انتخابت ثبت شد؛ منتظر انتخاب حریف باش.");
      } else {
        status("حریف انتخابش را انجام داد؛ تو انتخاب کن.");
        setMovesDisabled(state.submitted || !state.canPlay);
      }
      return;
    }

    if (message.type === "round_result") {
      state.submitted = false;
      updateScores(message.scores);
      const key = `${message.round}:${message.hostMove}:${message.guestMove}`;
      if (key !== state.lastRoundKey) {
        state.lastRoundKey = key;
        const mine = state.role === "host" ? message.hostMove : message.guestMove;
        const theirs = state.role === "host" ? message.guestMove : message.hostMove;
        let result = "مساوی";
        if (message.winner !== "draw") result = message.winner === state.role ? "این دور را بردی" : "این دور را باختی";
        appendHistory(`دور ${message.round} · ${result}`, `${movesFa[mine]} / ${movesFa[theirs]}`);
      }
      if (message.gameOver) {
        const won = message.matchWinner === state.role;
        status(won ? "🏆 برنده مسابقه شدی!" : "مسابقه تمام شد؛ دفعه بعد جبران کن.");
        state.canPlay = false;
        setMovesDisabled(true);
      } else {
        state.canPlay = true;
        status("نتیجه ثبت شد؛ دور بعدی را انتخاب کن.");
        setMovesDisabled(false);
      }
      return;
    }

    if (message.type === "game_reset") {
      resetLocalMatch();
      state.canPlay = true;
      status("مسابقه جدید شروع شد؛ حرکتت را انتخاب کن.");
      setMovesDisabled(false);
      return;
    }

    if (message.type === "player_left") {
      state.submitted = false;
      state.canPlay = false;
      updateScores({ host: 0, guest: 0 });
      $("opponentState").textContent = "در انتظار ورود";
      status("حریف از اتاق خارج شد؛ منتظر بازیکن جدید هستیم.");
      setMovesDisabled(true);
      return;
    }

    if (message.type === "error") {
      status(message.message || "خطایی رخ داد.", true);
      if (message.message && message.message.includes("فقط Player 1")) setMovesDisabled(true);
    }
  }

  function sendMove(move) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.connected) {
      status("ابتدا به اتاق وصل شو.", true);
      return;
    }
    if (!state.canPlay || state.submitted) return;
    state.submitted = true;
    setMovesDisabled(true);
    status("انتخابت ثبت شد؛ منتظر حریف باش.");
    state.ws.send(JSON.stringify({ type: "move", move }));
  }

  async function copyCode() {
    if (!state.room) return;
    try {
      await navigator.clipboard.writeText(state.room);
      toast("کد اتاق کپی شد.");
    } catch (_) {
      toast("کد اتاق: " + state.room);
    }
  }

  function leaveRoom() {
    if (state.ws) {
      try { state.ws.close(); } catch (_) {}
    }
    state.ws = null;
    state.connected = false;
    state.role = null;
    state.room = "";
    state.canPlay = false;
    state.submitted = false;
    $("matchPanel").hidden = true;
    $("lobbyPanel").hidden = false;
    $("roomShare").hidden = true;
    $("roomInput").value = "";
    setMovesDisabled(true);
  }

  $("createBtn").addEventListener("click", () => {
    const code = randomCode();
    $("roomInput").value = code;
    connect(code);
  });
  $("joinBtn").addEventListener("click", () => {
    const code = $("roomInput").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    connect(code);
  });
  $("roomInput").addEventListener("input", event => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  });
  $("roomInput").addEventListener("keydown", event => {
    if (event.key === "Enter") $("joinBtn").click();
  });
  $("copyBtn").addEventListener("click", copyCode);
  $("copyMatchBtn").addEventListener("click", copyCode);
  $("leaveBtn").addEventListener("click", leaveRoom);
  $("resetBtn").addEventListener("click", () => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({ type: "reset" }));
  });
  document.querySelectorAll("[data-move]").forEach(button => {
    button.addEventListener("click", () => sendMove(button.dataset.move));
  });
  window.addEventListener("beforeunload", () => {
    try { state.ws?.close(); } catch (_) {}
  });
})();
