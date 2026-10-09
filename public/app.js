/* Arivu Quiz — game client. Talks to the Worker API (or window.QUIZ_API in demo mode). */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
  const secs = (ms) => (ms / 1000).toFixed(1).replace(/\.0$/, '') + 's';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SKIP_AFTER_MS = 5000; // same as the server
  // Light mode for weak phones: no endless animations and no confetti (see .lite in style.css).
  // Turned on up front from what the phone reports, or after a quick speed test once the page has loaded.
  let lite = reduceMotion || navigator.connection?.saveData === true
    || (navigator.deviceMemory > 0 && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 2);
  const goLite = () => { lite = true; document.documentElement.classList.add('lite'); };
  if (lite) goLite();
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('arivu.' + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('arivu.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LEVEL_NAME = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

  // ---------- API ----------
  async function req(method, path, data) {
    const res = await fetch(path, {
      method, headers: data ? { 'content-type': 'application/json' } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
    let body = {};
    try { body = await res.json(); } catch { /* ignore */ }
    if (!res.ok) { const e = new Error(body.error || 'Network problem. Check your connection.'); e.status = res.status; throw e; }
    return body;
  }
  const API = window.QUIZ_API || {
    config: () => req('GET', '/api/config'),
    version: () => req('GET', '/api/version'),
    register: (p) => req('POST', '/api/register', p),
    start: (playerKey) => req('POST', '/api/game/start', { playerKey }),
    next: (playerKey, gameId) => req('POST', '/api/game/next', { playerKey, gameId }),
    answer: (playerKey, gameId, index, choice) => req('POST', '/api/game/answer', { playerKey, gameId, index, choice }),
    result: (playerKey, gameId) => req('POST', '/api/game/result', { playerKey, gameId }),
    board: (district, key) => req('GET', '/api/leaderboard?' + new URLSearchParams({ ...(district ? { district } : {}), ...(key ? { key } : {}) })),
  };

  // ---------- sound ----------
  const Sound = {
    on: store.get('sound') !== false, ctx: null,
    init() {
      if (this.ctx || !this.on) return;
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; }
    },
    tone(freq, dur, type = 'sine', vol = 0.14, when = 0) {
      if (!this.on) return;
      this.init();
      const c = this.ctx; if (!c) return;
      if (c.state === 'suspended') c.resume();
      const t = c.currentTime + when, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    },
    tick() { this.tone(1200, 0.05, 'square', 0.04); },
    tap() { this.tone(520, 0.06, 'triangle', 0.08); },
    good() { this.tone(660, 0.12, 'triangle'); this.tone(990, 0.22, 'triangle', 0.14, 0.09); },
    bad() { this.tone(190, 0.3, 'sawtooth', 0.09); this.tone(140, 0.35, 'sawtooth', 0.07, 0.12); },
    go() { this.tone(880, 0.25, 'triangle', 0.12); },
    fanfare() { [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.12, i * 0.11)); },
  };
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch { /* no-op */ } };

  // ---------- confetti ----------
  const Confetti = (() => {
    const cv = $('#confetti'), ctx = cv.getContext('2d');
    const colors = ['#D7262E', '#F2B33D', '#2FA36B', '#FBF3E8', '#FF8A8F'];
    let parts = [], raf = 0, dpr = 1;
    const size = () => { dpr = Math.min(1.5, devicePixelRatio || 1); cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; };
    addEventListener('resize', size); size();
    function add(x, y, n, spread, up) {
      if (reduceMotion || lite) return;
      for (let i = 0; i < n; i++) {
        const a = (-Math.PI / 2) + (Math.random() - 0.5) * spread, v = up * (0.6 + Math.random() * 0.7);
        parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
          w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, c: colors[i % colors.length], life: 1, shape: Math.random() < 0.3 ? 1 : 0 });
      }
      if (!raf) raf = requestAnimationFrame(loop);
    }
    function loop() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 40);
      for (const p of parts) {
        p.vy += 0.32; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life -= 0.006;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
        ctx.fillStyle = p.c;
        if (p.shape) { ctx.beginPath(); ctx.moveTo(0, -p.h / 2); ctx.lineTo(p.w / 2, p.h / 2); ctx.lineTo(-p.w / 2, p.h / 2); ctx.fill(); }
        else ctx.fillRect(-p.w / 2, -p.h / 4, p.w, p.h / 2);
        ctx.restore();
      }
      raf = parts.length ? requestAnimationFrame(loop) : 0;
      if (!raf) ctx.clearRect(0, 0, innerWidth, innerHeight);
    }
    return {
      burstAt(el) { const r = el.getBoundingClientRect(); add(r.left + r.width / 2, r.top + r.height / 2, 45, 2.2, 15); },
      celebrate() { add(innerWidth * 0.15, innerHeight, 60, 0.9, 24); add(innerWidth * 0.85, innerHeight, 60, 0.9, 24); setTimeout(() => add(innerWidth / 2, innerHeight, 50, 1.4, 26), 350); },
    };
  })();

  // ---------- UI helpers ----------
  const screens = ['splash', 'register', 'rules', 'quiz', 'result', 'board'];
  function show(name) {
    for (const s of screens) $('#screen-' + s).classList.toggle('is-active', s === name);
    scrollTo(0, 0);
    if (name === 'splash') checkVersion();
  }

  // ---------- new version check ----------
  // A phone can keep an old copy of the page open for days. When the server runs a newer version, load the new
  // page (once per version, so a deploy that is still rolling out can't cause a reload loop). Checked when the game
  // opens, whenever it comes back on screen, and on the opening screen; never during a game, on the player card
  // or on the results (a player may be away sharing their score).
  const PAGE_VERSION = document.querySelector('meta[name="app-version"]')?.content;
  let lastCheck = 0;
  function updateTo(v) {
    if (!v || !PAGE_VERSION || v === PAGE_VERSION) return false;
    let done = null;
    try { done = sessionStorage.getItem('arivu.reloadedFor'); } catch { /* storage blocked */ }
    if (done === v) return false;
    try { sessionStorage.setItem('arivu.reloadedFor', v); } catch { /* storage blocked */ }
    toast('Loading the new version…');
    location.replace(location.pathname + '?v=' + encodeURIComponent(v));
    return true;
  }
  async function checkVersion() {
    const screen = screens.find((s) => $('#screen-' + s).classList.contains('is-active'));
    if (!API.version || Date.now() - lastCheck < 20_000 || !['splash', 'rules', 'board'].includes(screen)) return;
    lastCheck = Date.now();
    try { updateTo((await API.version()).version); } catch { /* offline: try again next time */ }
  }
  let toastT;
  function toast(msg, ms = 3200) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
  }
  function countUp(el, from, to, dur = 700) {
    if (reduceMotion || from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(Math.round(from + (to - from) * e));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- state ----------
  const S = {
    cfg: null, me: store.get('player'), // { playerKey, player:{name,district} }
    gameId: null, total: 10, q: null, answered: false, score: 0, streak: 0, lastLevel: null,
    timer: { t: 0, end: 0, lastSec: null }, nextT: 0, skipT: 0, skipArmT: 0, skipArmed: 0, result: null,
  };

  // ---------- splash ----------
  async function boot() {
    $('#soundBtn').setAttribute('aria-pressed', String(Sound.on));
    $('#soundBtn').setAttribute('aria-label', Sound.on ? 'Sound on' : 'Sound off');
    // The player's button shows straight away; the stats request runs alongside the settings request
    renderSplashPlayer();
    const board = API.board('', S.me?.playerKey).then(renderStats).catch(() => {});
    try { S.cfg = await API.config(); } catch (e) { toast(e.message); S.cfg = null; }
    // A phone can keep an old cached copy of the page after an update. If the page is older than the
    // server, load the fresh page once (the guard stops a reload loop while a deploy is still rolling out).
    if (updateTo(S.cfg?.version)) return;
    lastCheck = Date.now();
    const c = S.cfg || { title: 'Arivu Quiz', districts: [], totalQuestions: 10, timeLimitSec: 15, points: { easy: 100, medium: 150, hard: 200 }, streakBonus: 25, streakCap: 100 };
    S.total = c.totalQuestions;
    const opts = (c.districts || []).map((d) => `<option>${esc(d)}</option>`).join('');
    $('#regForm [name=district]').insertAdjacentHTML('beforeend', opts);
    $('#boardDistrict').insertAdjacentHTML('beforeend', opts);
    if (c.version) $('#appVersion').textContent = 'v' + c.version;
    if (c.open === false) { $('#playBtn').disabled = true; $('#playBtn').textContent = 'Quiz is closed for now'; }
    renderSplashPlayer();
    // Once the opening screen has fully loaded (images, fonts, play count), bring "Play now" into view
    const loaded = new Promise((ok) => (document.readyState === 'complete' ? ok() : addEventListener('load', ok, { once: true })));
    Promise.all([loaded, document.fonts?.ready, board]).then(() => setTimeout(scrollToPlay, 300));
    loaded.then(() => setTimeout(probeSpeed, 800));
  }
  // A small fixed piece of work, timed three times (the fastest run counts, so a hiccup doesn't decide).
  // About 3 ms on a laptop; over 15 ms means a phone roughly 6x slower, so use light mode.
  function probeSpeed(runs = []) {
    if (lite) return;
    const t0 = performance.now(); let x = 0;
    for (let i = 0; i < 1e5; i++) x += Math.sqrt(i) * Math.sin(i);
    runs.push(x === -1 ? 0 : performance.now() - t0); // (x is read so the loop is not optimised away)
    if (runs.length < 3) return setTimeout(() => probeSpeed(runs), 60);
    if (Math.min(...runs) > 15) goLite();
  }
  // The stats text is fixed in index.html (starting at 0); only the numbers change, counting up once the data arrives
  function renderStats(b) {
    if (!b) return;
    countUp($('#statPlays'), 0, b.plays || 0, 900);
    countUp($('#statTop'), 0, b.top?.[0]?.score || 0, 900);
    if (b.me) $('#statRank').textContent = fmt(b.me.rank);
    $('#statMe').hidden = !b.me;
  }
  // Don't move the page if the player has already scrolled or tapped
  let touched = false;
  ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((ev) => addEventListener(ev, () => { touched = true; }, { once: true, passive: true }));
  function scrollToPlay() {
    if (touched || !$('#screen-splash').classList.contains('is-active')) return;
    const r = $('#playBtn').getBoundingClientRect();
    if (r.top >= 0 && r.bottom <= innerHeight - 12) return; // already in view
    $('#playBtn').scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  }
  function renderSplashPlayer() {
    const name = S.me?.player?.name;
    if (S.cfg?.open !== false) $('#playBtn').textContent = name ? `Play as ${name.split(' ')[0]}` : 'Play now';
    $('#switchUserBtn').hidden = !name;
  }

  // ---------- registration ----------
  // A card always starts empty: saving it makes a new player (only a name and district are asked)
  function openRegister() {
    const f = $('#regForm');
    f.name.value = ''; f.district.value = '';
    updateAvatar(); $('#regError').textContent = '';
    show('register');
    setTimeout(() => f.name.focus(), 350);
  }
  function updateAvatar() {
    const v = $('#regForm').name.value.trim(), a = $('#avatar'), ch = v ? v[0].toUpperCase() : '?';
    if (a.textContent !== ch) { a.textContent = ch; a.classList.remove('pop'); void a.offsetWidth; a.classList.add('pop'); }
  }
  async function submitRegister(e) {
    e.preventDefault();
    const f = e.target, err = $('#regError');
    f.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid'));
    const data = { name: f.name.value.trim(), district: f.district.value };
    const bad = (el, msg) => { el.classList.add('invalid'); el.focus(); err.textContent = msg; buzz(60); };
    if (data.name.length < 2) return bad(f.name, 'Enter your name or a nickname.');
    if (!data.district) return bad(f.district, 'Choose your district.');
    err.textContent = '';
    const btn = $('#regSubmit'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await API.register(data);
      S.me = { playerKey: r.playerKey, player: r.player };
      store.set('player', S.me);
      renderSplashPlayer();
      openRules(r.returning);
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; btn.textContent = 'Save and continue'; }
  }

  // ---------- rules ----------
  function openRules(returning) {
    const c = S.cfg || {}, p = c.points || { easy: 100, medium: 150, hard: 200 }, t = c.timeLimitSec || 15;
    const first = (S.me?.player?.name || '').split(' ')[0];
    $('#welcomeLine').textContent = first ? (returning ? `Welcome back, ${first}.` : `Welcome, ${first}.`) : 'Welcome.';
    $('#ruleCount').textContent = c.totalQuestions || 10;
    $('#ruleTime').textContent = t;
    const tries = c.maxAttempts || 0;
    $('#ruleAttempts').textContent = tries === 1 ? 'ഒരു തവണ മാത്രം കളിക്കാം.'
      : `ഒരാൾക്ക് ${tries > 1 ? tries + ' തവണ' : 'ഒന്നിൽ കൂടുതൽ തവണ'} കളിക്കാം, മികച്ച സ്കോർ ലീഡർബോർഡിൽ.`;
    const pen = c.penalty || { easy: 0, medium: 0, hard: 0 };
    const negative = ['easy', 'medium', 'hard'].some((l) => pen[l] > 0);
    $('#pointsTable').innerHTML = ['easy', 'medium', 'hard'].filter((l) => (c.levels || { easy: 1, medium: 1, hard: 1 })[l] > 0)
      .map((l) => `<div class="${l}"><b>+${p[l]}</b><span>${LEVEL_NAME[l]}</span>${pen[l] ? `<small>−${pen[l]} if wrong</small>` : ''}</div>`).join('');
    $('#ruleNegative').hidden = !negative;
    show('rules');
  }

  // ---------- game ----------
  async function startGame() {
    if (!S.me) return openRegister();
    Sound.init();
    const btns = [$('#startBtn'), $('#againBtn')];
    btns.forEach((b) => { b.disabled = true; });
    const from = screens.find((s) => $('#screen-' + s).classList.contains('is-active'));
    try {
      // the 3-2-1 countdown runs while the server sets up the game (no question is served until it ends)
      const starting = API.start(S.me.playerKey); starting.catch(() => {});
      $('#march').innerHTML = ''; $('#hudScore').textContent = '0'; setStreak(0);
      $('#qText').textContent = ''; $('#options').innerHTML = ''; $('#feedback').hidden = true; $('#skipBtn').hidden = true;
      show('quiz');
      await countdown();
      const g = await starting;
      S.gameId = g.gameId; S.total = g.total; S.score = 0; S.streak = 0; S.lastLevel = null;
      $('#march').innerHTML = '<li></li>'.repeat(g.total);
      await loadNext();
    } catch (e) {
      if (e.status !== 401 && from) show(from);
      if (e.status === 401) { S.me = null; store.set('player', null); renderSplashPlayer(); toast('Please register again.'); openRegister(); }
      else toast(e.message, 4500);
    } finally { btns.forEach((b) => { b.disabled = false; }); }
  }
  async function countdown() {
    const ov = $('#countdown'), n = $('#countNum');
    ov.hidden = false;
    for (const v of ['3', '2', '1', 'Go']) {
      n.textContent = v; n.classList.remove('tick'); void n.offsetWidth; n.classList.add('tick');
      v === 'Go' ? Sound.go() : Sound.tick();
      await wait(v === 'Go' ? 500 : 700);
    }
    ov.hidden = true;
  }
  async function levelUp(level) {
    const c = S.cfg || {};
    const ov = $('#levelUp'), l = $('#luLevel');
    l.textContent = LEVEL_NAME[level] || level;
    l.className = 'lu-level ' + level;
    $('#luLine').textContent = `Level up: ${(c.points || {})[level] ?? ''} points per question`;
    ov.hidden = false; Sound.fanfare();
    await wait(1400);
    ov.hidden = true;
  }

  async function loadNext() {
    clearTimeout(S.nextT);
    if (S.loading) return; // a double tap on Next must not ask for the question twice
    S.loading = true;
    const nb = $('#nextBtn'), slow = setTimeout(() => { nb.classList.add('busy'); nb.querySelector('.lbl').textContent = 'Loading…'; }, 250);
    let q;
    try { q = await API.next(S.me.playerKey, S.gameId); }
    catch (e) { toast(e.message); $('#feedback').hidden = false; nb.querySelector('.lbl').textContent = 'Try again'; return; }
    finally { clearTimeout(slow); nb.classList.remove('busy'); S.loading = false; }
    if (q.done) return finish();
    if (S.lastLevel && q.difficulty !== S.lastLevel) await levelUp(q.difficulty);
    S.lastLevel = q.difficulty;
    S.q = q; S.answered = false;
    S.score = q.score; $('#hudScore').textContent = fmt(q.score); setStreak(q.streak);
    const march = $('#march').children;
    for (let i = 0; i < march.length; i++) march[i].classList.toggle('now', i === q.index);
    const lv = $('#qLevel');
    lv.textContent = `${LEVEL_NAME[q.difficulty]} · ${q.points} pts`;
    lv.className = 'level ' + q.difficulty;
    $('#qNum').textContent = `Question ${q.index + 1} of ${q.total}`;
    const qt = $('#qText'); qt.textContent = q.question; qt.classList.remove('in', 'long', 'xlong'); void qt.offsetWidth;
    qt.classList.add('in'); if (q.question.length > 150) qt.classList.add('xlong'); else if (q.question.length > 95) qt.classList.add('long');
    $('#options').classList.toggle('long', q.options.some((o) => o.length > 60));
    const box = $('#options'); box.classList.remove('locked');
    box.innerHTML = q.options.map((o, i) =>
      `<button class="opt" type="button" data-i="${i}"><span class="key">${'ABCDEF'[i]}</span><span class="txt">${esc(o)}</span></button>`).join('');
    $('#feedback').hidden = true;
    // Skip opens 5 seconds into the question (counted from when it was first shown, so a reload doesn't reset it)
    $('#skipBtn').hidden = false; disarmSkip();
    S.skipAt = performance.now() + Math.max(0, SKIP_AFTER_MS - (q.limitMs - q.remainingMs));
    updateSkip();
    startTimer(q.remainingMs, q.limitMs);
  }

  // The ring is one CSS animation (no per-frame script); the number is updated once a second
  function startTimer(remaining, limit) {
    clearTimeout(S.timer.t);
    const ring = $('#timerRing'), txt = $('#timerText'), wrap = $('#timer');
    S.timer.end = performance.now() + remaining; S.timer.lastSec = null;
    wrap.classList.remove('low');
    ring.style.animation = 'none'; void ring.getBoundingClientRect();
    ring.style.animation = 'ring linear forwards';
    // 'important' so the reduced-motion rule (which shortens every animation) leaves the clock alone
    ring.style.setProperty('animation-duration', limit + 'ms', 'important');
    ring.style.setProperty('animation-delay', (remaining - limit) + 'ms', 'important');
    const tick = () => {
      const left = Math.max(0, S.timer.end - performance.now()), sec = Math.ceil(left / 1000);
      if (sec !== S.timer.lastSec) {
        S.timer.lastSec = sec; txt.textContent = sec;
        if (sec <= 5 && sec > 0) { wrap.classList.add('low'); Sound.tick(); }
      }
      if (left <= 0) { wrap.classList.remove('low'); return submit(null); }
      S.timer.t = setTimeout(tick, (left % 1000 || 1000) + 5);
    };
    tick();
  }
  // Locked with a countdown on the button until SKIP_AFTER_MS, then open
  function updateSkip() {
    const sk = $('#skipBtn');
    clearTimeout(S.skipT);
    if (S.answered || S.skipArmed) return;
    const ms = S.skipAt - performance.now(), left = Math.ceil(ms / 1000);
    sk.disabled = left > 0;
    sk.innerHTML = left > 0 ? `Skip question <small>in ${left}s</small>` : 'Skip question <small>no marks lost</small>';
    if (left > 0) S.skipT = setTimeout(updateSkip, (ms % 1000 || 1000) + 5);
  }
  // Skip needs two taps: the first arms it, the second (not a fast double-tap) skips
  function armSkip() {
    const sk = $('#skipBtn');
    S.skipArmed = performance.now(); sk.classList.add('armed');
    sk.innerHTML = 'Tap again to skip <small>no marks lost</small>'; buzz(15);
    clearTimeout(S.skipArmT); S.skipArmT = setTimeout(disarmSkip, 3000);
  }
  function disarmSkip() {
    clearTimeout(S.skipArmT); S.skipArmed = 0;
    const sk = $('#skipBtn'); sk.classList.remove('armed');
    sk.innerHTML = 'Skip question <small>no marks lost</small>';
  }
  function stopTimer() { clearTimeout(S.timer.t); $('#timerRing').style.animationPlayState = 'paused'; $('#timer').classList.remove('low'); }

  async function submit(choice, attempt = 0) {
    if (S.answered && attempt === 0) return;
    S.answered = true; stopTimer(); clearTimeout(S.skipT); disarmSkip();
    const box = $('#options'), btns = [...box.children];
    box.classList.add('locked');
    btns.forEach((b) => { b.disabled = true; });
    $('#skipBtn').disabled = true;
    if (typeof choice === 'number') { btns[choice]?.classList.add('chosen'); Sound.tap(); }
    let r;
    try { r = await API.answer(S.me.playerKey, S.gameId, S.q.index, choice); }
    catch (e) {
      if (e.status === 409) return loadNext();
      if (attempt < 2 && !e.status) { await wait(800 * (attempt + 1)); return submit(choice, attempt + 1); }
      toast(e.message + ' Tap your answer again.');
      S.answered = false; box.classList.remove('locked'); btns.forEach((b) => { b.disabled = false; b.classList.remove('chosen'); });
      updateSkip();
      return;
    }
    reveal(choice, r, btns);
  }

  function reveal(choice, r, btns) {
    btns.forEach((b) => b.classList.remove('chosen'));
    const right = btns[r.correctChoice];
    const li = $('#march').children[S.q.index];
    li.classList.remove('now'); li.classList.add(r.correct ? 'ok' : r.wrong ? 'no' : 'skip');
    $('#skipBtn').hidden = true;
    const pts = $('#fbPoints'), line = $('#fbLine');
    if (r.correct) {
      right.classList.add('right');
      right.insertAdjacentHTML('beforeend', '<span class="tag">Correct</span>');
      Confetti.burstAt(right); Sound.good(); buzz(30);
      pts.className = 'fb-points'; pts.textContent = '+' + fmt(r.points);
      const parts = [`${r.breakdown.base} points`];
      if (r.breakdown.speed) parts.push(`${r.breakdown.speed} speed`);
      if (r.breakdown.streak) parts.push(`${r.breakdown.streak} streak`);
      line.textContent = parts.join(' + ') + ` in ${secs(r.timeMs)}`;
    } else if (r.wrong) {
      if (btns[choice]) btns[choice].classList.add('wrong');
      right.classList.add('right');
      right.insertAdjacentHTML('beforeend', '<span class="tag">Right answer</span>');
      Sound.bad(); buzz([70, 40, 70]);
      pts.className = 'fb-points minus';
      pts.textContent = r.penalty ? '−' + fmt(r.penalty) : 'Not quite';
      const lost = r.penalty ? `Wrong answer, ${r.penalty} marks lost.` : r.fullPenalty ? 'Wrong answer. Your score is already at zero.' : 'Wrong answer.';
      line.textContent = lost + (S.streak >= 2 ? ` Streak of ${S.streak} ends here.` : ' The right answer is in green.');
    } else {
      right.classList.add('right');
      right.insertAdjacentHTML('beforeend', '<span class="tag">Right answer</span>');
      Sound.tap();
      pts.className = 'fb-points skip';
      pts.textContent = r.skipped ? 'Skipped' : "Time's up";
      line.textContent = 'No marks lost.' + (S.streak >= 2 ? ` Streak of ${S.streak} ends here.` : ' The right answer is in green.');
    }
    $('#fbExplain').textContent = r.explanation || '';
    countUp($('#hudScore'), S.score, r.score);
    if (r.points) { const h = $('#hudScore'), cls = r.points > 0 ? 'bump' : 'drop'; h.classList.remove('bump', 'drop'); void h.offsetWidth; h.classList.add(cls); }
    S.score = r.score; setStreak(r.streak);
    const fb = $('#feedback'); fb.hidden = false;
    requestAnimationFrame(() => fb.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' }));
    const nb = $('#nextBtn');
    nb.querySelector('.lbl').textContent = r.done ? 'See my score' : 'Next question';
    const dur = (r.correct ? 2000 : 3400) + (r.explanation ? 1800 : 0);
    nb.style.setProperty('--dur', dur + 'ms');
    nb.classList.remove('run'); void nb.offsetWidth; nb.classList.add('run');
    clearTimeout(S.nextT);
    S.nextT = setTimeout(goNext, dur);
    S.pendingDone = r.done;
  }
  function goNext() {
    clearTimeout(S.nextT);
    $('#nextBtn').classList.remove('run');
    if (S.pendingDone) { S.pendingDone = false; return finish(); }
    loadNext();
  }
  function setStreak(n) {
    S.streak = n; $('#streakNum').textContent = n;
    $('#streak').classList.toggle('hot', n >= 2);
  }

  // ---------- results ----------
  function badgeFor(correct, total) {
    const r = total ? correct / total : 0;
    if (r >= 0.9) return 'Expert';
    if (r >= 0.7) return 'Well informed';
    if (r >= 0.5) return 'Good effort';
    return 'Keep learning';
  }
  async function finish() {
    stopTimer();
    show('result');
    const scr = $('#screen-result'); scr.classList.add('pending');
    $('#resScore').textContent = '0';
    $('#board').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    let r;
    try { r = await API.result(S.me.playerKey, S.gameId); }
    catch (e) { toast(e.message); return; }
    finally { scr.classList.remove('pending'); }
    S.result = r;
    $('#resBadge').textContent = badgeFor(r.correct, r.total);
    countUp($('#resScore'), 0, r.score, 1400);
    const dot = { right: ['ok', '✓', 'right'], wrong: ['no', '✕', 'wrong'], skipped: ['skip', '–', 'skipped'], timeout: ['skip', '–', 'time ran out'] };
    $('#resDots').innerHTML = r.answers.map((a, i) => {
      const [cls, mark, label] = dot[a.state] || (a.correct ? dot.right : dot.wrong);
      return `<li class="${cls}" style="animation-delay:${0.2 + i * 0.06}s" title="Question ${i + 1}: ${label}">${mark}</li>`;
    }).join('');
    const notes = [];
    if (r.wrong) notes.push(`${r.wrong} wrong${r.marksLost ? `, ${fmt(r.marksLost)} marks lost` : ''}`);
    if (r.skipped) notes.push(`${r.skipped} skipped`);
    if (r.timedOut) notes.push(`${r.timedOut} ran out of time`);
    $('#resNote').textContent = notes.length ? notes.join('. ') + '.' : '';
    $('#resCorrect').textContent = `${r.correct}/${r.total}`;
    $('#resTime').textContent = secs(r.timeMs);
    $('#resStreak').textContent = r.bestStreak;
    const me = r.overall.me, dme = r.districtBoard.me;
    $('#resRank').textContent = me ? fmt(me.rank) : '–';
    const pct = me && r.overall.total > 1 ? Math.max(1, Math.ceil((me.rank / r.overall.total) * 100)) : null;
    $('#resRankLine').textContent = !me ? 'This game was not counted.'
      : r.overall.total === 1 ? 'You are the first player on the Kerala board.'
      : `of ${fmt(r.overall.total)} players across Kerala${pct && pct <= 50 ? `, top ${pct}%` : ''}.` + (dme ? ` #${fmt(dme.rank)} in ${r.district}.` : '');
    const pb = $('#resPB');
    pb.hidden = !me || (r.personalBest && !r.score);
    if (me) pb.textContent = r.personalBest ? 'Your best game so far' : `Your best stays ${fmt(me.score)}`;
    setTab('all');
    const again = $('#againBtn');
    if (r.attemptsLeft === 0) { again.disabled = true; again.textContent = 'No attempts left'; }
    else { again.disabled = false; again.textContent = r.attemptsLeft ? `Play again (${r.attemptsLeft} left)` : 'Play again'; }
    setTimeout(() => {
      Sound.fanfare();
      if (r.correct / r.total >= 0.5 || (me && me.rank <= 10)) Confetti.celebrate();
    }, 500);
  }
  function setTab(which) {
    const r = S.result; if (!r) return;
    $('#tabAll').classList.toggle('is-on', which === 'all'); $('#tabAll').setAttribute('aria-selected', String(which === 'all'));
    $('#tabDistrict').classList.toggle('is-on', which !== 'all'); $('#tabDistrict').setAttribute('aria-selected', String(which !== 'all'));
    $('#tabDistrict').textContent = r.district || 'My district';
    renderBoard($('#board'), which === 'all' ? r.overall : r.districtBoard, which === 'all');
  }
  function renderBoard(el, b, showDistrict) {
    if (!b || !b.top.length) { el.innerHTML = '<p class="empty">No scores yet. Be the first on the board.</p>'; return; }
    const sub = (x) => (showDistrict ? esc(x.district) : '');
    const pod = (x, cls) => x ? `<div class="pod ${cls}${x.isMe ? ' me' : ''}"><span class="who">${esc(x.name)}</span><span class="where">${sub(x)}</span>
      <div class="block"><span class="n">${x.rank}</span><span class="s">${fmt(x.score)}</span></div></div>` : '<div></div>';
    const row = (x) => `<div class="row${x.isMe ? ' me' : ''}"><span class="rk">${fmt(x.rank)}</span>
      <span class="nm">${esc(x.name)}<small>${sub(x)}</small></span><span class="pt">${fmt(x.score)}</span></div>`;
    const [a, b2, c] = b.top;
    let html = `<div class="podium">${pod(b2, 'p2')}${pod(a, 'p1')}${pod(c, 'p3')}</div>`;
    html += b.top.slice(3).map(row).join('');
    if (b.me && !b.top.some((x) => x.isMe)) html += `<div class="gap">• • •</div>${row({ ...b.me, isMe: true })}`;
    el.innerHTML = html;
  }
  async function openBoard() {
    show('board');
    await loadBoard2();
  }
  async function loadBoard2() {
    const el = $('#board2'), d = $('#boardDistrict').value;
    el.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    try { renderBoard(el, await API.board(d, S.me?.playerKey), !d); }
    catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
  }
  async function share() {
    const r = S.result, c = S.cfg || {};
    const text = r
      ? `I scored ${fmt(r.score)} in ${c.title || 'the quiz'} (${r.correct}/${r.total} right${r.overall.me ? `, #${r.overall.me.rank} in Kerala` : ''}). Can you beat me?`
      : `Play ${c.title || 'the quiz'}!`;
    const url = location.origin + '/';
    if (navigator.share) { try { await navigator.share({ title: c.title, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    open('https://wa.me/?text=' + encodeURIComponent(text + ' ' + url), '_blank', 'noopener');
  }

  // ---------- wiring ----------
  $('#playBtn').addEventListener('click', () => { Sound.init(); S.me ? openRules(true) : openRegister(); });
  $('#switchUserBtn').addEventListener('click', () => openRegister());
  $('#boardBtn').addEventListener('click', openBoard);
  $('#regForm').addEventListener('submit', submitRegister);
  $('#regForm').name.addEventListener('input', updateAvatar);
  ['input', 'change'].forEach((ev) => $('#regForm').addEventListener(ev, (e) => {
    if (e.target.classList.contains('invalid')) { e.target.classList.remove('invalid'); $('#regError').textContent = ''; }
  }));
  $('#startBtn').addEventListener('click', startGame);
  $('#againBtn').addEventListener('click', startGame);
  $('#options').addEventListener('click', (e) => {
    const b = e.target.closest('.opt'); if (!b || b.disabled || S.answered) return;
    submit(Number(b.dataset.i));
  });
  $('#nextBtn').addEventListener('click', () => { if ($('#nextBtn .lbl').textContent === 'Try again') { $('#feedback').hidden = true; return loadNext(); } goNext(); });
  $('#skipBtn').addEventListener('click', () => {
    if (S.answered) return;
    if (!S.skipArmed) return armSkip();
    if (performance.now() - S.skipArmed > 400) submit('skip');
  });
  $('#tabAll').addEventListener('click', () => setTab('all'));
  $('#tabDistrict').addEventListener('click', () => setTab('district'));
  $('#shareBtn').addEventListener('click', share);
  $('#boardDistrict').addEventListener('change', loadBoard2);
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));
  $('#soundBtn').addEventListener('click', () => {
    Sound.on = !Sound.on; store.set('sound', Sound.on);
    $('#soundBtn').setAttribute('aria-pressed', String(Sound.on));
    $('#soundBtn').setAttribute('aria-label', Sound.on ? 'Sound on' : 'Sound off');
    if (Sound.on) Sound.tap();
  });
  document.addEventListener('keydown', (e) => {
    if (!$('#screen-quiz').classList.contains('is-active') || S.answered) return;
    if (e.key.toLowerCase() === 's') return $('#skipBtn').disabled ? undefined : submit('skip');
    const i = 'abcdef'.indexOf(e.key.toLowerCase());
    if (i >= 0 && i < (S.q?.options.length || 0)) submit(i);
  });
  // Pause-proof: when the tab comes back, resync the clock with the server
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if ($('#screen-quiz').classList.contains('is-active') && S.q && !S.answered) loadNext();
    else checkVersion();
  });
  addEventListener('pageshow', (e) => { if (e.persisted) checkVersion(); }); // page restored from the back/forward cache

  boot();
})();
