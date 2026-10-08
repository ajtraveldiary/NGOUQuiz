/* In-browser stand-in for the Worker API, used only by the shareable demo build.
   Mirrors the server's game rules; QUESTIONS is injected by build-demo.mjs. */
(() => {
  const S = { title: 'Arivu Quiz', subtitle: 'Kerala NGO Union, State Committee', tagline: 'Know your rights. Serve the people.',
    values: ['Solidarity', 'Democracy', 'Secularism', 'People-centred public service'],
    easy: 4, medium: 4, hard: 2, timeLimitSec: 20, points: { easy: 100, medium: 150, hard: 200 }, streakBonus: 25, streakCap: 100 };
  const DISTRICTS = ['Thiruvananthapuram', 'Kollam', 'Pathanamthitta', 'Alappuzha', 'Kottayam', 'Idukki', 'Ernakulam',
    'Thrissur', 'Palakkad', 'Malappuram', 'Kozhikode', 'Wayanad', 'Kannur', 'Kasaragod'];
  const names = ['Sreeja R', 'Anil Kumar P', 'Fathima N', 'Rajesh V', 'Deepa Mol', 'Shibu Thomas', 'Lekha S', 'Nisar K', 'Bindu G', 'Vinod M',
    'Sajitha P', 'Arun Raj', 'Jaseena', 'Prasanth K', 'Mini Joseph', 'Haris T', 'Reshmi R', 'Sunil Babu', 'Anitha V', 'Manoj C',
    'Divya K', 'Shameer A', 'Latha Devi', 'Gireesh N', 'Smitha S', 'Jayakumar', 'Rasiya B', 'Santhosh P', 'Ambili', 'Noushad'];
  const offices = ['Taluk Office', 'PHC', 'Collectorate', 'DEO Office', 'Village Office', 'District Hospital', 'Treasury', 'PWD Section', 'Krishi Bhavan', 'Panchayat Office'];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const people = names.map((n, i) => {
    const d = DISTRICTS[i % 14];
    return { id: 'x' + i, name: n, office: offices[i % offices.length], district: d, score: Math.round(900 + rnd() * 2500), timeMs: Math.round(30000 + rnd() * 90000), correct: 0 };
  });
  people.forEach((p) => { p.correct = Math.min(10, Math.max(3, Math.round(p.score / 330))); });
  let me = null, game = null;
  const delay = (v, ms = 120) => new Promise((r) => setTimeout(() => r(v), ms));
  const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function board(district) {
    const all = [...people, ...(me && me.best != null ? [{ id: 'me', name: me.name, office: me.office, district: me.district, score: me.best, timeMs: me.bestMs, correct: me.bestCorrect }] : [])]
      .filter((p) => !district || p.district === district)
      .sort((a, b) => b.score - a.score || a.timeMs - b.timeMs)
      .map((p, i) => ({ rank: i + 1, score: p.score, timeMs: p.timeMs, correct: p.correct, name: p.name, office: p.office, district: p.district, isMe: p.id === 'me' }));
    return { top: all.slice(0, 10), me: all.find((x) => x.isMe) || null, total: all.length };
  }
  window.QUIZ_API = {
    config: () => delay({ ...S, districts: DISTRICTS, levels: { easy: 4, medium: 4, hard: 2 }, totalQuestions: 10, maxAttempts: 0, open: true }),
    register: (p) => { me = { ...(me || {}), ...p }; return delay({ playerKey: 'demo', player: p, returning: false, played: 0, best: null }); },
    start: () => {
      const pick = (l, n) => shuffle(QUESTIONS.filter((q) => q.difficulty === l)).slice(0, n);
      const qs = [...pick('easy', S.easy), ...pick('medium', S.medium), ...pick('hard', S.hard)];
      game = { qs, orders: qs.map((q) => shuffle(q.options.map((_, i) => i))), i: 0, served: null, score: 0, streak: 0, best: 0, correct: 0, ms: 0, answers: [] };
      return delay({ gameId: 'demo', total: qs.length, index: 0 });
    },
    next: () => {
      if (game.i >= game.qs.length) return delay({ done: true });
      if (!game.served) game.served = Date.now();
      const q = game.qs[game.i], lim = S.timeLimitSec * 1000;
      return delay({ done: false, index: game.i, total: game.qs.length, question: q.question, difficulty: q.difficulty, category: q.category,
        options: game.orders[game.i].map((k) => q.options[k]), points: S.points[q.difficulty], limitMs: lim,
        remainingMs: Math.max(0, lim - (Date.now() - game.served)), score: game.score, streak: game.streak });
    },
    answer: (k, id, index, choice) => {
      const q = game.qs[game.i], order = game.orders[game.i], lim = S.timeLimitSec * 1000;
      const t = Math.min(lim, Math.max(0, Date.now() - game.served - 150));
      const ok = choice !== null && order[choice] === q.correct;
      const base = ok ? S.points[q.difficulty] : 0, speed = ok ? Math.round(base * (lim - t) / lim) : 0;
      game.streak = ok ? game.streak + 1 : 0; game.best = Math.max(game.best, game.streak);
      const st = ok && game.streak >= 2 ? Math.min(S.streakCap, S.streakBonus * (game.streak - 1)) : 0;
      const pts = base + speed + st;
      game.score += pts; game.correct += ok ? 1 : 0; game.ms += t; game.answers.push({ correct: ok, points: pts });
      game.i++; game.served = null;
      const done = game.i >= game.qs.length;
      return delay({ correct: ok, timedOut: choice === null, correctChoice: order.indexOf(q.correct), points: pts,
        breakdown: { base, speed, streak: st }, timeMs: t, score: game.score, streak: game.streak, done, explanation: q.explanation });
    },
    result: () => {
      const pb = me.best == null || game.score > me.best;
      if (pb) { me.best = game.score; me.bestMs = game.ms; me.bestCorrect = game.correct; }
      return delay({ score: game.score, correct: game.correct, total: game.qs.length, timeMs: game.ms, bestStreak: game.best,
        personalBest: pb, answers: game.answers, attemptsLeft: null, district: me.district, overall: board(null), districtBoard: board(me.district) }, 400);
    },
    board: (district) => delay(board(district || null)),
  };
})();
