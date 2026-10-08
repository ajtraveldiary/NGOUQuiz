/* Arivu Quiz — game client. Talks to the Worker API (or window.QUIZ_API in demo mode). */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
  const secs = (ms) => (ms / 1000).toFixed(1).replace(/\.0$/, '') + 's';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    const size = () => { dpr = Math.min(2, devicePixelRatio || 1); cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; };
    addEventListener('resize', size); size();
    function add(x, y, n, spread, up) {
      if (reduceMotion) return;
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
      burstAt(el) { const r = el.getBoundingClientRect(); add(r.left + r.width / 2, r.top + r.height / 2, 90, 2.2, 15); },
      celebrate() { add(innerWidth * 0.15, innerHeight, 120, 0.9, 24); add(innerWidth * 0.85, innerHeight, 120, 0.9, 24); setTimeout(() => add(innerWidth / 2, innerHeight, 100, 1.4, 26), 350); },
    };
  })();

  // ---------- UI helpers ----------
  const screens = ['splash', 'register', 'rules', 'quiz', 'result', 'board'];
  function show(name) {
    for (const s of screens) $('#screen-' + s).classList.toggle('is-active', s === name);
    scrollTo(0, 0);
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
    cfg: null, me: store.get('player'), // { playerKey, player:{name,office,district,phone} }
    gameId: null, total: 10, q: null, answered: false, score: 0, streak: 0, lastLevel: null,
    timer: { raf: 0, end: 0, lastSec: null }, nextT: 0, result: null,
  };

  // ---------- splash ----------
  async function boot() {
    $('#soundBtn').setAttribute('aria-pressed', String(Sound.on));
    $('#soundBtn').setAttribute('aria-label', Sound.on ? 'Sound on' : 'Sound off');
    try { S.cfg = await API.config(); } catch (e) { toast(e.message); S.cfg = null; }
    const c = S.cfg || { title: 'Arivu Quiz', values: [], districts: [], totalQuestions: 10, timeLimitSec: 20, points: { easy: 100, medium: 150, hard: 200 }, streakBonus: 25, streakCap: 100 };
    S.total = c.totalQuestions;
    const words = String(c.title).trim().split(/\s+/);
    const first = words.length > 1 ? words.slice(0, Math.ceil(words.length / 2)).join(' ') : words[0];
    const second = words.length > 1 ? words.slice(Math.ceil(words.length / 2)).join(' ') : '';
    $('#gameTitle').innerHTML = `<span>${esc(first)}</span>${second ? `<span>${esc(second)}</span>` : ''}`;
    document.title = c.title + (c.subtitle ? ' | ' + c.subtitle : '');
    if (c.subtitle) $('#orgName').textContent = c.subtitle;
    if (c.tagline) $('#tagline').textContent = c.tagline;
    $('#values').innerHTML = (c.values || []).map((v) => `<li>${esc(v)}</li>`).join('');
    const opts = (c.districts || []).map((d) => `<option>${esc(d)}</option>`).join('');
    $('#regForm [name=district]').insertAdjacentHTML('beforeend', opts);
    $('#boardDistrict').insertAdjacentHTML('beforeend', opts);
    if (c.open === false) { $('#playBtn').disabled = true; $('#playBtn').textContent = 'Quiz is closed for now'; }
    renderSplashPlayer();
    API.board('', S.me?.playerKey).then((b) => {
      if (!b.total) return;
      const el = $('#splashStats'); el.hidden = false;
      el.innerHTML = `<b>${fmt(b.total)}</b> employees on the board. Top score <b>${fmt(b.top[0]?.score)}</b>` +
        (b.me ? `. You're <b>#${fmt(b.me.rank)}</b>` : '');
    }).catch(() => {});
  }
  function renderSplashPlayer() {
    const name = S.me?.player?.name;
    if (S.cfg?.open !== false) $('#playBtn').textContent = name ? `Play as ${name.split(' ')[0]}` : 'Play now';
    $('#switchUserBtn').hidden = !name;
  }

  // ---------- registration ----------
  function openRegister() {
    const f = $('#regForm'), p = S.me?.player || {};
    f.name.value = p.name || ''; f.office.value = p.office || ''; f.district.value = p.district || ''; f.phone.value = p.phone || '';
    updateAvatar(); $('#regError').textContent = '';
    show('register');
    setTimeout(() => (p.name ? null : f.name.focus()), 350);
  }
  function updateAvatar() {
    const v = $('#regForm').name.value.trim(), a = $('#avatar'), ch = v ? v[0].toUpperCase() : '?';
    if (a.textContent !== ch) { a.textContent = ch; a.classList.remove('pop'); void a.offsetWidth; a.classList.add('pop'); }
  }
  async function submitRegister(e) {
    e.preventDefault();
    const f = e.target, err = $('#regError');
    f.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid'));
    const data = { name: f.name.value.trim(), office: f.office.value.trim(), district: f.district.value, phone: f.phone.value.replace(/\D/g, '') };
    const bad = (el, msg) => { el.classList.add('invalid'); el.focus(); err.textContent = msg; buzz(60); };
    if (data.name.length < 2) return bad(f.name, 'Enter your name.');
    if (data.office.length < 2) return bad(f.office, 'Enter your office.');
    if (!data.district) return bad(f.district, 'Choose your district.');
    if (!/^[6-9]\d{9}$/.test(data.phone)) return bad(f.phone, 'Enter a valid 10-digit mobile number.');
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
    const c = S.cfg || {}, p = c.points || { easy: 100, medium: 150, hard: 200 }, t = c.timeLimitSec || 20;
    const first = (S.me?.player?.name || '').split(' ')[0];
    $('#welcomeLine').textContent = first ? (returning ? `Welcome back, ${first}.` : `Welcome, ${first}.`) : 'Welcome.';
    $('#ruleCount').textContent = `${c.totalQuestions || 10} questions`;
    $('#ruleTime').textContent = `${t} seconds`;
    $('#pointsTable').innerHTML = ['easy', 'medium', 'hard'].filter((l) => (c.levels || { easy: 1, medium: 1, hard: 1 })[l] > 0)
      .map((l) => `<div class="${l}"><b>${p[l]}</b><span>${LEVEL_NAME[l]}</span></div>`).join('');
    const left = Math.round(t * 0.6), speed = Math.round(p.medium * left / t);
    $('#ruleExample').textContent = `Example: a medium question answered with ${left} of ${t} seconds left earns ${p.medium} + ${speed} speed bonus = ${p.medium + speed}. Get the next one right too and add a ${c.streakBonus ?? 25}-point streak bonus.`;
    show('rules');
  }

  // ---------- game ----------
  async function startGame() {
    if (!S.me) return openRegister();
    Sound.init();
    const btns = [$('#startBtn'), $('#againBtn')];
    btns.forEach((b) => { b.disabled = true; });
    try {
      const g = await API.start(S.me.playerKey);
      S.gameId = g.gameId; S.total = g.total; S.score = 0; S.streak = 0; S.lastLevel = null;
      $('#march').innerHTML = Array.from({ length: g.total }, () => '<li></li>').join('');
      $('#hudScore').textContent = '0'; setStreak(0);
      show('quiz');
      $('#qText').textContent = ''; $('#options').innerHTML = ''; $('#feedback').hidden = true;
      await countdown();
      await loadNext();
    } catch (e) {
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
    let q;
    try { q = await API.next(S.me.playerKey, S.gameId); }
    catch (e) { toast(e.message); $('#feedback').hidden = false; $('#nextBtn .lbl').textContent = 'Try again'; return; }
    if (q.done) return finish();
    if (S.lastLevel && q.difficulty !== S.lastLevel) await levelUp(q.difficulty);
    S.lastLevel = q.difficulty;
    S.q = q; S.answered = false;
    S.score = q.score; $('#hudScore').textContent = fmt(q.score); setStreak(q.streak);
    const march = $('#march').children;
    for (let i = 0; i < march.length; i++) march[i].classList.toggle('now', i === q.index);
    const lv = $('#qLevel'); lv.textContent = `${LEVEL_NAME[q.difficulty]} · ${q.points} pts`; lv.className = 'level ' + q.difficulty;
    $('#qNum').textContent = `Question ${q.index + 1} of ${q.total}`;
    const qt = $('#qText'); qt.textContent = q.question; qt.classList.remove('in'); void qt.offsetWidth; qt.classList.add('in');
    const box = $('#options'); box.classList.remove('locked');
    box.innerHTML = q.options.map((o, i) =>
      `<button class="opt" type="button" data-i="${i}"><span class="key">${'ABCDEF'[i]}</span><span class="txt">${esc(o)}</span></button>`).join('');
    $('#feedback').hidden = true;
    startTimer(q.remainingMs, q.limitMs);
  }

  function startTimer(remaining, limit) {
    cancelAnimationFrame(S.timer.raf);
    const ring = $('#timerRing'), txt = $('#timerText'), wrap = $('#timer'), C = 326.73;
    S.timer.end = performance.now() + remaining; S.timer.lastSec = null;
    wrap.classList.remove('low');
    const frame = (t) => {
      const left = Math.max(0, S.timer.end - t), sec = Math.ceil(left / 1000);
      ring.style.strokeDashoffset = String(C * (1 - left / limit));
      if (sec !== S.timer.lastSec) {
        S.timer.lastSec = sec; txt.textContent = sec;
        if (sec <= 5 && sec > 0) { wrap.classList.add('low'); Sound.tick(); }
      }
      if (left <= 0) { wrap.classList.remove('low'); return submit(null); }
      S.timer.raf = requestAnimationFrame(frame);
    };
    S.timer.raf = requestAnimationFrame(frame);
  }
  function stopTimer() { cancelAnimationFrame(S.timer.raf); $('#timer').classList.remove('low'); }

  async function submit(choice, attempt = 0) {
    if (S.answered && attempt === 0) return;
    S.answered = true; stopTimer();
    const box = $('#options'), btns = [...box.children];
    box.classList.add('locked');
    btns.forEach((b) => { b.disabled = true; });
    if (choice !== null) { btns[choice]?.classList.add('chosen'); Sound.tap(); }
    let r;
    try { r = await API.answer(S.me.playerKey, S.gameId, S.q.index, choice); }
    catch (e) {
      if (e.status === 409) return loadNext();
      if (attempt < 2 && !e.status) { await wait(800 * (attempt + 1)); return submit(choice, attempt + 1); }
      toast(e.message + ' Tap your answer again.');
      S.answered = false; box.classList.remove('locked'); btns.forEach((b) => { b.disabled = false; b.classList.remove('chosen'); });
      return;
    }
    reveal(choice, r, btns);
  }

  function reveal(choice, r, btns) {
    btns.forEach((b) => b.classList.remove('chosen'));
    const right = btns[r.correctChoice];
    const li = $('#march').children[S.q.index];
    li.classList.remove('now'); li.classList.add(r.correct ? 'ok' : 'no');
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
    } else {
      if (choice !== null && btns[choice]) btns[choice].classList.add('wrong');
      right.classList.add('right');
      right.insertAdjacentHTML('beforeend', '<span class="tag">Right answer</span>');
      Sound.bad(); buzz([70, 40, 70]);
      pts.className = 'fb-points zero';
      pts.textContent = r.timedOut ? "Time's up" : 'Not quite';
      line.textContent = S.streak >= 2 ? `Streak of ${S.streak} ends here. Keep marching.` : 'The right answer is marked in green.';
    }
    $('#fbExplain').textContent = r.explanation || '';
    countUp($('#hudScore'), S.score, r.score);
    if (r.points) { const h = $('#hudScore'); h.classList.remove('bump'); void h.offsetWidth; h.classList.add('bump'); }
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
    if (r >= 0.9) return 'Union Star';
    if (r >= 0.7) return 'Front-line Voice';
    if (r >= 0.5) return 'Steady Marcher';
    return 'Keep marching';
  }
  async function finish() {
    stopTimer();
    show('result');
    $('#resScore').textContent = '0';
    $('#board').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    let r;
    try { r = await API.result(S.me.playerKey, S.gameId); }
    catch (e) { toast(e.message); return; }
    S.result = r;
    $('#resBadge').textContent = badgeFor(r.correct, r.total);
    countUp($('#resScore'), 0, r.score, 1400);
    $('#resDots').innerHTML = r.answers.map((a, i) =>
      `<li class="${a.correct ? 'ok' : 'no'}" style="animation-delay:${0.2 + i * 0.06}s" title="Question ${i + 1}">${a.correct ? '✓' : '✕'}</li>`).join('');
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
    const sub = (x) => esc(showDistrict ? `${x.office}, ${x.district}` : x.office);
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
  $('#regForm').phone.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); });
  $('#startBtn').addEventListener('click', startGame);
  $('#againBtn').addEventListener('click', startGame);
  $('#options').addEventListener('click', (e) => {
    const b = e.target.closest('.opt'); if (!b || b.disabled || S.answered) return;
    submit(Number(b.dataset.i));
  });
  $('#nextBtn').addEventListener('click', () => { if ($('#nextBtn .lbl').textContent === 'Try again') { $('#feedback').hidden = true; return loadNext(); } goNext(); });
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
    const i = 'abcdef'.indexOf(e.key.toLowerCase());
    if (i >= 0 && i < (S.q?.options.length || 0)) submit(i);
  });
  // Pause-proof: when the tab comes back, resync the clock with the server
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && $('#screen-quiz').classList.contains('is-active') && S.q && !S.answered) loadNext();
  });

  boot();
})();
