(function () {
  "use strict";

  const LS_KEY = "datein_state_v2";
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let state = loadState();
  let currentTop = 0;
  let dragging = null;

  // ---------- State ----------
  function loadState() {
    let st = null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) st = JSON.parse(raw);
    } catch (e) {}
    if (!st) return initialState();
    // Always sync candidates with the latest SEED_DATA so profile edits show up.
    st.candidates = SEED_DATA.candidates.map((c) => ({ ...c }));
    const fresh = new Set(st.candidates.map((c) => c.id));
    Object.keys(st.seen || {}).forEach((id) => { if (!fresh.has(id)) delete st.seen[id]; });
    st.matches = (st.matches || []).filter((id) => fresh.has(id));
    st.pendingLikes = (st.pendingLikes || []).filter((id) => fresh.has(id));
    Object.keys(st.convos || {}).forEach((id) => { if (!fresh.has(id)) delete st.convos[id]; });
    Object.keys(st.read || {}).forEach((id) => { if (!fresh.has(id)) delete st.read[id]; });
    st.seen = st.seen || {};
    st.convos = st.convos || {};
    st.read = st.read || {};
    st.lastChat = st.lastChat || {};
    return st;
  }

  function initialState() {
    const candidates = SEED_DATA.candidates.map((c) => ({ ...c }));
    const seen = {};
    candidates.forEach((c) => {
      if (c.id === "p1" || c.id === "p2") seen[c.id] = "like"; // starter matches
    });
    const matches = ["p1", "p2"];
    const convos = {};
    Object.keys(SEED_DATA.convos).forEach((id) => {
      convos[id] = SEED_DATA.convos[id].map((m) => ({ ...m }));
    });
    const read = { p1: true, p2: true };
    return {
      me: { ...SEED_DATA.me },
      candidates,
      seen,
      matches,
      pendingLikes: [...SEED_DATA.pendingLikes],
      convos,
      read,
      lastChat: {},
      started: true,
    };
  }

  function save() {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }

  // ---------- Helpers ----------
  function initials(name) {
    return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  }

  function pct(person) {
    const me = state.me;
    let matches = 0;
    const skillSet = new Set(person.skills.map((s) => s.toLowerCase()));
    const interestSet = new Set(person.interests.map((i) => i.toLowerCase()));
    me.skills.forEach((s) => skillSet.has(s.toLowerCase()) && matches++);
    me.interests.forEach((i) => interestSet.has(i.toLowerCase()) && matches++);
    const base = 62 + matches * 6;
    return Math.min(98, base + (person.verified ? 4 : 0));
  }

  function candidateById(id) {
    if (id && id.startsWith("live:")) {
      const u = RT.online.get(id.slice(5));
      if (u) return buildOnlineCandidate(u);
    }
    const found = state.candidates.find((c) => c.id === id);
    if (found && onlineForCandidate(found)) return { ...found, online: true };
    return found;
  }

  function getUnreadCount() {
    return state.matches.reduce((n, id) => n + (state.read[id] ? 0 : 1), 0);
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.add("hidden"), 2600);
  }

  function avatarEl(person, size) {
    const el = document.createElement("div");
    el.className = "avatar";
    if (person.photo) {
      el.classList.add("has-photo");
      const img = document.createElement("img");
      img.src = person.photo;
      img.alt = "";
      img.loading = "lazy";
      el.appendChild(img);
    } else {
      el.style.background = `linear-gradient(135deg, ${person.colors[0]}, ${person.colors[1]})`;
      el.textContent = initials(person.name);
    }
    if (size) {
      el.style.width = size + "px";
      el.style.height = size + "px";
      el.style.fontSize = size / 2.8 + "px";
    }
    return el;
  }

  // ---------- Navigation ----------
  function switchView(view) {
    $$(".view").forEach((v) => v.classList.remove("active"));
    $("#view-" + view).classList.add("active");
    $$(".nav-link").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    if (view === "matches") renderMatches();
    if (view === "messages") renderConvs();
    if (view === "profile") renderMyProfile();
  }

  $$(".nav-link").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  $(".brand").addEventListener("click", () => switchView("discover"));
  $("#navSearch").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase().trim();
    renderStack(q);
  });

  // ---------- Discover stack ----------
  function availableCandidates() {
    const base = state.candidates
      .filter((c) => !state.seen[c.id])
      .map((c) => {
        const twin = onlineForCandidate(c);
        return twin ? { ...c, online: true, liveId: "live:" + twin.id } : c;
      })
      .sort((a, b) => ((b.featured ? 1 : 0) - (a.featured ? 1 : 0)) || 0);
    const usedLiveIds = new Set(base.filter((c) => c.liveId).map((c) => c.liveId));
    const usedNames = new Set(base.map((c) => c.name.trim().toLowerCase()));
    const liveExtras = [...RT.online.values()]
      .filter((u) => !usedLiveIds.has("live:" + u.id))
      .filter((u) => !usedNames.has(u.name.trim().toLowerCase()))
      .filter((u) => !state.seen["live:" + u.id])
      .map((u) => buildOnlineCandidate(u));
    return [...liveExtras, ...base];
  }

  function renderStack(filter) {
    const container = $("#cardStack");
    container.innerHTML = "";
    const list = availableCandidates().filter((c) => {
      if (!filter) return true;
      const blob = [c.name, c.headline, c.location, ...c.skills, ...c.interests].join(" ").toLowerCase();
      return blob.includes(filter);
    });
    currentTop = list.length ? list[0].id : null;

    if (!list.length) {
      $("#discoverEmpty").classList.remove("hidden");
      $("#stackOverlay").classList.add("hidden");
      return;
    }
    $("#discoverEmpty").classList.add("hidden");
    const overlay = $("#stackOverlay");
    overlay.className = "stack-overlay";
    overlay.style.opacity = 0;

    const showCount = Math.min(3, list.length);
    for (let i = showCount - 1; i >= 0; i--) {
      const card = buildCard(list[i], i);
      container.appendChild(card);
    }
    attachDrag(container.lastElementChild);
    renderCompat(list.slice(0, 6));
  }

  function topCard() {
    const cards = $$("#cardStack .profile-card");
    return cards[cards.length - 1] || null;
  }

  function buildCard(person, offset) {
    const card = document.createElement("div");
    card.className = "profile-card";
    card.dataset.id = person.id;
    if (offset > 0) {
      card.style.transform = `scale(${1 - offset * 0.05}) translateY(${offset * 14}px)`;
      card.style.zIndex = 10 - offset;
    } else {
      card.style.zIndex = 20;
    }

    const photo = document.createElement("div");
    photo.className = "profile-photo";
    photo.style.background = `linear-gradient(135deg, ${person.colors[0]}, ${person.colors[1]})`;
    const pattern = document.createElement("div");
    pattern.className = "cover-pattern";
    photo.appendChild(pattern);
    const av = avatarEl(person, 128);
    av.style.border = "4px solid #fff";
    photo.appendChild(av);

    const body = document.createElement("div");
    body.className = "profile-body";

    const pill = document.createElement("div");
    pill.className = "match-pill" + (person.online ? " online" : "");
    pill.textContent = person.online ? "● Online now" : person.verified ? "✓ Verified professional" : "Professional profile";
    body.appendChild(pill);

    const name = document.createElement("h2");
    name.textContent = person.name + ", " + person.age;
    body.appendChild(name);

    const hl = document.createElement("p");
    hl.className = "headline";
    hl.textContent = person.headline;
    body.appendChild(hl);

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = person.location + " · " + person.height;
    body.appendChild(meta);

    const tags = document.createElement("div");
    tags.className = "tags";
    person.skills.forEach((s) => {
      const t = document.createElement("span");
      t.className = "tag";
      t.innerHTML = `${s} <span class="plus" title="Endorse">+</span>`;
      t.querySelector(".plus").addEventListener("click", (e) => {
        e.stopPropagation();
        toast("Endorsement sent to " + person.name.split(" ")[0]);
      });
      tags.appendChild(t);
    });
    body.appendChild(tags);

    const conn = document.createElement("div");
    conn.className = "connections";
    if (person.mutual.length) {
      conn.appendChild(document.createTextNode("Mutual connections: "));
      person.mutual.forEach((m, i) => {
        const mini = document.createElement("span");
        mini.className = "mini";
        mini.style.background = ["#0a66c2", "#07a3c2", "#9a3b3b"][i % 3];
        mini.textContent = initials(m);
        conn.appendChild(mini);
      });
      conn.appendChild(document.createTextNode(person.mutual.join(", ")));
    } else {
      conn.textContent = "No mutual connections yet";
    }
    body.appendChild(conn);

    card.appendChild(photo);
    card.appendChild(body);
    return card;
  }

  function renderCompat(list) {
    const box = $("#compatList");
    box.innerHTML = "";
    list.forEach((p) => {
      const item = document.createElement("div");
      item.className = "compat-item";
      const av = avatarEl(p, 40);
      const info = document.createElement("div");
      info.className = "info";
      const n = document.createElement("div");
      n.className = "name";
      n.textContent = p.name;
      const s = document.createElement("div");
      s.className = "score";
      s.textContent = "Shared skills & interests";
      info.appendChild(n);
      info.appendChild(s);
      const score = document.createElement("div");
      score.className = "pct";
      score.textContent = pct(p) + "% match";
      item.append(av, info, score);
      item.addEventListener("click", () => showDetailModal(p));
      box.appendChild(item);
    });
  }

  // ---------- Drag / swipe ----------
  function attachDrag(card) {
    if (!card) return;
    card.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".plus")) return;
      dragging = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
      card.classList.add("dragging");
      card.setPointerCapture(e.pointerId);
    });
    card.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      dragging.dx = e.clientX - dragging.x;
      dragging.dy = e.clientY - dragging.y;
      const rot = (dragging.dx / 14) * 0.5;
      card.style.transform = `translate(${dragging.dx}px, ${dragging.dy}px) rotate(${rot}deg)`;
      const overlay = $("#stackOverlay");
      overlay.classList.remove("hidden");
      if (dragging.dx > 40) {
        overlay.textContent = "Like";
        overlay.className = "stack-overlay like";
        overlay.style.opacity = Math.min(1, (dragging.dx - 40) / 60);
      } else if (dragging.dx < -40) {
        overlay.textContent = "Pass";
        overlay.className = "stack-overlay pass";
        overlay.style.opacity = Math.min(1, (-dragging.dx - 40) / 60);
      } else {
        overlay.className = "stack-overlay";
        overlay.style.opacity = 0;
      }
    });
    card.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      card.classList.remove("dragging");
      const d = dragging;
      dragging = null;
      const overlay = $("#stackOverlay");
      overlay.style.opacity = 0;
      if (d.dx > 80) settle(e.pointerId, card, "like");
      else if (d.dx < -80) settle(e.pointerId, card, "pass");
      else card.style.transform = "";
    });
    card.addEventListener("pointercancel", () => {
      if (!dragging) return;
      dragging = null;
      card.classList.remove("dragging");
      card.style.transform = "";
    });
  }

  function settle(pid, card, dir) {
    let cls = dir === "like" ? "leaving-right" : dir === "super" ? "leaving-up" : "leaving-left";
    if (dir === "super") cls = "leaving-up";
    card.classList.add(cls);
    setTimeout(() => {
      handleDecision(card.dataset.id, dir);
      renderStack($("#navSearch").value);
    }, 260);
  }

  // ---------- Decisions ----------
  function handleDecision(id, dir) {
    if (dir === "pass") {
      state.seen[id] = "pass";
      save();
      return;
    }
    const person = candidateById(id);
    const online = !!(person && person.online);
    state.seen[id] = "like";
    const matchesNow = online || state.pendingLikes.indexOf(id) !== -1 || Math.random() < 0.45;
    if (matchesNow) {
      state.matches.push(id);
      if (!state.convos[id]) state.convos[id] = online ? [] : [{ from: "them", text: "We matched! Tell me what you're working on these days." }];
      state.read[id] = false;
      save();
      renderAll();
      showMatchModal(id);
    } else {
      state.pendingLikes.push(id);
      save();
      toast(`You liked ${candidateById(id).name.split(" ")[0]}. Waiting for a mutual like.`);
    }
  }

  function showMatchModal(id) {
    const person = candidateById(id);
    const me = state.me;
    const overlay = document.createElement("div");
    overlay.className = "match-modal-overlay";
    overlay.innerHTML = `
      <div class="match-modal">
        <div class="avatars"></div>
        <h2>It's a match!</h2>
        <p>You and ${person.name} mutually liked each other.</p>
        <div class="actions">
          <button class="btn-primary" data-act="chat">Send a message</button>
          <button class="btn-ghost" data-act="close">Keep browsing</button>
        </div>
      </div>`;
    const avs = overlay.querySelector(".avatars");
    const a1 = avatarEl(me, 84);
    if (!me.photo) a1.textContent = "Y";
    const a2 = avatarEl(person, 84);
    avs.append(a1, a2);
    overlay.querySelector('[data-act="chat"]').addEventListener("click", () => {
      overlay.remove();
      switchView("messages");
      openChat(person.id);
    });
    overlay.querySelector('[data-act="close"]').addEventListener("click", () => overlay.remove());
    document.body.appendChild(overlay);
  }

  // ---------- Detail modal ----------
  function showDetailModal(person) {
    const overlay = document.createElement("div");
    overlay.className = "match-modal-overlay";
    const card = buildCard(person, 0);
    card.style.position = "static";
    card.style.width = "400px";
    card.style.maxWidth = "92vw";
    card.style.cursor = "default";
    card.style.pointerEvents = "auto";
    const body = card.querySelector(".profile-body");
    const pitch = document.createElement("p");
    pitch.className = "headline";
    pitch.style.marginTop = "12px";
    pitch.style.fontStyle = "italic";
    pitch.textContent = '"' + person.pitch + '"';
    body.appendChild(pitch);
    const btn = document.createElement("div");
    btn.className = "actions";
    btn.style.justifyContent = "center";
    btn.innerHTML = `<button class="btn-primary">Close</button>`;
    btn.querySelector("button").addEventListener("click", () => overlay.remove());
    overlay.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.style.padding = "20px";
    wrap.appendChild(card);
    wrap.appendChild(btn);
    overlay.appendChild(wrap);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // ---------- Matches ----------
  function renderMatches() {
    const grid = $("#matchesGrid");
    grid.innerHTML = "";
    if (!state.matches.length) {
      grid.innerHTML = `<div class="empty-state"><h2>No matches yet</h2><p>Keep liking profiles — your future coworker-crush is out there.</p></div>`;
      return;
    }
    state.matches.forEach((id) => {
      const p = candidateById(id);
      const card = document.createElement("div");
      card.className = "match-card";
      const av = avatarEl(p, 72);
      card.appendChild(av);
      const name = document.createElement("h3");
      name.textContent = p.name;
      card.appendChild(name);
      const hl = document.createElement("div");
      hl.className = "headline";
      hl.textContent = p.headline;
      card.appendChild(hl);
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span><b>${pct(p)}%</b> compatible</span><span>${p.mutual.length} mutual</span>`;
      card.appendChild(row);
      card.addEventListener("click", () => { switchView("messages"); openChat(id); });
      grid.appendChild(card);
    });
  }

  // ---------- Messages ----------
  function renderConvs() {
    const list = $("#convList");
    list.innerHTML = "";
    const ids = [...state.matches].sort((a, b) => (state.lastChat[b] || 0) - (state.lastChat[a] || 0));
    ids.forEach((id) => {
      const p = candidateById(id);
      const item = document.createElement("div");
      item.className = "conv-item";
      const conv = state.convos[id] || [];
      const last = conv[conv.length - 1];
      const av = avatarEl(p, 44);
      const info = document.createElement("div");
      info.className = "info";
      const n = document.createElement("div");
      n.className = "name";
      n.textContent = p.name;
      const preview = document.createElement("div");
      preview.className = "preview";
      preview.textContent = last ? (last.from === "me" ? "You: " : "") + last.text : "Say hello!";
      info.append(n, preview);
      item.append(av, info);
      if (!state.read[id]) {
        const badge = document.createElement("span");
        badge.className = "unread";
        badge.textContent = "1";
        item.appendChild(badge);
      }
      item.addEventListener("click", () => openChat(id));
      list.appendChild(item);
    });
  }

  let activeChat = null;
  function currentChatId() { return activeChat; }

  function openChat(id) {
    activeChat = id;
    const p = candidateById(id);
    const conv = state.convos[id] || [];
    state.read[id] = true;
    save();
    renderAll();

    $("#chatPlaceholder").classList.add("hidden");
    $("#chatWindow").classList.remove("hidden");

    const header = $("#chatHeader");
    header.innerHTML = "";
    const av = avatarEl(p, 40);
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = p.name;
    const status = document.createElement("div");
    status.className = "status";
    const online = !!chatTargetId(id) && !!RT.online.get(chatTargetId(id));
    status.textContent = (online ? "Online · " : "Offline · ") + p.headline;
    status.classList.toggle("live", online);
    info.append(name, status);

    const actions = document.createElement("div");
    actions.className = "chat-header-actions";
    const btnAudio = document.createElement("button");
    btnAudio.className = "chat-call-btn";
    btnAudio.textContent = "Call";
    btnAudio.title = "Voice call";
    btnAudio.addEventListener("click", () => startCall(id, false));
    const btnVideo = document.createElement("button");
    btnVideo.className = "chat-call-btn";
    btnVideo.textContent = "Video";
    btnVideo.title = "Video call";
    btnVideo.addEventListener("click", () => startCall(id, true));
    actions.append(btnAudio, btnVideo);

    header.append(av, info, actions);

    renderChatBody(id);
    $$(".conv-item").forEach((c) => c.classList.remove("active"));
    $("#chatInput").focus();
  }

  function renderChatBody(id) {
    const conv = state.convos[id] || [];
    const body = $("#chatBody");
    body.innerHTML = "";
    const el = document.createElement("div");
    el.className = "msg theirs typing";
    el.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
    conv.forEach((m) => {
      const div = document.createElement("div");
      div.className = "msg " + (m.from === "me" ? "mine" : "theirs");
      div.innerHTML = `${m.text}<span class="time">${m.time || "Just now"}</span>`;
      body.appendChild(div);
    });
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  function sendMessage(id) {
    const input = $("#chatInput");
    const text = input.value.trim();
    if (!text) return;
    const t = new Date();
    const time = t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (!state.convos[id]) state.convos[id] = [];
    state.convos[id].push({ from: "me", text, time });
    state.lastChat[id] = Date.now();
    state.read[id] = true;
    input.value = "";
    save();
    renderAll();
    renderChatBody(id);

    const target = chatTargetId(id);
    const onlineUser = target && RT.online.get(target);
    if (onlineUser) {
      rtSend({ type: "chat", to: target, text, time });
      return;
    }

    const p = candidateById(id);
    const replies = [
      "Love that. Same energy over here.",
      "Okay that's actually a great point. Tell me more?",
      "Haha, definitely. Coffee this week?",
      "I was just thinking about that! Great minds.",
      "Count me in. My calendar is open after 6.",
      "Interesting! I'd really like to hear the full story over dinner.",
    ];
    setTimeout(() => {
      state.convos[id].push({
        from: "them",
        text: replies[Math.floor(Math.random() * replies.length)],
        time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      });
      state.lastChat[id] = Date.now();
      save();
      renderAll();
      renderChatBody(id);
    }, 1800 + Math.random() * 1200);
  }

  // ---------- Real-time (SSE) ----------
  const RT = {
    connected: false,
    myId: null,
    online: new Map(),
  };

  function buildOnlineCandidate(u) {
    return {
      id: "live:" + u.id,
      name: u.name,
      headline: u.headline || "Online now",
      location: "Online right now",
      age: 25,
      height: "—",
      skills: ["Live Chat", "Video Calls", "Real-time"],
      interests: ["Instant Replies", "Great Conversation"],
      mutual: [],
      verified: true,
      online: true,
      photo: u.photo || "",
      colors: ["#0a66c2", "#07c160"],
      pitch: "Online right now — say hi!",
    };
  }

  function onlineForCandidate(person) {
    const n = (person && person.name || "").trim().toLowerCase();
    return [...RT.online.values()].find((u) => u.name.trim().toLowerCase() === n) || null;
  }

  function rtSend(obj) {
    return fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ me: { id: RT.myId }, ...obj }),
    }).catch(() => {});
  }

  function chatTargetId(id) {
    if (!id) return null;
    if (id.startsWith("live:")) return id.slice(5);
    const twin = onlineForCandidate(candidateById(id));
    return twin ? twin.id : null;
  }

  function handleRtMsg(msg) {
    if (msg.type === "users") {
      RT.online = new Map(
        msg.users
          .filter((u) => u.id !== RT.myId)
          .map((u) => [u.id, u])
      );
      if ($("#view-discover.active")) renderStack($("#navSearch").value);
      if ($("#view-messages.active")) renderConvs();
      if ($("#view-matches.active")) renderMatches();
    } else if (msg.type === "chat") {
      const id = msg.fromId || msg.from;
      if (!state.convos[id]) state.convos[id] = [];
      state.convos[id].push({ from: "them", text: msg.text, time: msg.time });
      state.lastChat[id] = Date.now();
      state.read[id] = false;
      save();
      renderAll();
      if (activeChat === id) renderChatBody(id);
    } else if (msg.type === "signal") {
      handleSignal(msg.from, msg.data);
    }
  }

  function rtStart() {
    if (!window.location.protocol.startsWith("http")) return;
    const me = state.me;
    const idBase = ("rt-" + me.name + "-" + Math.random().toString(36).slice(2, 7))
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-");
    RT.myId = idBase;
    const params = new URLSearchParams({
      user: idBase,
      name: me.name,
      headline: me.headline,
      photo: me.photo || "",
    });
    const es = new EventSource("/api/events?" + params);
    RT.es = es;
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleRtMsg(msg);
    };
    es.onopen = () => { RT.connected = true; rtSend({ type: "hello", me: { id: RT.myId, name: state.me.name, headline: state.me.headline } }); };
    es.onerror = () => { RT.connected = false; };
  }

  // ---------- Calls (WebRTC) ----------
  let rtc = null;
  let incoming = null;

  function signalTo(targetId, data) {
    if (targetId) rtSend({ type: "signal", to: targetId, data });
  }

  async function getMedia(video) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: true });
    } catch (e) {
      toast("Camera/mic not available");
      return null;
    }
  }

  function makePeer(targetId) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.ontrack = (e) => {
      rtc.remoteStream = e.streams[0];
      $("#remoteVideo").srcObject = e.streams[0];
      $("#callStatus").textContent = "Connected";
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) signalTo(targetId, { kind: "ice", candidate: e.candidate });
    };
    return pc;
  }

  function showCallUI(name, status) {
    $("#callOverlay").classList.remove("hidden");
    $("#callName").textContent = name;
    $("#callStatus").textContent = status;
    $("#localVideo").srcObject = rtc && rtc.localStream ? rtc.localStream : null;
    $("#callVideo").textContent = "Video";
    $("#callMute").textContent = "Mute";
  }

  function hideCallUI() {
    $("#callOverlay").classList.add("hidden");
    $("#remoteVideo").srcObject = null;
    $("#localVideo").srcObject = null;
  }

  async function startCall(matchId, video) {
    if (!RT.connected) return toast("Not connected to the real-time server — run via start.bat");
    const targetId = chatTargetId(matchId);
    const target = targetId && RT.online.get(targetId);
    if (!target) return toast("They're not online right now");
    if (rtc) return toast("Call already in progress");
    const stream = await getMedia(video);
    if (!stream) return;
    const pc = makePeer(targetId);
    rtc = { pc, targetId, video, localStream: stream, remoteStream: null };
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signalTo(targetId, { kind: "offer", offer, video });
    showCallUI(target.name, "Calling…");
  }

  async function handleSignal(fromId, data) {
    if (data.kind === "offer") {
      incoming = { fromId, data };
      const name = RT.online.get(fromId);
      showIncomingCallModal(name ? name.name : fromId, data.video);
    } else if (data.kind === "answer" && rtc && rtc.targetId === fromId) {
      await rtc.pc.setRemoteDescription(data.answer);
      $("#callStatus").textContent = "Connecting…";
    } else if (data.kind === "ice" && rtc && rtc.targetId === fromId) {
      try { await rtc.pc.addIceCandidate(data.candidate); } catch (e) {}
    } else if (data.kind === "hangup") {
      if (rtc && rtc.targetId === fromId) endCall();
      if (incoming && incoming.fromId === fromId) declineIncoming();
    }
  }

  async function acceptIncoming() {
    if (!incoming) return;
    const { fromId, data } = incoming;
    incoming = null;
    const stream = await getMedia(data.video);
    if (!stream) return;
    const pc = makePeer(fromId);
    rtc = { pc, targetId: fromId, video: data.video, localStream: stream, remoteStream: null };
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    await pc.setRemoteDescription(data.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signalTo(fromId, { kind: "answer", answer });
    $("#incomingModal").remove();
    const name = RT.online.get(fromId);
    showCallUI(name ? name.name : "Call", "Connecting…");
  }

  function declineIncoming() {
    if (incoming) {
      signalTo(incoming.fromId, { kind: "hangup" });
      incoming = null;
    }
    const m = $("#incomingModal");
    if (m) m.remove();
  }

  function endCall() {
    const targetId = rtc ? rtc.targetId : incoming ? incoming.fromId : null;
    if (rtc) {
      try { rtc.pc.close(); } catch (e) {}
      if (rtc.localStream) rtc.localStream.getTracks().forEach((t) => t.stop());
      rtc = null;
    }
    incoming = null;
    if (targetId) signalTo(targetId, { kind: "hangup" });
    hideCallUI();
    const m = $("#incomingModal");
    if (m) m.remove();
  }

  function showIncomingCallModal(name, video) {
    const existing = $("#incomingModal");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "match-modal-overlay";
    overlay.id = "incomingModal";
    overlay.innerHTML = `
      <div class="match-modal">
        <h2>Incoming ${video ? "video call" : "call"}</h2>
        <p>${name} is calling you…</p>
        <div class="actions">
          <button class="btn-primary" id="incAccept">Accept</button>
          <button class="btn-ghost" id="incDecline">Decline</button>
        </div>
      </div>`;
    overlay.querySelector("#incAccept").addEventListener("click", acceptIncoming);
    overlay.querySelector("#incDecline").addEventListener("click", declineIncoming);
    document.body.appendChild(overlay);
  }

  $("#callEnd").addEventListener("click", endCall);
  $("#callMute").addEventListener("click", () => {
    if (!rtc || !rtc.localStream) return;
    const a = rtc.localStream.getAudioTracks()[0];
    if (a) { a.enabled = !a.enabled; $("#callMute").textContent = a.enabled ? "Mute" : "Unmute"; }
  });
  $("#callVideoToggle").addEventListener("click", () => {
    if (!rtc || !rtc.localStream) return;
    const v = rtc.localStream.getVideoTracks()[0];
    if (v) { v.enabled = !v.enabled; $("#callVideoToggle").textContent = v.enabled ? "Video" : "Video off"; }
  });

  // ---------- Profile ----------
  function renderMyProfile() {
    const me = state.me;
    const av = $("#myAvatar");
    av.className = "profile-avatar-big";
    if (me.photo) {
      av.textContent = "";
      av.style.background = `url(${me.photo}) center / cover no-repeat`;
    } else {
      av.style.background = "linear-gradient(135deg, #0a66c2, #5ea8ec)";
      av.textContent = "Y";
    }
    $("#myName").textContent = me.name;
    $("#myHeadline").textContent = me.headline;
    $("#myMeta").textContent = me.location + " · " + me.skills.length + " skills · " + me.interests.length + " interests";

    $("#fName").value = me.name;
    $("#fHeadline").value = me.headline;
    $("#fLocation").value = me.location;
    $("#fAbout").value = me.about || "";
    $("#fSkills").value = me.skills.join(", ");
    $("#fInterests").value = me.interests.join(", ");
  }

  // ---------- Bindings ----------
  $("#btnLike").addEventListener("click", () => {
    const card = topCard();
    if (card) settle(0, card, "like");
  });
  $("#btnPass").addEventListener("click", () => {
    const card = topCard();
    if (card) settle(0, card, "pass");
  });
  $("#btnSuper").addEventListener("click", () => {
    const card = topCard();
    if (card) settle(0, card, "super");
  });
  $("#resetDiscover").addEventListener("click", () => {
    state.seen = {};
    state.pendingLikes = [];
    save();
    renderStack($("#navSearch").value);
  });

  $("#btnEdit").addEventListener("click", () => $("#profileEditor").classList.toggle("hidden"));
  $("#btnCancel").addEventListener("click", () => $("#profileEditor").classList.add("hidden"));
  $("#btnSave").addEventListener("click", () => {
    state.me = {
      ...state.me,
      name: $("#fName").value.trim() || state.me.name,
      headline: $("#fHeadline").value.trim(),
      location: $("#fLocation").value.trim(),
      about: $("#fAbout").value.trim(),
      skills: $("#fSkills").value.split(",").map((s) => s.trim()).filter(Boolean),
      interests: $("#fInterests").value.split(",").map((s) => s.trim()).filter(Boolean),
    };
    save();
    $("#profileEditor").classList.add("hidden");
    renderMyProfile();
    renderStack($("#navSearch").value);
    rtSend({ type: "hello", me: { id: RT.myId, name: state.me.name, headline: state.me.headline } });
    toast("Profile updated");
  });

  $("#btnReset").addEventListener("click", () => {
    localStorage.removeItem(LS_KEY);
    state = initialState();
    save();
    renderAll();
    toast("Demo data reset");
  });

  $("#btnSend").addEventListener("click", () => sendMessage(currentChatId()));
  $("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage(currentChatId());
  });

  // ---------- Render all ----------
  function renderAll() {
    const unread = getUnreadCount();
    $("#matchBadge").textContent = state.matches.length;
    $("#matchBadge").classList.toggle("hidden", !state.matches.length);
    $("#msgBadge").textContent = unread;
    $("#msgBadge").classList.toggle("hidden", !unread);
    const active = $("#view-messages.active");
    if (active) renderConvs();
    if ($("#view-matches.active")) renderMatches();
  }

  // ---------- Init ----------
  renderStack("");
  renderMatches();
  renderConvs();
  renderMyProfile();
  renderAll();
  rtStart();
})();
