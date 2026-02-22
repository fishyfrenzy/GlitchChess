'use client';

import { useState, useEffect, useRef } from 'react';
import { Chess } from 'chess.js';
import { supabase } from '@/lib/supabase';
import { processEndTurnSpawnsAndMoves, UpgradeEntity } from '@/lib/gameLogic';

// Unicode chess pieces mapping
const PIECE_SYMBOLS: Record<string, string> = {
    p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
    P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔'
};

export default function ChessGame({ roomCode, playerColor }: { roomCode: string, playerColor: 'w' | 'b' }) {
    const [chess] = useState(new Chess());
    const [board, setBoard] = useState(chess.board());
    const [turn, setTurn] = useState<'w' | 'b'>('w');

    // Custom game state
    const [upgrades, setUpgrades] = useState<any[]>([]);
    const [modifiers, setModifiers] = useState<Record<string, any>>({});
    const [selectedSquare, setSelectedSquare] = useState<string | null>(null);

    // Special Modifier UI States
    const [awaitingSwapSource, setAwaitingSwapSource] = useState<string | null>(null);
    const [sniperAttacker, setSniperAttacker] = useState<string | null>(null);
    const [walls, setWalls] = useState<Record<string, number>>({}); // square -> turns_left
    const [timeConfig, setTimeConfig] = useState({ base: 300, increment: 3 });
    const [timeLeft, setTimeLeft] = useState({ w: 300, b: 300 });
    const [lastMoveTime, setLastMoveTime] = useState<number | null>(null);

    // Channel ref for broadcasting
    const channelRef = useRef<any>(null);

    useEffect(() => {
        // 1. Fetch initial state (this assumes the table exists and allows select)
        const fetchState = async () => {
            const { data, error } = await supabase
                .from('games')
                .select('state')
                .eq('room_code', roomCode)
                .single();

            if (data?.state) {
                if (data.state.fen) {
                    try { chess.load(data.state.fen); } catch (e) { }
                }
                setBoard(chess.board());
                setTurn(data.state.turn || 'w');
                setUpgrades(data.state.upgrades || []);
                setModifiers(data.state.modifiers || {});
                setWalls(data.state.walls || {});
                if (data.state.timeConfig) setTimeConfig(data.state.timeConfig);
                if (data.state.timeLeft) setTimeLeft(data.state.timeLeft);
                if (data.state.lastMoveTime) setLastMoveTime(data.state.lastMoveTime);
            } else if (error && error.code === 'PGRST116') {
                // Should not happen now since RoomPage initializes, but fallback
                const initialState = { fen: chess.fen(), turn: 'w', upgrades: [], modifiers: {}, walls: {} };
                await supabase.from('games').insert([{ room_code: roomCode, state: initialState }]);
            }
        };

        fetchState();

        // 2. Realtime sync subscription (Broadcast + Postgres Fallback)
        const channel = supabase.channel(`room:${roomCode}`, {
            config: { broadcast: { self: false } }
        })
            .on('broadcast', { event: 'game_update' }, (payload) => {
                const { state } = payload.payload;
                if (state.fen) {
                    try { chess.load(state.fen); } catch (e) { }
                }
                setBoard(chess.board());
                setTurn(state.turn);
                setUpgrades(state.upgrades || []);
                setModifiers(state.modifiers || {});
                setWalls(state.walls || {});
                if (state.timeLeft) setTimeLeft(state.timeLeft);
                if (state.lastMoveTime) setLastMoveTime(state.lastMoveTime);
            })
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'games',
                filter: `room_code=eq.${roomCode}`
            }, (payload) => {
                const { state } = payload.new;
                if (state.fen) {
                    try { chess.load(state.fen); } catch (e) { }
                }
                setBoard(chess.board());
                setTurn(state.turn);
                setUpgrades(state.upgrades || []);
                setModifiers(state.modifiers || {});
                setWalls(state.walls || {});
                if (state.timeLeft) setTimeLeft(state.timeLeft);
                if (state.lastMoveTime) setLastMoveTime(state.lastMoveTime);
            })
            .subscribe();

        channelRef.current = channel;

        return () => {
            supabase.removeChannel(channel);
            channelRef.current = null;
        };
    }, [roomCode, chess]);

    useEffect(() => {
        // Visual ticks
        const interval = setInterval(() => {
            if (lastMoveTime) {
                // We tick locally, but we don't sync this DB directly.
                // Re-calculate based on Date.now() - lastMoveTime
                const elapsedSeconds = Math.floor((Date.now() - lastMoveTime) / 1000);
                setTimeLeft(prev => ({
                    ...prev,
                    [turn]: Math.max(0, prev[turn] - 1)
                }));
            }
        }, 1000);

        return () => clearInterval(interval);
    }, [lastMoveTime, turn]);

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    const MODIFIER_DESCRIPTIONS: Record<string, string> = {
        'double_move': 'x2 MOVE: Move twice in one turn!',
        'martyrdom': 'MARTYR: Explodes on capture killing attacker',
        'hidden_move': 'STEALTH: Next move is invisible to enemy',
        'swap': 'SWAP: Swap places with any friendly piece',
        'ghost': 'GHOST: Pass through walls and pieces (1 turn)',
        'necromancer': 'NECRO: Spawns friendly pawn on capture',
        'sniper': 'SNIPER: Ranged kill without moving',
        'builder': 'BUILDER: Drops a 2-turn impenetrable wall',
        'time_add': '+1 MINUTE: Adds 60 seconds to your clock',
        'time_sub': '-1 MINUTE: Removes 60 seconds from opponent'
    };

    const handleSquareClick = async (square: string) => {
        // Basic turn enforcement
        if (turn !== playerColor) return;
        if (timeLeft[playerColor] <= 0) return; // Out of time!

        // Compute elapsed time logic before doing anything
        const now = Date.now();
        let currentElapsedSeconds = 0;
        if (lastMoveTime) {
            currentElapsedSeconds = Math.floor((now - lastMoveTime) / 1000);
        }

        if (selectedSquare) {
            if (selectedSquare === square) {
                setSelectedSquare(null); // deselect
                return;
            }

            // Default try move
            try {
                const fileChars = 'abcdefgh';
                const fileIndex = fileChars.indexOf(square[0]);
                const rankIndex = parseInt(square[1]) - 1;

                // --- PRE-MOVE MODIFIER CHECKS (Sniper, Swap, Obstacles) ---
                if (awaitingSwapSource) {
                    const targetPiece = chess.get(square as any);
                    if (targetPiece && targetPiece.color === playerColor && square !== awaitingSwapSource) {
                        // Execute Swap
                        const p1 = chess.get(awaitingSwapSource as any);
                        const p2 = chess.get(square as any);
                        chess.remove(awaitingSwapSource as any);
                        chess.remove(square as any);
                        if (p1) chess.put(p1, square as any);
                        if (p2) chess.put(p2, awaitingSwapSource as any);

                        setAwaitingSwapSource(null);
                        setSelectedSquare(null);

                        // swap modifiers if any
                        const nextModifiers = { ...modifiers };
                        let fen = chess.fen();
                        let currentTurn = chess.turn();

                        const p1Mod = nextModifiers[awaitingSwapSource];
                        const p2Mod = nextModifiers[square];

                        if (p1Mod) nextModifiers[square] = p1Mod; else delete nextModifiers[square];
                        if (p2Mod) nextModifiers[awaitingSwapSource] = p2Mod; else delete nextModifiers[awaitingSwapSource];

                        // Process End-of-Turn spawns and movements for existing upgrades
                        const nextUpgrades = processEndTurnSpawnsAndMoves(chess, upgrades);

                        // Sync with db
                        const newState = {
                            fen: chess.fen(),
                            turn: currentTurn,
                            upgrades: nextUpgrades,
                            modifiers: nextModifiers,
                            walls
                        };

                        setBoard(chess.board());
                        setUpgrades(nextUpgrades);
                        setModifiers(nextModifiers);

                        await supabase
                            .from('games')
                            .update({ state: newState })
                            .eq('room_code', roomCode);

                        if (channelRef.current) {
                            channelRef.current.send({
                                type: 'broadcast',
                                event: 'game_update',
                                payload: { state: newState }
                            });
                        }
                        return;
                    } else {
                        throw new Error("Invalid swap target");
                    }
                }

                if (sniperAttacker) {
                    const targetPiece = chess.get(square as any);
                    if (targetPiece && targetPiece.color !== playerColor) {
                        // Validate range (e.g. within 3 squares distance, max(dx, dy) <= 3)
                        const sX = sniperAttacker.charCodeAt(0);
                        const sY = parseInt(sniperAttacker[1]);
                        const tX = square.charCodeAt(0);
                        const tY = parseInt(square[1]);

                        if (Math.max(Math.abs(sX - tX), Math.abs(sY - tY)) <= 3) {
                            // Execute Sniper ranged kill
                            chess.remove(square as any); // destroy target

                            // remove sniper modifier from attacker
                            const nextModifiers = { ...modifiers };
                            delete nextModifiers[sniperAttacker];

                            setSniperAttacker(null);
                            setSelectedSquare(null);

                            let currentTurn = chess.turn();
                            let fen = chess.fen();
                            fen = fen.replace(` ${currentTurn} `, ` ${currentTurn === 'w' ? 'b' : 'w'} `);
                            currentTurn = currentTurn === 'w' ? 'b' : 'w';
                            chess.load(fen);

                            // Process End-of-Turn spawns and movements for existing upgrades
                            const nextUpgrades = processEndTurnSpawnsAndMoves(chess, upgrades);

                            // Sync
                            const newState = {
                                fen: chess.fen(),
                                turn: currentTurn,
                                upgrades: nextUpgrades,
                                modifiers: nextModifiers,
                                walls
                            };

                            setBoard(chess.board());
                            setTurn(currentTurn as 'w' | 'b');
                            setUpgrades(nextUpgrades);
                            setModifiers(nextModifiers);

                            await supabase
                                .from('games')
                                .update({ state: newState })
                                .eq('room_code', roomCode);

                            if (channelRef.current) {
                                channelRef.current.send({
                                    type: 'broadcast',
                                    event: 'game_update',
                                    payload: { state: newState }
                                });
                            }
                            return;
                        } else {
                            throw new Error("Target out of range for Sniper");
                        }
                    } else {
                        throw new Error("Invalid sniper target");
                    }
                }

                if (walls[square]) throw new Error("Blocked by Builder Wall");

                const pieceAtSource = chess.get(selectedSquare as any);
                const sourceMod = modifiers[selectedSquare];

                // Ghost move override check
                if (sourceMod && sourceMod.type === 'ghost') {
                    // Temporarily check if move is valid geometrically
                    const fen = chess.fen();
                    const squaresToRemove = [];
                    for (let r = 0; r < 8; r++) {
                        for (let c = 0; c < 8; c++) {
                            const sq = String.fromCharCode(97 + c) + (8 - r);
                            if (sq === selectedSquare || sq === square) continue;
                            const p = chess.get(sq as any);
                            if (p && p.type !== 'k') squaresToRemove.push(sq);
                        }
                    }
                    for (const sq of squaresToRemove) chess.remove(sq as any);

                    let validGhost = false;
                    try {
                        if (chess.move({ from: selectedSquare, to: square, promotion: 'q' })) {
                            validGhost = true;
                        }
                    } catch (e) { }

                    chess.load(fen); // restore

                    if (!validGhost) throw new Error("Invalid ghost move");

                    // Manually execute ghost move
                    const piece = chess.get(selectedSquare as any);
                    chess.remove(selectedSquare as any);
                    if (chess.get(square as any)) chess.remove(square as any); // capture
                    if (piece) chess.put(piece, square as any);

                    // Manually swap turn
                    const fenTokens = chess.fen().split(' ');
                    fenTokens[1] = fenTokens[1] === 'w' ? 'b' : 'w';
                    fenTokens[3] = '-'; // clear en passant
                    chess.load(fenTokens.join(' '));

                    // We don't need to define `move` since we manually applied it, 
                    // but we need to satisfy Necromancer compile checks below if combined
                    // So we do:
                } else {
                    // 2. Validate standard move via chess.js
                    const move = chess.move({
                        from: selectedSquare,
                        to: square,
                        promotion: 'q'
                    });
                }

                // --- POST-MOVE MODIFIER CHECKS (Necromancer, Martyrdom, Builder, Double Move) ---
                let fen = chess.fen();
                let currentTurn = chess.turn();
                let nextModifiers = { ...modifiers };

                // 1. Transfer existing modifier to the new square (before checking new pickups)
                if (sourceMod) {
                    delete nextModifiers[selectedSquare];
                    let keepModifier = true;
                    if (sourceMod.type === 'double_move') {
                        // Revert turn in FEN
                        fen = fen.replace(` ${currentTurn} `, ` ${currentTurn === 'w' ? 'b' : 'w'} `);
                        currentTurn = currentTurn === 'w' ? 'b' : 'w';
                        chess.load(fen);
                        keepModifier = false; // consume
                    } else if (sourceMod.type === 'ghost') {
                        keepModifier = false; // consume after 1 turn
                    } else if (sourceMod.type === 'necromancer' && !chess.get(square as any)) { // hacky capture check since move var is scoped out
                        // If it was a capture, the target square had an enemy before we manually or naturally moved.
                        // Actually a proper check: we compare fen pieces. But for now...
                        // chess.put({ type: 'p', color: playerColor }, selectedSquare as any); // Spawn pawn
                    } else if (sourceMod.type === 'builder') {
                        walls[selectedSquare] = 2; // spawn wall for 2 turns
                    }
                    if (keepModifier) {
                        nextModifiers[square] = sourceMod;
                    }
                }

                let nextTimeLeft = { ...timeLeft };
                // Calculate actual consumed time
                if (lastMoveTime) {
                    nextTimeLeft[playerColor] = Math.max(0, nextTimeLeft[playerColor] - currentElapsedSeconds);
                }

                // Did we land on an upgrade?
                let nextUpgrades = [...upgrades];
                const consumedIndex = nextUpgrades.findIndex(u => u.x === fileIndex && u.y === 7 - rankIndex);

                if (consumedIndex !== -1) {
                    const upgrade = nextUpgrades[consumedIndex];
                    nextUpgrades.splice(consumedIndex, 1);

                    if (upgrade.type === 'swap') {
                        // Immediately enter swap state, revert turn!
                        console.log("Entering SWAP mode!");
                        setAwaitingSwapSource(square);
                        fen = fen.replace(` ${currentTurn} `, ` ${currentTurn === 'w' ? 'b' : 'w'} `);
                        currentTurn = currentTurn === 'w' ? 'b' : 'w';
                        chess.load(fen);
                        // don't process end turn spawns yet!
                        setBoard(chess.board());
                        setTurn(currentTurn as 'w' | 'b');
                        setSelectedSquare(null);
                        setUpgrades(nextUpgrades);
                        setModifiers(nextModifiers);
                        return; // return early!
                    } else {
                        // Apply modifier (overwrites previous if any)
                        nextModifiers[square] = { type: upgrade.type, activeTurn: chess.turn() };
                        console.log(`Picked up ${upgrade.type}!`);
                    }
                }

                // Process time upgrades
                if (nextModifiers[square] && nextModifiers[square].type === 'time_add') {
                    nextTimeLeft[playerColor] += 60;
                    delete nextModifiers[square]; // consume instantly
                } else if (nextModifiers[square] && nextModifiers[square].type === 'time_sub') {
                    const opponent = playerColor === 'w' ? 'b' : 'w';
                    nextTimeLeft[opponent] = Math.max(0, nextTimeLeft[opponent] - 60);
                    delete nextModifiers[square]; // consume instantly
                }

                if (currentTurn !== turn) {
                    // Turn advanced! Add increment
                    nextTimeLeft[playerColor] += timeConfig.increment;
                }

                // Process End-of-Turn spawns and movements for existing upgrades
                nextUpgrades = processEndTurnSpawnsAndMoves(chess, nextUpgrades);

                // Optimistic update
                setBoard(chess.board());
                setTurn(currentTurn as 'w' | 'b');
                setSelectedSquare(null);
                setUpgrades(nextUpgrades);
                setModifiers(nextModifiers);
                setTimeLeft(nextTimeLeft);
                setLastMoveTime(Date.now());

                // Sync with db
                const newState = {
                    fen: chess.fen(),
                    turn: currentTurn,
                    upgrades: nextUpgrades,
                    modifiers: nextModifiers,
                    walls,
                    timeConfig,
                    timeLeft: nextTimeLeft,
                    lastMoveTime: Date.now()
                };

                await supabase
                    .from('games')
                    .update({ state: newState })
                    .eq('room_code', roomCode);

                if (channelRef.current) {
                    channelRef.current.send({
                        type: 'broadcast',
                        event: 'game_update',
                        payload: { state: newState }
                    });
                }

            } catch (e) {
                console.log("Invalid move to", square);
                // It's invalid, maybe clicked another friendly piece? Select that one instead
                const piece = chess.get(square as any);
                if (piece && piece.color === playerColor) {
                    setSelectedSquare(square);
                } else {
                    setSelectedSquare(null);
                }
            }
        } else {
            // Trying to select a piece
            const piece = chess.get(square as any);
            if (piece && piece.color === playerColor) {
                // If this piece has the sniper mod, enter sniper mode immediately?
                // Or let them move normally OR click enemy to snipe.
                // We'll set it as selected, and if they click an enemy next, the `sniperAttacker` logic takes over.
                // Actually, let's explicitly enter sniper mode to show range.
                if (modifiers[square]?.type === 'sniper') {
                    console.log("Entering SNIPER mode");
                    setSniperAttacker(square);
                    setSelectedSquare(square); // also select it
                } else {
                    setSelectedSquare(square);
                    setSniperAttacker(null); // clear sniper if selecting another
                }
            }
        }
    };

    const isSquareHighlighted = (sq: string) => {
        if (sq === selectedSquare) return true;

        if (sniperAttacker) {
            // highlight valid targets (enemies within 3 range)
            const sX = sniperAttacker.charCodeAt(0);
            const sY = parseInt(sniperAttacker[1]);
            const tX = sq.charCodeAt(0);
            const tY = parseInt(sq[1]);
            if (Math.max(Math.abs(sX - tX), Math.abs(sY - tY)) <= 3) {
                const targetPiece = chess.get(sq as any);
                if (targetPiece && targetPiece.color !== playerColor) {
                    return true; // Highlight in red/different color ideally, but we'll return true for now
                }
            }
        }

        return false;
    };

    return (
        <div className="flex flex-col items-center select-none font-mono">
            <div className="bg-black p-4 border-2 border-green-500 shadow-[0_0_20px_rgba(74,222,128,0.2)]">
                <div className="grid grid-cols-8 grid-rows-8 gap-0 border border-green-900 bg-black w-[600px] h-[600px]">
                    {Array.from({ length: 8 }).map((_, displayRow) =>
                        Array.from({ length: 8 }).map((_, displayCol) => {
                            // Standard chess logic, top-left is a8. i=0, j=0 is a8
                            // If player is white, we iterate i from 0..7 and j from 0..7
                            // If player is black, we iterate i from 7..0 and j from 7..0 to flip the board
                            const i = playerColor === 'w' ? displayRow : 7 - displayRow;
                            const j = playerColor === 'w' ? displayCol : 7 - displayCol;

                            const piece = board[i][j];
                            const rank = 8 - i;
                            const file = String.fromCharCode('a'.charCodeAt(0) + j);
                            const squareName = `${file}${rank}`;
                            // The actual dark square coloring is based on chess coordinates: 
                            // e.g., a8 (i=0, j=0) is light (0+0=0: even).
                            const isDark = (i + j) % 2 === 1;
                            const sqMod = modifiers[squareName];

                            return (
                                <div
                                    key={squareName}
                                    onClick={() => handleSquareClick(squareName)}
                                    className={`flex items-center justify-center text-5xl w-full h-full cursor-pointer transition-colors duration-200 relative
                    ${isDark ? 'bg-green-950 text-green-300' : 'bg-black text-green-500'}
                    ${isSquareHighlighted(squareName) ? 'ring-2 ring-inset ring-green-400 bg-green-900/50' : ''}
                  `}
                                >
                                    {piece && (
                                        <span
                                            className={`
                        z-10 select-none drop-shadow-[0_0_5px_currentColor]
                        ${piece.color === 'w' ? 'text-green-100' : 'text-green-600'}
                      `}
                                        >
                                            {PIECE_SYMBOLS[piece.color === 'w' ? piece.type.toUpperCase() : piece.type]}
                                        </span>
                                    )}
                                    {/* Active Modifier Badge ON the piece */}
                                    {sqMod && (
                                        <div
                                            title={MODIFIER_DESCRIPTIONS[sqMod.type] || sqMod.type}
                                            className="absolute top-1 right-1 bg-green-500 text-[10px] text-black px-1.5 py-0.5 font-bold shadow-md uppercase z-20 hover:scale-125 transition-transform cursor-help"
                                        >
                                            {sqMod.type.substring(0, 3)}
                                        </div>
                                    )}
                                    {/* Glitch Mystery Upgrade Entity Display */}
                                    {upgrades.find(u => u.x === j && u.y === i) && (
                                        <div
                                            title={MODIFIER_DESCRIPTIONS[upgrades.find(u => u.x === j && u.y === i)!.type] || 'Mystery Upgrade'}
                                            className="absolute inset-0 flex items-center justify-center z-0 cursor-help"
                                        >
                                            <div className="animate-pulse flex items-center justify-center text-2xl font-black text-green-400 drop-shadow-[0_0_10px_rgba(74,222,128,0.8)] opacity-70 hover:scale-110 transition-transform">
                                                [?]
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
            <div className="mt-4 flex justify-between w-full max-w-[600px] text-green-700 font-mono text-sm uppercase tracking-widest bg-green-950/20 p-2 border border-green-900/50">
                <div className="flex gap-4">
                    <span className={turn === 'w' ? 'text-green-400 font-bold' : ''}>W: {formatTime(timeLeft.w)}</span>
                    <span className={turn === 'b' ? 'text-green-400 font-bold' : ''}>B: {formatTime(timeLeft.b)}</span>
                </div>
                <div>+ {timeConfig.increment}s</div>
            </div>
            <div className="mt-2 flex justify-between w-full max-w-[600px] text-green-700 font-mono text-sm uppercase tracking-widest">
                <div>&gt; PLAYER: {playerColor === 'w' ? 'WHITE_SYS' : 'BLACK_SYS'}</div>
                <div>&gt; STAT: {turn === playerColor ? <span className="text-green-400 animate-pulse">AWAITING_INPUT</span> : <span className="text-green-900">PROCESSING_OPPONENT...</span>}</div>
            </div>
        </div>
    );
}
