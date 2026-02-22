'use client';

import { useState, useEffect } from 'react';
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
            } else if (error && error.code === 'PGRST116') {
                // Room doesn't exist in DB, create it with new state
                const initialState = { fen: chess.fen(), turn: 'w', upgrades: [], modifiers: {}, walls: {} };
                await supabase.from('games').insert([{ room_code: roomCode, state: initialState }]);
            }
        };

        fetchState();

        // 2. Realtime sync subscription
        const channel = supabase.channel(`room:${roomCode}`)
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
            })
            .subscribe();

        return () => { supabase.removeChannel(channel); };
    }, [roomCode, chess]);

    const handleSquareClick = async (square: string) => {
        // Basic turn enforcement
        if (turn !== playerColor) return;

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
                if (sniperAttacker) {
                    // Execute Sniper ranged kill
                    chess.remove(square as any); // destroy target
                    setSniperAttacker(null);
                    setSelectedSquare(null);
                    // ... trigger sync ...
                    return;
                }

                if (walls[square]) throw new Error("Blocked by Builder Wall");

                const pieceAtSource = chess.get(selectedSquare as any);
                const sourceMod = modifiers[selectedSquare];

                // 2. Validate standard move via chess.js
                const move = chess.move({
                    from: selectedSquare,
                    to: square,
                    promotion: 'q'
                });

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
                    } else if (sourceMod.type === 'necromancer' && move.captured) {
                        chess.put({ type: 'p', color: playerColor }, selectedSquare as any); // Spawn pawn
                    } else if (sourceMod.type === 'builder') {
                        walls[selectedSquare] = 2; // spawn wall for 2 turns
                    }
                    if (keepModifier) {
                        nextModifiers[square] = sourceMod;
                    }
                }

                // Did we land on an upgrade?
                let nextUpgrades = [...upgrades];
                const consumedIndex = nextUpgrades.findIndex(u => u.x === fileIndex && u.y === 7 - rankIndex);

                if (consumedIndex !== -1) {
                    const upgrade = nextUpgrades[consumedIndex];
                    nextUpgrades.splice(consumedIndex, 1);
                    // Apply modifier (overwrites previous if any)
                    nextModifiers[square] = { type: upgrade.type, activeTurn: chess.turn() };
                    console.log(`Picked up ${upgrade.type}!`);
                }

                // Process End-of-Turn spawns and movements for existing upgrades
                nextUpgrades = processEndTurnSpawnsAndMoves(chess, nextUpgrades);

                // Optimistic update
                setBoard(chess.board());
                setTurn(currentTurn as 'w' | 'b');
                setSelectedSquare(null);
                setUpgrades(nextUpgrades);
                setModifiers(nextModifiers);

                // Sync with db
                const newState = {
                    fen: chess.fen(),
                    turn: currentTurn,
                    upgrades: nextUpgrades,
                    modifiers: nextModifiers,
                    walls
                };

                await supabase
                    .from('games')
                    .update({ state: newState })
                    .eq('room_code', roomCode);

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
                setSelectedSquare(square);
            }
        }
    };

    const isSquareHighlighted = (sq: string) => {
        if (sq === selectedSquare) return true;
        // We could add highlighted moves here
        return false;
    };

    return (
        <div className="flex flex-col items-center select-none font-mono">
            <div className="bg-black p-4 border-2 border-green-500 shadow-[0_0_20px_rgba(74,222,128,0.2)]">
                <div className="grid grid-cols-8 grid-rows-8 gap-0 border border-green-900 bg-black w-[600px] h-[600px]">
                    {board.map((row, i) =>
                        row.map((piece, j) => {
                            // Standard chess logic, top-left is a8. i=0, j=0 is a8
                            const rank = 8 - i;
                            const file = String.fromCharCode('a'.charCodeAt(0) + j);
                            const squareName = `${file}${rank}`;
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
                                        <div className="absolute top-1 right-1 bg-green-500 text-[10px] text-black px-1.5 py-0.5 font-bold shadow-md uppercase z-20">
                                            {sqMod.type.substring(0, 3)}
                                        </div>
                                    )}
                                    {/* Glitch Mystery Upgrade Entity Display */}
                                    {upgrades.find(u => u.x === j && u.y === i) && (
                                        <div className="absolute inset-0 flex items-center justify-center z-0 pointer-events-none">
                                            <div className="animate-pulse flex items-center justify-center text-2xl font-black text-green-400 drop-shadow-[0_0_10px_rgba(74,222,128,0.8)] opacity-70">
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
            <div className="mt-6 flex justify-between w-full max-w-[600px] text-green-700 font-mono text-sm uppercase tracking-widest">
                <div>&gt; PLAYER: {playerColor === 'w' ? 'WHITE_SYS' : 'BLACK_SYS'}</div>
                <div>&gt; STAT: {turn === playerColor ? <span className="text-green-400 animate-pulse">AWAITING_INPUT</span> : <span className="text-green-900">PROCESSING_OPPONENT...</span>}</div>
            </div>
        </div>
    );
}
