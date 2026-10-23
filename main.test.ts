// The entry, driven the way the core drives it: `app` is stubbed, so this
// needs no isolate, no network and no settings. Run it with
//   deno test --allow-read main.test.ts

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}
  actual:   ${a}
  expected: ${b}`);
}

function assertRefused(fn: () => unknown, pattern: RegExp, code = "invalid_args"): void {
  try {
    fn();
  } catch (e: any) {
    if (e.code !== code) throw new Error(`expected code ${code}, got ${e.code}: ${e.message}`);
    if (!pattern.test(e.message)) throw new Error(`message ${JSON.stringify(e.message)} does not match ${pattern}`);
    return;
  }
  throw new Error("expected a refusal");
}

async function harness(saved: unknown = null) {
  const h = {
    spec: null as any,
    emitted: [] as unknown[][],
    posts: [] as any[],
    store: saved as any,
  };
  (globalThis as any).app = {
    define(spec: any) { h.spec = spec; },
    emit(...args: unknown[]) { h.emitted.push(args); },
    gadget() {},
    ui: { post(payload: unknown) { h.posts.push(payload); } },
    store: { get: () => h.store, set: (v: unknown) => { h.store = v; } },
  };
  await import(`./main.ts#${crypto.randomUUID()}`);
  const c = h.spec.commands;
  const play = (...moves: string[]) => {
    let last: any;
    for (const m of moves) last = c.move({ move: m });
    return last;
  };
  return Object.assign(h, { c, play });
}

// Counts every legal line to a depth through the public commands: a wrong
// count means a rule is missing or a move is generated that should not be.
function perft(c: any, depth: number): number {
  if (depth === 0) return 1;
  const fen = c.state().fen;
  const moves = c.legalMoves({}).moves;
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) {
    c.move({ move: m.uci });
    n += perft(c, depth - 1);
    c.loadFen({ fen });
  }
  return n;
}

Deno.test("a new game starts with White to move and twenty legal moves", async () => {
  const { c } = await harness();
  const s = c.state();
  assertEquals(s.sentence, "White to move.");
  assertEquals(s.fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  assertEquals(s.legalMoves.length, 20);
  assertEquals(s.host, "white");
  assertEquals(s.toMoveIs, "host");
});

Deno.test("move generation matches the known perft counts", async () => {
  const { c } = await harness();
  assertEquals(perft(c, 3), 8902, "start position, depth 3");
  // Kiwipete: castling, en passant, promotion and pins all at once.
  c.loadFen({ fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1" });
  assertEquals(perft(c, 2), 2039, "kiwipete, depth 2");
  c.loadFen({ fen: "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1" });
  assertEquals(perft(c, 3), 2812, "position 3, depth 3");
  c.loadFen({ fen: "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1" });
  assertEquals(perft(c, 2), 264, "position 4, depth 2");
});

Deno.test("moves are read as UCI or SAN and recorded in SAN", async () => {
  const { c, play } = await harness();
  play("e2e4", "e5", "Nf3", "nc6", "f1-c4");
  const s = c.state();
  assertEquals(s.moves, ["e4", "e5", "Nf3", "Nc6", "Bc4"]);
  assertEquals(s.pgn, "1. e4 e5 2. Nf3 Nc6 3. Bc4");
  assertEquals(s.turn, "black");
});

Deno.test("illegal moves are refused with a reason and change nothing", async () => {
  const { c, play } = await harness();
  const before = c.state().fen;
  assertRefused(() => c.move({ move: "e2e5" }), /pawn on e2 cannot move to e5/);
  assertRefused(() => c.move({ move: "e7e5" }), /not yours to move: it is White's turn/);
  assertRefused(() => c.move({ move: "e3e4" }), /no piece on e3/);
  assertRefused(() => c.move({ move: "Qh5" }), /not a legal move for White/);
  assertRefused(() => c.move({ move: "O-O" }), /pieces stand between/);
  assertRefused(() => c.move({ move: "e2e4", side: "black" }), /White's turn, not Black's/, "forbidden");
  assertRefused(() => c.move({ move: "" }), /Say which move/);
  assertEquals(c.state().fen, before);
  // A pinned piece may not leave the line to its king.
  c.loadFen({ fen: "4k3/8/8/8/4r3/8/4N3/4K3 w - - 0 1" });
  assertRefused(() => c.move({ move: "e2c3" }), /leave White's king in check/);
  // In check, only a move that answers it.
  c.loadFen({ fen: "4k3/8/8/8/4r3/8/8/R3K3 w Q - 0 1" });
  assertRefused(() => c.move({ move: "a1a2" }), /does not get White's king out of check/);
  assertRefused(() => c.move({ move: "O-O-O" }), /cannot castle out of check/);
  play("Kd1");
});

Deno.test("castling both ways, and its rights are lost when the king or rook moves", async () => {
  const { c, play } = await harness();
  c.loadFen({ fen: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1" });
  play("O-O");
  assertEquals(c.state().board[7], "R . . . . R K .");
  play("e8c8");
  assertEquals(c.state().board[0], ". . k r . . . r");
  assertEquals(c.state().moves, ["O-O", "O-O-O"]);
  c.loadFen({ fen: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1" });
  play("Rb1", "Rb8", "Ra1", "Ra8");
  assertRefused(() => c.move({ move: "O-O-O" }), /no longer castle queenside/);
  play("O-O");
  // Through an attacked square.
  c.loadFen({ fen: "4k3/8/8/8/8/8/5r2/R3K2R w KQ - 0 1" });
  assertRefused(() => c.move({ move: "e1g1" }), /cannot castle through or into check/);
});

Deno.test("en passant only straight after the double step", async () => {
  const { c, play } = await harness();
  play("e4", "a6", "e5", "d5");
  assertEquals(c.state().fen.split(" ")[3], "d6");
  const r = play("exd6");
  assertEquals(r.played.san, "exd6");
  assertEquals(c.state().board[3].split(" ")[3], ".", "the d5 pawn is gone");
  const { c: c2, play: p2 } = await harness();
  p2("e4", "a6", "e5", "d5", "a3", "h6");
  assertRefused(() => c2.move({ move: "e5d6" }), /cannot move to d6/);
});

Deno.test("promotion needs a piece and accepts any of four", async () => {
  const { c, play } = await harness();
  c.loadFen({ fen: "1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1" });
  assertRefused(() => c.move({ move: "a7a8" }), /Say which piece the pawn becomes/);
  const opts = c.legalMoves({ square: "a7" }).moves.map((m: any) => m.uci);
  assertEquals(opts, ["a7a8q", "a7a8r", "a7a8b", "a7a8n", "a7b8q", "a7b8r", "a7b8b", "a7b8n"]);
  const r = play("axb8=N");
  assertEquals(r.played.uci, "a7b8n");
  assertEquals(c.state().board[0].split(" ")[1], "N");
  c.loadFen({ fen: "4k3/P7/8/8/8/8/8/4K3 w - - 0 1" });
  assertEquals(play("a8q").played.san, "a8=Q+");
});

Deno.test("check, checkmate and stalemate end or mark the game", async () => {
  const { c, play } = await harness();
  play("f3", "e5", "g4");
  const mate = play("Qh4");
  assertEquals(mate.played.san, "Qh4#");
  assertEquals(mate.status, "checkmate");
  assertEquals(mate.sentence, "Checkmate. Black wins.");
  assertEquals(mate.result, "0-1");
  assertEquals(mate.legalMoves, []);
  assertRefused(() => c.move({ move: "a3" }), /game is over/);

  c.loadFen({ fen: "4k3/8/8/8/8/8/8/R3K3 w - - 0 1" });
  const chk = play("Ra8");
  assertEquals(chk.played.san, "Ra8+");
  assertEquals(chk.sentence, "Check. Black to move.");
  assertEquals(chk.inCheck, true);

  c.loadFen({ fen: "7k/8/6Q1/8/8/8/8/K7 w - - 0 1" });
  assertEquals(play("Qf7").sentence, "Stalemate. The game is a draw.");
  assertEquals(c.state().result, "1/2-1/2");
});

Deno.test("draws by insufficient material, repetition and the fifty-move rule", async () => {
  const { c, play } = await harness();
  c.loadFen({ fen: "4k3/8/8/8/8/8/3p4/4K3 w - - 0 1" });
  assertEquals(play("Kxd2").sentence, "Draw by insufficient material.");
  c.loadFen({ fen: "4k3/8/8/8/8/8/8/R3K3 w - - 0 1" });
  play("Ra2", "Kd8", "Ra1", "Ke8", "Ra2", "Kd8", "Ra1");
  assertEquals(c.state().status, "playing");
  assertEquals(play("Ke8").sentence, "Draw by threefold repetition.");
  c.loadFen({ fen: "4k3/8/8/8/8/8/8/R3K3 w - - 99 80" });
  assertEquals(play("Ra2").sentence, "Draw by the fifty-move rule.");
});

Deno.test("a window moves only the side it plays, and says why it refused", async () => {
  const h = await harness();
  h.spec.onMessage({ payload: { type: "move", move: "e2e4" }, windowId: "w1" });
  assertEquals(h.c.state().lastMove, { uci: "e2e4", san: "e4", side: "white", by: "host" });
  h.posts.length = 0;
  h.spec.onMessage({ payload: { type: "move", move: "e7e5" }, windowId: "w1" });
  assertEquals(h.posts[0].type, "refused");
  assertEquals(h.posts[0].message, "It is Black's turn, not White's.");
  assertEquals(h.c.move({ move: "e5", side: "black" }).lastMove.by, "assistant");
  assertEquals(h.emitted, [["moves", "White played e4"], ["moves", "Black played e5"]]);
  // A window set to play Black, with a typed move: illegal first, then legal.
  h.posts.length = 0;
  h.spec.onMessage({ payload: { type: "move", move: "Nf6", side: "black" }, windowId: "w2" });
  assertEquals(h.posts[0].message, "It is White's turn, not Black's.");
  h.c.move({ move: "Nf3" });
  const fen = h.c.state().fen;
  h.spec.onMessage({ payload: { type: "move", move: "Ke6", side: "black" }, windowId: "w2" });
  assertEquals(h.posts[h.posts.length - 1].type, "refused");
  assertEquals(h.c.state().fen, fen, "a refused move changes nothing");
  h.spec.onMessage({ payload: { type: "move", move: "Nf6", side: "black" }, windowId: "w2" });
  assertEquals(h.c.state().lastMove, { uci: "g8f6", san: "Nf6", side: "black", by: "assistant" });
});

Deno.test("the game survives a reload, and a new game can give the host Black", async () => {
  const first = await harness();
  first.play("d4", "d5");
  const again = await harness(first.store);
  assertEquals(again.c.state().moves, ["d4", "d5"]);
  const s = again.c.newGame({ hostSide: "black" });
  assertEquals([s.host, s.assistant, s.toMoveIs, s.moves.length], ["black", "white", "assistant", 0]);
  assertRefused(() => again.c.newGame({ hostSide: "red" }), /must be "white" or "black"/);
  assertRefused(() => again.c.loadFen({ fen: "8/8/8/8/8/8/8/8 w - - 0 1" }), /exactly one king/);
  const r = again.c.resign({ side: "white" });
  assertEquals([r.sentence, r.result], ["White resigned. Black wins.", "0-1"]);
});
