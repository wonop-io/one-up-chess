// The structured interface an agent uses to play chess in this package.
//
// Reach it from the § console or an agent script as
//   const chess = wm.apps["two-player-game"] as ChessApi;
// or through Wonop's MCP tools `two-player-game-<command>` (same arguments).
//
// Every move goes through one rules engine, whichever way it arrives: the
// board window, a typed move in its panel, or `move` below. An illegal move
// throws and leaves the game exactly as it was.

type ChessSide = "white" | "black";

type ChessStatus =
  | "playing"   // the side to move is not in check
  | "check"     // the side to move is in check and has a legal reply
  | "checkmate" // game over; `winner` is set
  | "stalemate" // game over; a draw
  | "draw"      // game over: threefold repetition, fifty-move rule or insufficient material (`reason`)
  | "resigned"; // game over; `winner` is set

interface ChessMove {
  /** Long algebraic: from square, to square, promotion letter: "e2e4", "e7e8q". */
  uci: string;
  /** Standard algebraic with check marks: "Nf3", "O-O", "exd6", "e8=Q+", "Qh4#". */
  san: string;
}

interface ChessState {
  /** One sentence for a person: "Check. Black to move.", "Checkmate. White wins." */
  sentence: string;
  status: ChessStatus;
  over: boolean;
  /** "*" while playing, else "1-0", "0-1" or "1/2-1/2". */
  result: "*" | "1-0" | "0-1" | "1/2-1/2";
  winner: ChessSide | null;
  /** Why it ended: "checkmate", "stalemate", "threefold repetition", … */
  reason: string | null;
  /** The side to move. */
  turn: ChessSide;
  /** Whose turn it is by role; null once the game is over. */
  toMoveIs: "host" | "assistant" | null;
  inCheck: boolean;
  /** The side the board window plays by default, and the other side. */
  host: ChessSide;
  assistant: ChessSide;
  fen: string;
  /** The position the game started from (the opening, or a loadFen). */
  startFen: string;
  /** Eight ranks, rank 8 first, files a..h separated by spaces; "." is empty,
   *  upper case is White: "r n b q k b n r". */
  board: string[];
  moveNumber: number;
  /** Moves played, in SAN. */
  moves: string[];
  pgn: string;
  lastMove: (ChessMove & { side: ChessSide; by: "host" | "assistant" }) | null;
  /** Every legal move for the side to move; empty once the game is over. */
  legalMoves: ChessMove[];
  /** Set when the saved game could not be fully restored on opening: what
   *  was kept, and that the saved copy was put aside. Otherwise null. */
  restoreNote: string | null;
}

/** A refusal: `code` is "invalid_args" (an illegal or unreadable move, a bad
 *  FEN, the game is over) or "forbidden" (`side` was given and it is not that
 *  side's turn). `message` says what to do instead. The game is unchanged. */
interface ChessRefusal extends Error {
  code: "invalid_args" | "forbidden";
}

interface ChessApi {
  /** The whole game. Changes nothing. */
  state(): Promise<ChessState>;

  /** Legal moves for the side to move; with `square`, only those from it. */
  legalMoves(args?: { square?: string }): Promise<{
    turn: ChessSide;
    square: string | null;
    moves: (ChessMove & { from: string; to: string; promotion: "q" | "r" | "b" | "n" | null })[];
  }>;

  /** Play a move as UCI ("g8f6", "e7e8q") or SAN ("Nf6", "O-O", "exd3", "e1=Q").
   *  Pass `side` so a move sent on the wrong turn is refused rather than played
   *  for the other side. A pawn reaching the last rank must name its piece.
   *  Throws ChessRefusal; on success answers the new state and what was played. */
  move(args: { move: string; side?: ChessSide }): Promise<ChessState & { played: ChessMove & { side: ChessSide } }>;

  /** Start again from the opening. `hostSide` is the side the board window plays. */
  newGame(args?: { hostSide?: ChessSide }): Promise<ChessState>;

  /** Start from a position, for testing a rule. Refuses an impossible one. */
  loadFen(args: { fen: string; hostSide?: ChessSide }): Promise<ChessState>;

  /** End the game for one side. */
  resign(args: { side: ChessSide }): Promise<ChessState>;

  /** Show the game move by move in every board window, `delayMs` per
   *  half-move (100 to 10000, default 1000), then the live position again.
   *  It changes nothing: the game, its moves and its storage stay as they are. */
  replay(args?: { delayMs?: number }): Promise<{ plies: number; delayMs: number; seconds: number }>;

  /** Stop a running replay. */
  stopReplay(): Promise<{ stopped: boolean }>;

  /** The last five games a new game or loadFen replaced, newest first. */
  previousGames(): Promise<{ games: { pgn: string; moves: number; startFen: string; host: ChessSide; result: string }[] }>;
}
