// Chess for two: the host plays one side in the window, the assistant the
// other through commands. The isolate owns the one game; every window is a
// view of it, and `app.store` keeps it through a reload or restart.
//
// Squares are numbered 0..63 from a1 (0) to h8 (63): index = rank * 8 + file.
// Pieces are FEN letters, upper case for White.

type Color = "w" | "b";
type Side = "white" | "black";

interface Position {
  board: (string | null)[];
  turn: Color;
  castling: string;
  ep: number | null;
  halfmove: number;
  fullmove: number;
}

interface Move {
  from: number;
  to: number;
  piece: string;
  captured: string | null;
  promotion?: string;
  flag?: "ep" | "castleK" | "castleQ" | "double";
}

interface Played {
  uci: string;
  san: string;
  side: Side;
  by: "host" | "assistant";
  fen: string;
}

interface Game {
  startFen: string;
  hostSide: Side;
  moves: Played[];
  resigned: Side | null;
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FILES = "abcdefgh";
const NAMES: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

// ---------------------------------------------------------------- squares

function sqName(i: number): string {
  return FILES[i % 8] + String(Math.floor(i / 8) + 1);
}

function sqIndex(name: string): number | null {
  if (!/^[a-h][1-8]$/.test(name)) return null;
  return FILES.indexOf(name[0]) + (Number(name[1]) - 1) * 8;
}

function colorOf(p: string): Color {
  return p === p.toUpperCase() ? "w" : "b";
}

function other(c: Color): Color {
  return c === "w" ? "b" : "w";
}

function sideOf(c: Color): Side {
  return c === "w" ? "white" : "black";
}

function colorFor(s: Side): Color {
  return s === "white" ? "w" : "b";
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

function pieceName(p: string): string {
  return `${sideOf(colorOf(p))} ${NAMES[p.toLowerCase()]}`;
}

function at(pos: Position, f: number, r: number): string | null | undefined {
  if (f < 0 || f > 7 || r < 0 || r > 7) return undefined;
  return pos.board[r * 8 + f];
}

// ---------------------------------------------------------------- FEN

function refuse(code: string, message: string): never {
  const e: any = new Error(message);
  e.code = code;
  throw e;
}

function parseFen(fen: string): Position {
  const parts = String(fen ?? "").trim().split(/\s+/);
  if (parts.length < 4) refuse("invalid_args", "A FEN needs at least the board, the side to move, castling and en passant fields.");
  const rows = parts[0].split("/");
  if (rows.length !== 8) refuse("invalid_args", "The FEN board needs eight ranks separated by '/'.");
  const board: (string | null)[] = new Array(64).fill(null);
  rows.forEach((row, i) => {
    const r = 7 - i;
    let f = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) f += Number(ch);
      else if (/[pnbrqkPNBRQK]/.test(ch)) {
        if (f > 7) refuse("invalid_args", `Rank ${r + 1} of the FEN has more than eight squares.`);
        board[r * 8 + f] = ch;
        f++;
      } else refuse("invalid_args", `'${ch}' is not a FEN piece letter.`);
    }
    if (f !== 8) refuse("invalid_args", `Rank ${r + 1} of the FEN has ${f} squares, not eight.`);
  });
  if (board.filter((p) => p === "K").length !== 1 || board.filter((p) => p === "k").length !== 1) {
    refuse("invalid_args", "Each side needs exactly one king.");
  }
  for (let f = 0; f < 8; f++) {
    if (board[f]?.toLowerCase() === "p" || board[56 + f]?.toLowerCase() === "p") {
      refuse("invalid_args", "Pawns cannot stand on the first or last rank.");
    }
  }
  if (parts[1] !== "w" && parts[1] !== "b") refuse("invalid_args", "The side to move must be 'w' or 'b'.");
  if (!/^(-|K?Q?k?q?)$/.test(parts[2]) || parts[2] === "") refuse("invalid_args", "Castling must be '-' or some of 'KQkq'.");
  let castling = parts[2] === "-" ? "" : parts[2];
  // Drop rights the pieces no longer allow, so a careless FEN cannot castle through nothing.
  if (board[4] !== "K") castling = castling.replace(/[KQ]/g, "");
  if (board[60] !== "k") castling = castling.replace(/[kq]/g, "");
  if (board[7] !== "R") castling = castling.replace("K", "");
  if (board[0] !== "R") castling = castling.replace("Q", "");
  if (board[63] !== "r") castling = castling.replace("k", "");
  if (board[56] !== "r") castling = castling.replace("q", "");
  let ep: number | null = null;
  if (parts[3] !== "-") {
    ep = sqIndex(parts[3]);
    const rank = ep === null ? -1 : Math.floor(ep / 8);
    if (ep === null || rank !== (parts[1] === "w" ? 5 : 2)) refuse("invalid_args", "The en passant square is not one a pawn could have just passed.");
  }
  const halfmove = parts[4] === undefined ? 0 : Number(parts[4]);
  const fullmove = parts[5] === undefined ? 1 : Number(parts[5]);
  if (!Number.isInteger(halfmove) || halfmove < 0 || !Number.isInteger(fullmove) || fullmove < 1) {
    refuse("invalid_args", "The move counters must be whole numbers.");
  }
  const pos: Position = { board, turn: parts[1] as Color, castling, ep, halfmove, fullmove };
  if (inCheck(pos, other(pos.turn))) refuse("invalid_args", "The side that just moved is in check, so this position cannot happen.");
  return pos;
}

function boardFen(pos: Position): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = "";
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.board[r * 8 + f];
      if (!p) empty++;
      else {
        if (empty) row += empty;
        empty = 0;
        row += p;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join("/");
}

function toFen(pos: Position): string {
  return [
    boardFen(pos),
    pos.turn,
    pos.castling || "-",
    pos.ep === null ? "-" : sqName(pos.ep),
    pos.halfmove,
    pos.fullmove,
  ].join(" ");
}

// ---------------------------------------------------------------- rules

function attacked(pos: Position, sq: number, by: Color): boolean {
  const f = sq % 8;
  const r = Math.floor(sq / 8);
  const is = (p: string | null | undefined, letter: string) =>
    !!p && p === (by === "w" ? letter.toUpperCase() : letter);
  const dir = by === "w" ? 1 : -1;
  if (is(at(pos, f - 1, r - dir), "p") || is(at(pos, f + 1, r - dir), "p")) return true;
  for (const [df, dr] of KNIGHT) if (is(at(pos, f + df, r + dr), "n")) return true;
  for (const [df, dr] of KING) if (is(at(pos, f + df, r + dr), "k")) return true;
  const slide = (dirs: number[][], letters: string[]) => {
    for (const [df, dr] of dirs) {
      let x = f + df;
      let y = r + dr;
      for (;;) {
        const p = at(pos, x, y);
        if (p === undefined) break;
        if (p) {
          if (letters.some((l) => is(p, l))) return true;
          break;
        }
        x += df;
        y += dr;
      }
    }
    return false;
  };
  return slide(ROOK, ["r", "q"]) || slide(BISHOP, ["b", "q"]);
}

function kingSquare(pos: Position, c: Color): number {
  return pos.board.indexOf(c === "w" ? "K" : "k");
}

function inCheck(pos: Position, c: Color): boolean {
  return attacked(pos, kingSquare(pos, c), other(c));
}

function pseudoMoves(pos: Position): Move[] {
  const moves: Move[] = [];
  const us = pos.turn;
  const add = (from: number, to: number, extra: Partial<Move> = {}) => {
    moves.push({ from, to, piece: pos.board[from]!, captured: pos.board[to], ...extra });
  };
  for (let from = 0; from < 64; from++) {
    const p = pos.board[from];
    if (!p || colorOf(p) !== us) continue;
    const f = from % 8;
    const r = Math.floor(from / 8);
    const kind = p.toLowerCase();
    const enemy = (q: string | null | undefined) => !!q && colorOf(q) !== us;
    if (kind === "p") {
      const dir = us === "w" ? 1 : -1;
      const startRank = us === "w" ? 1 : 6;
      const lastRank = us === "w" ? 7 : 0;
      const push = (to: number, extra: Partial<Move> = {}) => {
        if (Math.floor(to / 8) === lastRank) {
          for (const promo of ["q", "r", "b", "n"]) add(from, to, { ...extra, promotion: promo });
        } else add(from, to, extra);
      };
      if (at(pos, f, r + dir) === null) {
        push((r + dir) * 8 + f);
        if (r === startRank && at(pos, f, r + 2 * dir) === null) add(from, (r + 2 * dir) * 8 + f, { flag: "double" });
      }
      for (const df of [-1, 1]) {
        const t = at(pos, f + df, r + dir);
        if (t === undefined) continue;
        const to = (r + dir) * 8 + f + df;
        if (enemy(t)) push(to);
        else if (pos.ep === to) {
          add(from, to, { flag: "ep", captured: us === "w" ? "p" : "P" });
        }
      }
      continue;
    }
    const steps = kind === "n" ? KNIGHT : kind === "k" ? KING : null;
    if (steps) {
      for (const [df, dr] of steps) {
        const t = at(pos, f + df, r + dr);
        if (t === undefined || (t && !enemy(t))) continue;
        add(from, (r + dr) * 8 + f + df);
      }
    } else {
      const dirs = kind === "r" ? ROOK : kind === "b" ? BISHOP : [...ROOK, ...BISHOP];
      for (const [df, dr] of dirs) {
        let x = f + df;
        let y = r + dr;
        for (;;) {
          const t = at(pos, x, y);
          if (t === undefined) break;
          if (t && !enemy(t)) break;
          add(from, y * 8 + x);
          if (t) break;
          x += df;
          y += dr;
        }
      }
    }
    if (kind === "k") {
      const home = us === "w" ? 4 : 60;
      const them = other(us);
      if (from === home && !attacked(pos, home, them)) {
        const [kSide, qSide] = us === "w" ? ["K", "Q"] : ["k", "q"];
        const rook = us === "w" ? "R" : "r";
        if (
          pos.castling.includes(kSide) && pos.board[home + 3] === rook &&
          !pos.board[home + 1] && !pos.board[home + 2] &&
          !attacked(pos, home + 1, them) && !attacked(pos, home + 2, them)
        ) add(from, home + 2, { flag: "castleK" });
        if (
          pos.castling.includes(qSide) && pos.board[home - 4] === rook &&
          !pos.board[home - 1] && !pos.board[home - 2] && !pos.board[home - 3] &&
          !attacked(pos, home - 1, them) && !attacked(pos, home - 2, them)
        ) add(from, home - 2, { flag: "castleQ" });
      }
    }
  }
  return moves;
}

function makeMove(pos: Position, m: Move): Position {
  const board = pos.board.slice();
  const us = pos.turn;
  board[m.from] = null;
  board[m.to] = m.promotion ? (us === "w" ? m.promotion.toUpperCase() : m.promotion) : m.piece;
  if (m.flag === "ep") board[m.to + (us === "w" ? -8 : 8)] = null;
  if (m.flag === "castleK") {
    board[m.to - 1] = board[m.to + 1];
    board[m.to + 1] = null;
  }
  if (m.flag === "castleQ") {
    board[m.to + 1] = board[m.to - 2];
    board[m.to - 2] = null;
  }
  let castling = pos.castling;
  if (m.piece === "K") castling = castling.replace(/[KQ]/g, "");
  if (m.piece === "k") castling = castling.replace(/[kq]/g, "");
  for (const [sq, right] of [[0, "Q"], [7, "K"], [56, "q"], [63, "k"]] as [number, string][]) {
    if (m.from === sq || m.to === sq) castling = castling.replace(right, "");
  }
  let ep: number | null = null;
  if (m.flag === "double") {
    // Only record the square when an enemy pawn stands beside it, as most FEN writers do.
    const behind = (m.from + m.to) / 2;
    const f = m.to % 8;
    const enemyPawn = us === "w" ? "p" : "P";
    if ((f > 0 && board[m.to - 1] === enemyPawn) || (f < 7 && board[m.to + 1] === enemyPawn)) ep = behind;
  }
  const isPawn = m.piece.toLowerCase() === "p";
  return {
    board,
    turn: other(us),
    castling,
    ep,
    halfmove: isPawn || m.captured ? 0 : pos.halfmove + 1,
    fullmove: us === "b" ? pos.fullmove + 1 : pos.fullmove,
  };
}

function legalMoves(pos: Position): Move[] {
  return pseudoMoves(pos).filter((m) => !inCheck(makeMove(pos, m), pos.turn));
}

function uciOf(m: Move): string {
  return sqName(m.from) + sqName(m.to) + (m.promotion ?? "");
}

function sanOf(pos: Position, m: Move, legal: Move[]): string {
  let san: string;
  if (m.flag === "castleK") san = "O-O";
  else if (m.flag === "castleQ") san = "O-O-O";
  else {
    const kind = m.piece.toLowerCase();
    const capture = !!m.captured;
    if (kind === "p") {
      san = (capture ? FILES[m.from % 8] + "x" : "") + sqName(m.to);
      if (m.promotion) san += "=" + m.promotion.toUpperCase();
    } else {
      const rivals = legal.filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
      let dis = "";
      if (rivals.length) {
        const sameFile = rivals.some((o) => o.from % 8 === m.from % 8);
        const sameRank = rivals.some((o) => Math.floor(o.from / 8) === Math.floor(m.from / 8));
        if (!sameFile) dis = FILES[m.from % 8];
        else if (!sameRank) dis = String(Math.floor(m.from / 8) + 1);
        else dis = sqName(m.from);
      }
      san = kind.toUpperCase() + dis + (capture ? "x" : "") + sqName(m.to);
    }
  }
  const next = makeMove(pos, m);
  if (inCheck(next, next.turn)) san += legalMoves(next).length ? "+" : "#";
  return san;
}

function insufficientMaterial(pos: Position): boolean {
  const rest: { p: string; sq: number }[] = [];
  pos.board.forEach((p, sq) => {
    if (p && p.toLowerCase() !== "k") rest.push({ p, sq });
  });
  if (rest.length === 0) return true;
  if (rest.length === 1 && "nb".includes(rest[0].p.toLowerCase())) return true;
  // Only bishops left, all on squares of one colour: neither side can mate.
  if (rest.every((x) => x.p.toLowerCase() === "b")) {
    const shade = (sq: number) => ((sq % 8) + Math.floor(sq / 8)) % 2;
    return rest.every((x) => shade(x.sq) === shade(rest[0].sq));
  }
  return false;
}

// The part of a FEN that makes two positions the same for repetition: the
// board, the side to move, castling rights and a capture en passant that is
// actually possible.
function repetitionKey(pos: Position): string {
  const epLive = pos.ep !== null && legalMoves(pos).some((m) => m.flag === "ep");
  return [boardFen(pos), pos.turn, pos.castling || "-", epLive ? sqName(pos.ep!) : "-"].join(" ");
}

// ---------------------------------------------------------------- reading moves

function normalSan(s: string): string {
  return s.replace(/[+#!?]+$/, "").replace(/0/g, "O").replace("=", "")
    .replace(/([a-h][18])([qrbn])$/, (_, sq, p) => sq + p.toUpperCase());
}

function findMove(pos: Position, text: string): Move {
  const raw = String(text ?? "").trim();
  if (!raw) refuse("invalid_args", "Say which move, for example e2e4 or Nf3.");
  const legal = legalMoves(pos);
  const turnName = cap(sideOf(pos.turn));
  const uci = raw.toLowerCase().replace(/[-x ]/g, "").match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
  if (uci) {
    const from = sqIndex(uci[1])!;
    const to = sqIndex(uci[2])!;
    const promo = uci[3];
    const p = pos.board[from];
    if (!p) refuse("invalid_args", `There is no piece on ${uci[1]}.`);
    if (colorOf(p) !== pos.turn) {
      refuse("invalid_args", `The ${pieceName(p)} on ${uci[1]} is not yours to move: it is ${turnName}'s turn.`);
    }
    const matching = legal.filter((m) => m.from === from && m.to === to);
    if (matching.length) {
      if (matching[0].promotion && !promo) {
        refuse("invalid_args", `Say which piece the pawn becomes, for example ${uci[1]}${uci[2]}q for a queen.`);
      }
      const m = matching.find((x) => (x.promotion ?? "") === (promo ?? ""));
      if (m) return m;
      refuse("invalid_args", `Only a pawn reaching the last rank can promote, and only to q, r, b or n.`);
    }
    const pseudo = pseudoMoves(pos).filter((m) => m.from === from && m.to === to);
    if (pseudo.length) {
      if (pseudo[0].flag === "castleK" || pseudo[0].flag === "castleQ") {
        refuse("invalid_args", `${turnName} cannot castle there now.`);
      }
      refuse(
        "invalid_args",
        inCheck(pos, pos.turn)
          ? `${uci[1]}${uci[2]} does not get ${turnName}'s king out of check.`
          : `${uci[1]}${uci[2]} would leave ${turnName}'s king in check.`,
      );
    }
    const kind = p.toLowerCase();
    if (kind === "k" && Math.abs((to % 8) - (from % 8)) === 2 && Math.floor(to / 8) === Math.floor(from / 8)) {
      refuse("invalid_args", castleReason(pos, to > from));
    }
    refuse("invalid_args", `The ${pieceName(p)} on ${uci[1]} cannot move to ${uci[2]}.`);
  }
  const want = normalSan(raw);
  const bySan = legal.filter((m) => normalSan(sanOf(pos, m, legal)) === want);
  if (bySan.length === 1) return bySan[0];
  // Accept a lower-case piece letter too ("nf3"), as long as it is not a pawn move on the b file.
  if (/^[nrqk]/.test(want)) {
    const upper = want[0].toUpperCase() + want.slice(1);
    const again = legal.filter((m) => normalSan(sanOf(pos, m, legal)) === upper);
    if (again.length === 1) return again[0];
  }
  if (want === "O-O" || want === "O-O-O") refuse("invalid_args", castleReason(pos, want === "O-O"));
  refuse("invalid_args", `${raw} is not a legal move for ${turnName} here. Use squares like e2e4, or algebraic like Nf3.`);
}

function castleReason(pos: Position, kingSide: boolean): string {
  const us = pos.turn;
  const who = cap(sideOf(us));
  const right = kingSide ? (us === "w" ? "K" : "k") : (us === "w" ? "Q" : "q");
  if (!pos.castling.includes(right)) {
    return `${who} can no longer castle ${kingSide ? "king" : "queen"}side: the king or that rook has moved.`;
  }
  if (inCheck(pos, us)) return `${who} cannot castle out of check.`;
  const home = us === "w" ? 4 : 60;
  const between = kingSide ? [home + 1, home + 2] : [home - 1, home - 2, home - 3];
  if (between.some((sq) => pos.board[sq])) return `${who} cannot castle while pieces stand between the king and the rook.`;
  return `${who} cannot castle through or into check.`;
}

// ---------------------------------------------------------------- the game

function freshGame(hostSide: Side = "white", startFen = START_FEN): Game {
  return { startFen, hostSide, moves: [], resigned: null };
}

function loadGame(): Game {
  const saved = app.store.get()?.game;
  if (!saved || typeof saved.startFen !== "string" || !Array.isArray(saved.moves)) return freshGame();
  try {
    // Replay rather than trust: a game that no longer replays starts again.
    let pos = parseFen(saved.startFen);
    for (const mv of saved.moves) pos = makeMove(pos, findMove(pos, mv.uci));
    return saved as Game;
  } catch {
    return freshGame();
  }
}

let game: Game = loadGame();

function save() {
  app.store.set({ game });
}

function position(): Position {
  return parseFen(game.moves.length ? game.moves[game.moves.length - 1].fen : game.startFen);
}

function outcome(pos: Position, legal: Move[]) {
  if (game.resigned) {
    const winner = game.resigned === "white" ? "black" : "white";
    return { status: "resigned", winner, reason: `${cap(game.resigned)} resigned` };
  }
  const check = inCheck(pos, pos.turn);
  if (!legal.length) {
    return check
      ? { status: "checkmate", winner: sideOf(other(pos.turn)), reason: "checkmate" }
      : { status: "stalemate", winner: null, reason: "stalemate" };
  }
  if (insufficientMaterial(pos)) return { status: "draw", winner: null, reason: "insufficient material" };
  if (pos.halfmove >= 100) return { status: "draw", winner: null, reason: "the fifty-move rule" };
  const keys = [parseFen(game.startFen), ...game.moves.map((m) => parseFen(m.fen))].map(repetitionKey);
  const now = keys[keys.length - 1];
  if (keys.filter((k) => k === now).length >= 3) return { status: "draw", winner: null, reason: "threefold repetition" };
  return { status: check ? "check" : "playing", winner: null, reason: null };
}

function describe() {
  const pos = position();
  const legal = legalMoves(pos);
  const out = outcome(pos, legal);
  const over = !["playing", "check"].includes(out.status);
  const toMove = sideOf(pos.turn);
  const assistantSide: Side = game.hostSide === "white" ? "black" : "white";
  const toMoveIs = toMove === game.hostSide ? "host" : "assistant";
  let sentence: string;
  if (out.status === "checkmate") sentence = `Checkmate. ${cap(out.winner!)} wins.`;
  else if (out.status === "stalemate") sentence = "Stalemate. The game is a draw.";
  else if (out.status === "draw") sentence = `Draw by ${out.reason}.`;
  else if (out.status === "resigned") sentence = `${out.reason}. ${cap(out.winner!)} wins.`;
  else sentence = `${out.status === "check" ? "Check. " : ""}${cap(toMove)} to move.`;
  const result = !over ? "*" : out.winner === "white" ? "1-0" : out.winner === "black" ? "0-1" : "1/2-1/2";
  const board: string[] = [];
  for (let r = 7; r >= 0; r--) {
    board.push(pos.board.slice(r * 8, r * 8 + 8).map((p) => p ?? ".").join(" "));
  }
  const startPos = parseFen(game.startFen);
  let pgn = "";
  game.moves.forEach((m, i) => {
    const ply = i + (startPos.turn === "b" ? 1 : 0);
    const number = startPos.fullmove + Math.floor(ply / 2);
    if (ply % 2 === 0) pgn += `${pgn ? " " : ""}${number}. ${m.san}`;
    else pgn += i === 0 ? `${number}... ${m.san}` : ` ${m.san}`;
  });
  const last = game.moves[game.moves.length - 1] ?? null;
  return {
    sentence,
    status: out.status,
    over,
    result,
    winner: out.winner,
    reason: out.reason,
    turn: toMove,
    toMoveIs: over ? null : toMoveIs,
    inCheck: out.status === "check" || out.status === "checkmate",
    host: game.hostSide,
    assistant: assistantSide,
    fen: toFen(pos),
    startFen: game.startFen,
    board,
    moveNumber: pos.fullmove,
    moves: game.moves.map((m) => m.san),
    pgn,
    lastMove: last && { uci: last.uci, san: last.san, side: last.side, by: last.by },
    legalMoves: over ? [] : legal.map((m) => ({ uci: uciOf(m), san: sanOf(pos, m, legal) })),
  };
}

function publish() {
  const state = describe();
  app.ui.post({ type: "state", state });
  app.gadget({
    text: state.sentence,
    detail: state.lastMove ? `Last move ${state.lastMove.san}` : `You play ${state.host}`,
  });
  return state;
}

function parseSide(value: unknown, field: string): Side | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const v = String(value).toLowerCase();
  if (v === "white" || v === "w") return "white";
  if (v === "black" || v === "b") return "black";
  refuse("invalid_args", `${field} must be "white" or "black".`);
}

function playMove(text: string, side: Side | undefined, by: "host" | "assistant" | undefined) {
  const before = describe();
  if (before.over) refuse("invalid_args", `The game is over (${before.sentence}) Start a new game to play again.`);
  const pos = position();
  const toMove = sideOf(pos.turn);
  if (side && side !== toMove) refuse("forbidden", `It is ${cap(toMove)}'s turn, not ${cap(side)}'s.`);
  const m = findMove(pos, text);
  const san = sanOf(pos, m, legalMoves(pos));
  const next = makeMove(pos, m);
  const player = by ?? (toMove === game.hostSide ? "host" : "assistant");
  game.moves.push({ uci: uciOf(m), san, side: toMove, by: player, fen: toFen(next) });
  save();
  app.emit("moves", `${cap(toMove)} played ${san}`);
  const state = publish();
  return { played: { uci: uciOf(m), san, side: toMove }, ...state };
}

app.define({
  commands: {
    state() {
      return describe();
    },

    legalMoves({ square }: { square?: string } = {}) {
      const pos = position();
      const state = describe();
      if (state.over) return { turn: state.turn, square: square ?? null, moves: [] };
      const legal = legalMoves(pos);
      let list = legal;
      if (square) {
        const sq = sqIndex(String(square).toLowerCase());
        if (sq === null) refuse("invalid_args", `${square} is not a square. Use a file a-h and a rank 1-8, like e2.`);
        list = legal.filter((m) => m.from === sq);
      }
      return {
        turn: state.turn,
        square: square ?? null,
        moves: list.map((m) => ({
          uci: uciOf(m),
          san: sanOf(pos, m, legal),
          from: sqName(m.from),
          to: sqName(m.to),
          promotion: m.promotion ?? null,
        })),
      };
    },

    move({ move, side }: { move: string; side?: string }) {
      return playMove(move, parseSide(side, "side"), undefined);
    },

    newGame({ hostSide }: { hostSide?: string } = {}) {
      game = freshGame(parseSide(hostSide, "hostSide") ?? game.hostSide);
      save();
      app.emit("moves", "New game");
      return publish();
    },

    loadFen({ fen, hostSide }: { fen: string; hostSide?: string }) {
      const pos = parseFen(fen);
      game = freshGame(parseSide(hostSide, "hostSide") ?? game.hostSide, toFen(pos));
      save();
      app.emit("moves", `Position set: ${game.startFen}`);
      return publish();
    },

    resign({ side }: { side: string }) {
      const s = parseSide(side, "side");
      if (!s) refuse("invalid_args", 'Say which side resigns: "white" or "black".');
      const state = describe();
      if (state.over) refuse("invalid_args", `The game is already over (${state.sentence})`);
      game.resigned = s;
      save();
      app.emit("moves", `${cap(s)} resigned`);
      return publish();
    },
  },

  onOpen({ windowId }: { windowId: string }) {
    app.ui.post({ type: "state", state: describe() }, windowId);
  },

  onMessage({ payload: msg, windowId }: { payload: any; windowId?: string }) {
    // A window connected or reloaded: it keeps nothing of its own.
    if (msg?.type === "__ui_ready") {
      app.ui.post({ type: "state", state: describe() }, windowId);
      return;
    }
    // A window moves the side it plays (the host's unless it chose another),
    // and only on that side's turn.
    if (msg?.type === "move") {
      try {
        const side = parseSide(msg.side, "side") ?? game.hostSide;
        playMove(msg.move, side, side === game.hostSide ? "host" : "assistant");
      } catch (e: any) {
        app.ui.post({ type: "refused", message: e?.message ?? String(e), state: describe() }, windowId);
      }
    }
  },
});
