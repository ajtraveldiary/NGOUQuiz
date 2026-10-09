/* In-browser stand-in for the Worker API, used only by the shareable demo build.
   Mirrors the server's game rules; QUESTIONS is injected by build-demo.mjs. */
(() => {
  const S = { title: 'Arivu Quiz', subtitle: 'Kerala NGO Union', tagline: 'Know the facts. Defend our rights.',
    values: ['Solidarity', 'Democracy', 'Secularism', 'People-centred public service'],
    easy: 4, medium: 4, hard: 2, timeLimitSec: 15, points: { easy: 100, medium: 150, hard: 200 }, penalty: { easy: 25, medium: 40, hard: 50 }, streakBonus: 25, streakCap: 100,
    campaign: { show: true, name: 'Secretariat Valayal', nameMl: 'സെക്രട്ടേറിയറ്റ് വളയൽ', date: '2026-11-21', place: 'Thiruvananthapuram',
      organiser: 'Action Council of State Employees & Teachers',
      line: 'Over 25,000 employees and teachers will encircle the Secretariat to protect the rights we have won.',
      demands: ['Implement the pay revision now; grant interim relief', 'Withdraw NPS and restore the old pension; repeal the PFRDA Act',
        'Implement the DA arrears order without delay', 'Restore earned leave surrender', 'Cancel unfair transfers; hold general transfers as per norms',
        'Fix the shortcomings in MEDISEP', 'Drop moves that weaken education and the civil service'] } };
  const DISTRICTS = ['Thiruvananthapuram North', 'Thiruvananthapuram South', 'Kollam', 'Pathanamthitta', 'Alappuzha', 'Kottayam', 'Idukki', 'Ernakulam',
    'Thrissur', 'Palakkad', 'Malappuram', 'Kozhikode', 'Wayanad', 'Kannur', 'Kasaragod'];
  const names = ['Sreeja R', 'Anil Kumar P', 'Fathima N', 'Rajesh V', 'Deepa Mol', 'Shibu Thomas', 'Lekha S', 'Nisar K', 'Bindu G', 'Vinod M',
    'Sajitha P', 'Arun Raj', 'Jaseena', 'Prasanth K', 'Mini Joseph', 'Haris T', 'Reshmi R', 'Sunil Babu', 'Anitha V', 'Manoj C',
    'Divya K', 'Shameer A', 'Latha Devi', 'Gireesh N', 'Smitha S', 'Jayakumar', 'Rasiya B', 'Santhosh P', 'Ambili', 'Noushad'];
  const offices = ['Taluk Office', 'PHC', 'Collectorate', 'DEO Office', 'Village Office', 'District Hospital', 'Treasury', 'PWD Section', 'Krishi Bhavan', 'Panchayat Office'];
  const AREAS = Object.fromEntries(DISTRICTS.map((d) => [d, ['Civil Station', 'Hospital', 'Rural', 'Town']]));
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const people = names.map((n, i) => {
    const d = DISTRICTS[i % 14];
    return { id: 'x' + i, name: n, office: offices[i % offices.length], district: d, area: AREAS[d][i % 4], score: Math.round(900 + rnd() * 2500), timeMs: Math.round(30000 + rnd() * 90000), correct: 0 };
  });
  people.forEach((p) => { p.correct = Math.min(10, Math.max(3, Math.round(p.score / 330))); });
  let me = null, game = null;
  const delay = (v, ms = 120) => new Promise((r) => setTimeout(() => r(v), ms));
  const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function board(district) {
    const all = [...people, ...(me && me.best != null ? [{ id: 'me', name: me.name, office: me.office, district: me.district, area: me.area, score: me.best, timeMs: me.bestMs, correct: me.bestCorrect }] : [])]
      .filter((p) => !district || p.district === district)
      .sort((a, b) => b.score - a.score || a.timeMs - b.timeMs)
      .map((p, i) => ({ rank: i + 1, score: p.score, timeMs: p.timeMs, correct: p.correct, name: p.name, office: p.office, district: p.district, area: p.area, isMe: p.id === 'me' }));
    return { top: all.slice(0, 10), me: all.find((x) => x.isMe) || null, total: all.length, plays: people.length + (me ? Math.max(1, me.games || 0) : 0) };
  }
  window.QUIZ_API = {
    config: () => delay({ ...S, version: typeof APP_VERSION === 'string' ? APP_VERSION : undefined, districts: DISTRICTS, areas: AREAS, levels: { easy: 4, medium: 4, hard: 2 }, totalQuestions: 10, bonusQuestion: true, maxAttempts: 0, open: true }),
    register: (p) => { me = { ...(me || {}), ...p }; return delay({ playerKey: 'demo', player: p, returning: false, played: 0, best: null }); },
    start: () => {
      // same rule as the server: 6 Political, 1 Constitution, 2 KSR & Govt rules, 1 General political; 4 easy, 4 medium, 2 hard
      const need = { easy: S.easy, medium: S.medium, hard: S.hard }, used = new Set(), chosen = [], pool = shuffle(QUESTIONS.filter((q) => !q.campaign));
      const best = (c) => c.reduce((b, q) => (need[q.difficulty] > need[b.difficulty] ? q : b), c[0]);
      const take = (q) => { chosen.push(q); used.add(q.topic); need[q.difficulty]--; };
      for (const [cat, n] of [['Constitution', 1], ['General political', 1], ['KSR & Govt rules', 2], ['Political', 6]]) {
        for (let k = 0; k < n; k++) { const c = pool.filter((q) => q.category === cat && !used.has(q.topic)); if (c.length) take(best(c)); }
      }
      const rank = { easy: 0, medium: 1, hard: 2 };
      const bonus = shuffle(QUESTIONS.filter((q) => q.campaign))[0];
      const qs = [...chosen.sort((a, b) => rank[a.difficulty] - rank[b.difficulty]), ...(bonus ? [bonus] : [])];
      if (me) me.games = (me.games || 0) + 1;
      game = { qs, orders: qs.map((q) => shuffle(q.options.map((_, i) => i))), i: 0, served: null, score: 0, streak: 0, best: 0, correct: 0, ms: 0, answers: [] };
      return delay({ gameId: 'demo', total: qs.length, index: 0 });
    },
    next: () => {
      if (game.i >= game.qs.length) return delay({ done: true });
      if (!game.served) game.served = Date.now();
      const q = game.qs[game.i], lim = S.timeLimitSec * 1000;
      return delay({ done: false, index: game.i, total: game.qs.length, question: q.question, difficulty: q.difficulty, category: q.category, bonus: !!q.campaign,
        options: game.orders[game.i].map((k) => q.options[k]), points: S.points[q.difficulty], limitMs: lim,
        remainingMs: Math.max(0, lim - (Date.now() - game.served)), score: game.score, streak: game.streak });
    },
    answer: (k, id, index, choice) => {
      const q = game.qs[game.i], order = game.orders[game.i], lim = S.timeLimitSec * 1000;
      const t = Math.min(lim, Math.max(0, Date.now() - game.served - 150));
      const skipped = choice === 'skip', picked = typeof choice === 'number';
      const ok = picked && order[choice] === q.correct, wrong = picked && !ok;
      const base = ok ? S.points[q.difficulty] : 0, speed = ok ? Math.round(base * (lim - t) / lim) : 0;
      game.streak = ok ? game.streak + 1 : 0; game.best = Math.max(game.best, game.streak);
      const st = ok && game.streak >= 2 ? Math.min(S.streakCap, S.streakBonus * (game.streak - 1)) : 0;
      const isBonus = !!q.campaign;
      const penalty = wrong && !isBonus ? Math.min(S.penalty[q.difficulty], game.score) : 0;
      const pts = ok ? base + speed + st : -penalty;
      const state = ok ? 'right' : wrong ? 'wrong' : skipped ? 'skipped' : 'timeout';
      game.score += pts; game.correct += ok ? 1 : 0; game.ms += t; game.answers.push({ correct: ok, points: pts, state, bonus: isBonus });
      game.i++; game.served = null;
      const done = game.i >= game.qs.length;
      return delay({ correct: ok, wrong, skipped, bonus: isBonus, timedOut: choice === null, penalty, fullPenalty: wrong && !isBonus ? S.penalty[q.difficulty] : 0, correctChoice: order.indexOf(q.correct), points: pts,
        breakdown: { base, speed, streak: st }, timeMs: t, score: game.score, streak: game.streak, done, explanation: q.explanation });
    },
    result: () => {
      const pb = me.best == null || game.score > me.best;
      if (pb) { me.best = game.score; me.bestMs = game.ms; me.bestCorrect = game.correct; }
      return delay({ score: game.score, correct: game.correct, total: game.qs.length, timeMs: game.ms, bestStreak: game.best,
        personalBest: pb, answers: game.answers,
        wrong: game.answers.filter((a) => a.state === 'wrong').length, skipped: game.answers.filter((a) => a.state === 'skipped').length,
        timedOut: game.answers.filter((a) => a.state === 'timeout').length, marksLost: -game.answers.reduce((x, a) => x + Math.min(0, a.points), 0), attemptsLeft: null, district: me.district, overall: board(null), districtBoard: board(me.district) }, 400);
    },
    board: (district) => delay(board(district || null)),
  };
})();
