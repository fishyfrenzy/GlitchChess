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
    const [builderActive, setBuilderActive] = useState<{ source: string, placed: string[] } | null>(null);
    const [walls, setWalls] = useState<Record<string, number>>({}); // square -> turns_left
    const [winner, setWinner] = useState<'w' | 'b' | null>(null);
    const [timeConfig, setTimeConfig] = useState({ base: 300, increment: 3 });
    const [timeLeft, setTimeLeft] = useState({ w: 300, b: 300 });
    const [lastMoveTime, setLastMoveTime] = useState<number | null>(null);
    const [history, setHistory] = useState<any[]>([]);
    const [viewingHistoryIndex, setViewingHistoryIndex] = useState<number | null>(null);

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
                setHistory(data.state.history || []);
                setWinner(data.state.winner || null);
                if (data.state.timeConfig) setTimeConfig(data.state.timeConfig);
                if (data.state.timeLeft) setTimeLeft(data.state.timeLeft);
                if (data.state.lastMoveTime) setLastMoveTime(data.state.lastMoveTime);
            } else if (error && error.code === 'PGRST116') {
                // Should not happen now since RoomPage initializes, but fallback
                const initialState = { fen: chess.fen(), turn: 'w', upgrades: [], modifiers: {}, walls: {}, history: [], winner: null };
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
                setHistory(state.history || []);
                setWinner(state.winner || null);
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
                setHistory(state.history || []);
                setWinner(state.winner || null);
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

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (history.length === 0) return;

            if (e.key === 'ArrowLeft') {
                setViewingHistoryIndex(prev => {
                    const currentIndex = prev === null ? history.length - 1 : prev;
                    return Math.max(0, currentIndex - 1);
                });
            } else if (e.key === 'ArrowRight') {
                setViewingHistoryIndex(prev => {
                    if (prev === null) return null;
                    const nextIndex = prev + 1;
                    if (nextIndex >= history.length - 1) return null; // back to present
                    return nextIndex;
                });
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [history]);

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
        'builder': 'BUILDER: Active - Place 3 walls anywhere (1 turn)',
        'time_add': '+30 SECONDS: Adds 30s to your clock',
        'time_sub': '-15 SECONDS: Removes 15s from opponent'
    };

    const playSound = (type: 'move' | 'capture' | 'upgrade' | 'error') => {
        try {
            const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            if (type === 'move') {
                osc.type = 'sine';
                osc.frequency.setValueAtTime(400, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.1);
                gain.gain.setValueAtTime(0.1, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
                osc.start();
                osc.stop(ctx.currentTime + 0.1);
            } else if (type === 'capture') {
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(150, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.15);
                gain.gain.setValueAtTime(0.2, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
                osc.start();
                osc.stop(ctx.currentTime + 0.15);
            } else if (type === 'upgrade') {
                osc.type = 'square';
                osc.frequency.setValueAtTime(400, ctx.currentTime);
                osc.frequency.setValueAtTime(600, ctx.currentTime + 0.1);
                osc.frequency.setValueAtTime(800, ctx.currentTime + 0.2);
                gain.gain.setValueAtTime(0.1, ctx.currentTime);
                gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
                osc.start();
                osc.stop(ctx.currentTime + 0.3);
            } else if (type === 'error') {
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(100, ctx.currentTime);
                gain.gain.setValueAtTime(0.2, ctx.currentTime);
                gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
                osc.start();
                osc.stop(ctx.currentTime + 0.2);
            }
        } catch (e) {
            // ignore audio
        }
    };

    const handleSquareClick = async (square: string) => {
        // Prevent moves while viewing history or if game over
        if (viewingHistoryIndex !== null) return;
        if (winner) return;

        // Basic turn enforcement
        if (turn !== playerColor) return;
        if (timeLeft[playerColor] <= 0) return; // Out of time!

        // Compute elapsed time logic before doing anything
        const now = Date.now();
        let currentElapsedSeconds = 0;
        if (lastMoveTime) {
            currentElapsedSeconds = Math.floor((now - lastMoveTime) / 1000);
        }

        // --- WALL DECAY HELPER ---
        const decayWalls = (w: Record<string, number>) => {
            const next = { ...w };
            for (const sq in next) {
                next[sq] -= 1;
                if (next[sq] <= 0) delete next[sq];
            }
            return next;
        };

        if (selectedSquare) {
            if (selectedSquare === square) {
                setSelectedSquare(null); // deselect
                if (builderActive) setBuilderActive(null);
                setAwaitingSwapSource(null);
                setSniperAttacker(null);
                return;
            }

            // Default try move
            try {
                const fileChars = 'abcdefgh';
                const fileIndex = fileChars.indexOf(square[0]);
                const rankIndex = parseInt(square[1]) - 1;

                // --- PRE-MOVE MODIFIER CHECKS (Sniper, Swap, Builder, Obstacles) ---
                if (builderActive) {
                    if (chess.get(square as any) || walls[square]) {
                        playSound('error');
                        return; // must place on empty transparent square
                    }

                    const newPlaced = [...builderActive.placed, square];
                    if (newPlaced.length < 3) {
                        playSound('move');
                        setBuilderActive({ ...builderActive, placed: newPlaced });
                        return; // keep waiting
                    }

                    // 3rd wall placed! Execute the turn.
                    const nextWalls = decayWalls(walls);
                    newPlaced.forEach(sq => nextWalls[sq] = 2); // 2 half-moves wall

                    const nextModifiers = { ...modifiers };
                    delete nextModifiers[builderActive.source]; // consume ability

                    let currentTurn = chess.turn();
                    let fen = chess.fen();
                    fen = fen.replace(` ${currentTurn} `, ` ${currentTurn === 'w' ? 'b' : 'w'} `);
                    currentTurn = currentTurn === 'w' ? 'b' : 'w';
                    chess.load(fen);

                    // Process End-of-Turn spawns and movements for existing upgrades
                    const nextUpgrades = processEndTurnSpawnsAndMoves(chess, upgrades);

                    const moveText = `${playerColor === 'w' ? 'W' : 'B'}: [BUILDER] 🧱x3`;
                    playSound('upgrade');
                    const nextHistory = [...history, { fen: chess.fen(), upgrades: nextUpgrades, modifiers: nextModifiers, walls: nextWalls, text: moveText }];
                    setHistory(nextHistory);

                    // Sync
                    const newState = {
                        fen: chess.fen(),
                        turn: currentTurn,
                        upgrades: nextUpgrades,
                        modifiers: nextModifiers,
                        walls: nextWalls,
                        history: nextHistory,
                        winner,
                        timeConfig,
                        timeLeft,
                        lastMoveTime: Date.now()
                    };

                    setBoard(chess.board());
                    setTurn(currentTurn as 'w' | 'b');
                    setSelectedSquare(null);
                    setBuilderActive(null);
                    setUpgrades(nextUpgrades);
                    setModifiers(nextModifiers);
                    setWalls(nextWalls);

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
                }

                if (awaitingSwapSource) {
                    const targetPiece = chess.get(square as any);
                    if (targetPiece && targetPiece.color === playerColor && square !== awaitingSwapSource) {
                        // Execute Swap
                        const nextWalls = decayWalls(walls);
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
                        let currentTurn = chess.turn();
                        let fen = chess.fen();
                        fen = fen.replace(` ${currentTurn} `, ` ${currentTurn === 'w' ? 'b' : 'w'} `);
                        currentTurn = currentTurn === 'w' ? 'b' : 'w';
                        chess.load(fen);

                        const p1Mod = nextModifiers[awaitingSwapSource];
                        const p2Mod = nextModifiers[square];

                        if (p1Mod) nextModifiers[square] = p1Mod; else delete nextModifiers[square];
                        if (p2Mod) nextModifiers[awaitingSwapSource] = p2Mod; else delete nextModifiers[awaitingSwapSource];

                        // Process End-of-Turn spawns and movements for existing upgrades
                        const nextUpgrades = processEndTurnSpawnsAndMoves(chess, upgrades);

                        const moveText = `${playerColor === 'w' ? 'W' : 'B'}: [SWAP] ${awaitingSwapSource} ⇄ ${square}`;
                        playSound('upgrade');
                        const nextHistory = [...history, { fen: chess.fen(), upgrades: nextUpgrades, modifiers: nextModifiers, walls: nextWalls, text: moveText }];
                        setHistory(nextHistory);

                        // Sync with db
                        const newState = {
                            fen: chess.fen(),
                            turn: currentTurn,
                            upgrades: nextUpgrades,
                            modifiers: nextModifiers,
                            walls: nextWalls,
                            history: nextHistory,
                            winner,
                            timeConfig,
                            timeLeft,
                            lastMoveTime: Date.now()
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
                        playSound('error');
                        return; // invalid target, just ignore so they can click again
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

                            const nextWalls = decayWalls(walls);
                            let nextWinner: 'w' | 'b' | null = winner;

                            // Execute Sniper ranged kill
                            if (targetPiece.type === 'k') {
                                nextWinner = playerColor as 'w' | 'b';
                            } else {
                                chess.remove(square as any); // destroy target
                            }

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

                            const moveText = `${playerColor === 'w' ? 'W' : 'B'}: [SNIPER] 🎯 ${square}`;
                            playSound('capture');
                            const nextHistory = [...history, { fen: chess.fen(), upgrades: nextUpgrades, modifiers: nextModifiers, walls: nextWalls, text: moveText }];
                            setHistory(nextHistory);

                            if (nextWinner) setWinner(nextWinner);

                            // Sync
                            const newState = {
                                fen: chess.fen(),
                                turn: currentTurn,
                                upgrades: nextUpgrades,
                                modifiers: nextModifiers,
                                walls: nextWalls,
                                history: nextHistory,
                                winner: nextWinner,
                                timeConfig,
                                timeLeft,
                                lastMoveTime: Date.now()
                            };

                            setBoard(chess.board());
                            setTurn(currentTurn as 'w' | 'b');
                            setUpgrades(nextUpgrades);
                            setModifiers(nextModifiers);
                            setWalls(nextWalls);

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
                            playSound('error');
                            return; // invalid range, ignore
                        }
                    } else {
                        playSound('error');
                        return; // invalid target, ignore
                    }
                }

                if (walls[square]) throw new Error("Blocked by Builder Wall");

                const pieceAtSource = chess.get(selectedSquare as any);
                const sourceMod = modifiers[selectedSquare];

                let algMove = '';
                let isCapture = false;
                let nextWinner: 'w' | 'b' | null = winner;

                // Ghost move override check
                if (sourceMod && sourceMod.type === 'ghost') {
                    // Temporarily check if move is valid geometrically
                    const initFen = chess.fen();
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

                    chess.load(initFen); // restore

                    if (!validGhost) throw new Error("Invalid ghost move");

                    const isTargetKing = chess.get(square as any)?.type === 'k';

                    // Manually execute ghost move
                    const piece = chess.get(selectedSquare as any);
                    chess.remove(selectedSquare as any);

                    if (isTargetKing) {
                        nextWinner = playerColor as 'w' | 'b';
                    } else if (chess.get(square as any)) {
                        chess.remove(square as any); // capture
                    }

                    if (piece) chess.put(piece, square as any);

                    // Manually swap turn
                    const fenTokens = chess.fen().split(' ');
                    fenTokens[1] = fenTokens[1] === 'w' ? 'b' : 'w';
                    fenTokens[3] = '-'; // clear en passant
                    chess.load(fenTokens.join(' '));

                    algMove = `[GHOST] ${selectedSquare} -> ${square}`;
                } else {
                    // 2. Validate standard move via chess.js
                    const move = chess.move({
                        from: selectedSquare,
                        to: square,
                        promotion: 'q'
                    });
                    algMove = move.san;
                    isCapture = move.flags.includes('c') || move.flags.includes('e');
                }

                // Play standard sound
                playSound(isCapture ? 'capture' : 'move');

                // --- POST-MOVE MODIFIER CHECKS (Necromancer, Martyrdom, Double Move) ---
                let fen = chess.fen();
                let currentTurn = chess.turn();
                let nextModifiers = { ...modifiers };
                let nextWalls = decayWalls(walls);

                if (chess.isCheckmate()) {
                    nextWinner = playerColor as 'w' | 'b';
                }

                // Ghost king capture check (if handled above, nextWinner is already set)
                // (we tracked isTargetKing above and set nextWinner)

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
                    nextTimeLeft[playerColor] += 30;
                    delete nextModifiers[square]; // consume instantly
                } else if (nextModifiers[square] && nextModifiers[square].type === 'time_sub') {
                    const opponent = playerColor === 'w' ? 'b' : 'w';
                    nextTimeLeft[opponent] = Math.max(0, nextTimeLeft[opponent] - 15);
                    delete nextModifiers[square]; // consume instantly
                }

                if (currentTurn !== turn) {
                    // Turn advanced! Add increment
                    nextTimeLeft[playerColor] += timeConfig.increment;
                }

                // Process End-of-Turn spawns and movements for existing upgrades
                nextUpgrades = processEndTurnSpawnsAndMoves(chess, nextUpgrades);

                const moveText = `${playerColor === 'w' ? 'W' : 'B'}: ${algMove}`;
                const nextHistory = [...history, { fen: chess.fen(), upgrades: nextUpgrades, modifiers: nextModifiers, walls, text: moveText }];
                setHistory(nextHistory);

                // Optimistic update
                setBoard(chess.board());
                setTurn(currentTurn as 'w' | 'b');
                setSelectedSquare(null);
                setUpgrades(nextUpgrades);
                setModifiers(nextModifiers);
                setWalls(nextWalls);
                setTimeLeft(nextTimeLeft);
                setLastMoveTime(Date.now());
                if (nextWinner) setWinner(nextWinner);

                // Sync with db
                const newState = {
                    fen: chess.fen(),
                    turn: currentTurn,
                    upgrades: nextUpgrades,
                    modifiers: nextModifiers,
                    walls: nextWalls,
                    history: nextHistory,
                    winner: nextWinner || winner,
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
                // Select new piece normally
                const piece = chess.get(square as any);
                if (piece && piece.color === playerColor) {
                    setSelectedSquare(square);
                    setSniperAttacker(null);
                    setBuilderActive(null);
                    setAwaitingSwapSource(null);
                } else {
                    setSelectedSquare(null);
                    setSniperAttacker(null);
                    setBuilderActive(null);
                    setAwaitingSwapSource(null);
                }
            }
        } else {
            // Trying to select a piece
            const piece = chess.get(square as any);
            if (piece && piece.color === playerColor) {
                // Just select the piece! Do not auto-activate abilities anymore.
                setSelectedSquare(square);
                setSniperAttacker(null);
                setBuilderActive(null);
                setAwaitingSwapSource(null);
            }
        }
    };

    const isSquareHighlighted = (sq: string) => {
        if (sq === selectedSquare) return true;
        if (builderActive && builderActive.placed.includes(sq)) return true;

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

    // --- Active Status Banner ---
    let activeStatusBanner = null;
    let isGameOver = false;

    if (winner) {
        isGameOver = true;
        activeStatusBanner = winner === 'w' ? '🏆 GAME OVER - WHITE WINS!' : '🏆 GAME OVER - BLACK WINS!';
    } else if (viewingHistoryIndex !== null) {
        activeStatusBanner = "VIEWING PAST STATE (USE < > TO SCRUB)";
    } else if (turn === playerColor) {
        if (awaitingSwapSource) {
            activeStatusBanner = "[SWAP ABILITY] - CHOOSE FRIENDLY PIECE TO SWAP WITH";
        } else if (sniperAttacker) {
            activeStatusBanner = "[SNIPER ABILITY] - CHOOSE ENEMY IN RANGE TO DESTROY";
        } else if (builderActive) {
            activeStatusBanner = `[BUILDER ABILITY] - CLICK EMPTY SQUARES TO DROP WALLS (${builderActive.placed.length}/3)`;
        } else if (selectedSquare && modifiers[selectedSquare]) {
            const mod = modifiers[selectedSquare];
            if (mod.type === 'double_move') activeStatusBanner = "[DOUBLE MOVE] - YOU GET TO MOVE THIS PIECE AGAIN";
            if (mod.type === 'ghost') activeStatusBanner = "[GHOST] - PASS THROUGH WALLS/PIECES THIS TURN";
            if (mod.type === 'martyrdom') activeStatusBanner = "[MARTYRDOM] - EXPLODES ON DEATH";
            if (mod.type === 'hidden_move') activeStatusBanner = "[STEALTH] - NEXT MOVE INVISIBLE (WIP)";
            if (mod.type === 'necromancer') activeStatusBanner = "[NECROMANCER] - CAPTURES SPAWN A PAWN";
        }
    }

    // --- State overrides based on Viewing History ---
    let displayBoard = board;
    let displayUpgrades = upgrades;
    let displayModifiers = modifiers;
    let displayWalls = walls;

    if (viewingHistoryIndex !== null && history[viewingHistoryIndex]) {
        try {
            const tempChess = new Chess(history[viewingHistoryIndex].fen);
            displayBoard = tempChess.board();
            displayUpgrades = history[viewingHistoryIndex].upgrades || [];
            displayModifiers = history[viewingHistoryIndex].modifiers || {};
            displayWalls = history[viewingHistoryIndex].walls || {};
        } catch (e) { }
    }

    return (
        <div className="flex flex-col xl:flex-row gap-8 items-center xl:items-start select-none font-mono">
            <div className="flex flex-col items-center">
                <div className="bg-black p-4 border-2 border-green-500 shadow-[0_0_20px_rgba(74,222,128,0.2)] relative">
                    {/* OVERLAY FOR PAST STATE / GAME OVER */}
                    {(viewingHistoryIndex !== null || isGameOver) && (
                        <div className="absolute inset-0 bg-black/40 z-50 flex items-center justify-center pointer-events-none backdrop-blur-[1px]">
                            <div className="bg-green-900 text-black px-6 py-3 border border-green-400 font-extrabold text-2xl drop-shadow-[0_0_8px_rgba(74,222,128,1)] animate-pulse">
                                {isGameOver ? activeStatusBanner : '[ VIEWING PAST STATE ]'}
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-8 grid-rows-8 gap-0 border border-green-900 bg-black w-[600px] h-[600px]">
                        {Array.from({ length: 8 }).map((_, displayRow) =>
                            Array.from({ length: 8 }).map((_, displayCol) => {
                                const i = playerColor === 'w' ? displayRow : 7 - displayRow;
                                const j = playerColor === 'w' ? displayCol : 7 - displayCol;

                                const piece = displayBoard[i][j];
                                const rank = 8 - i;
                                const file = String.fromCharCode('a'.charCodeAt(0) + j);
                                const squareName = `${file}${rank}`;
                                const isDark = (i + j) % 2 === 1;
                                const sqMod = displayModifiers[squareName];

                                return (
                                    <div
                                        key={squareName}
                                        onClick={() => handleSquareClick(squareName)}
                                        className={`flex items-center justify-center text-5xl w-full h-full cursor-pointer transition-colors duration-200 relative
                                            ${isDark ? 'bg-green-950 text-green-300' : 'bg-black text-green-500'}
                                            ${isSquareHighlighted(squareName) ? 'ring-2 ring-inset ring-green-400 bg-green-900/50' : ''}
                                        `}
                                    >
                                        {/* Placed Builder Walls visualization */}
                                        {builderActive && builderActive.placed.includes(squareName) && (
                                            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                                                <div className="text-gray-500 text-3xl font-black drop-shadow-[0_0_5px_currentColor] opacity-80">
                                                    🧱
                                                </div>
                                            </div>
                                        )}
                                        {/* Obstacle Walls visualization */}
                                        {displayWalls[squareName] > 0 && (
                                            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                                                <div className="text-gray-500 text-4xl font-black drop-shadow-[0_0_10px_currentColor] opacity-100">
                                                    🧱
                                                </div>
                                            </div>
                                        )}
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
                                        {sqMod && (
                                            <div
                                                title={MODIFIER_DESCRIPTIONS[sqMod.type] || sqMod.type}
                                                className="absolute top-1 right-1 bg-green-500 text-[10px] text-black px-1.5 py-0.5 font-bold shadow-md uppercase z-20 hover:scale-125 transition-transform cursor-help"
                                            >
                                                {sqMod.type.substring(0, 3)}
                                            </div>
                                        )}
                                        {displayUpgrades.find(u => u.x === j && u.y === i) && (
                                            <div
                                                title={MODIFIER_DESCRIPTIONS[displayUpgrades.find(u => u.x === j && u.y === i)!.type] || 'Mystery Upgrade'}
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

                {/* MANUAL ABILITY ACTIVATION BUTTON */}
                {selectedSquare && modifiers[selectedSquare] && ['sniper', 'builder', 'swap'].includes(modifiers[selectedSquare].type) && !sniperAttacker && !builderActive && !awaitingSwapSource && !isGameOver && (
                    <div className="mt-2 w-full max-w-[600px] flex justify-center">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                const type = modifiers[selectedSquare].type;
                                if (type === 'sniper') setSniperAttacker(selectedSquare);
                                if (type === 'builder') setBuilderActive({ source: selectedSquare, placed: [] });
                                if (type === 'swap') setAwaitingSwapSource(selectedSquare);
                            }}
                            className="bg-green-500 hover:bg-green-400 text-black font-bold py-2 px-6 w-full animate-bounce shadow-[0_0_10px_rgba(74,222,128,0.6)]"
                        >
                            [ FIRE ABILITY: {modifiers[selectedSquare].type.toUpperCase()} ]
                        </button>
                    </div>
                )}

                {/* STATUS BANNER */}
                {activeStatusBanner && (
                    <div className="mt-4 w-full max-w-[600px] bg-green-900 text-black py-2 px-4 border border-green-400 font-bold text-center animate-[pulse_2s_infinite]">
                        {activeStatusBanner}
                    </div>
                )}

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

            {/* HISTORY PANEL */}
            <div className="flex flex-col w-full xl:w-[320px] h-[600px] border border-green-500 bg-black shadow-[0_0_15px_rgba(74,222,128,0.1)]">
                <div className="bg-green-900/40 border-b border-green-500 p-3 flex justify-between items-center">
                    <span className="font-bold text-green-400">&gt; SYS_LOG [HISTORY]</span>
                    <span className="text-xs text-green-700">&lt; / &gt; to scrub</span>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-sm text-green-600 flex flex-col scroll-smooth">
                    {history.length === 0 ? (
                        <div className="opacity-50 italic animate-[pulse_3s_infinite]">&gt; Awaiting moves...</div>
                    ) : (
                        history.map((h, i) => (
                            <div
                                key={i}
                                className={`px-2 py-1.5 flex items-center gap-3 cursor-pointer hover:bg-green-900/30 transition-colors ${i === (viewingHistoryIndex ?? history.length - 1) ? 'bg-green-900/60 text-green-300 border-l-2 border-green-400' : 'border-l-2 border-transparent'}`}
                                onClick={() => {
                                    if (i === history.length - 1) {
                                        setViewingHistoryIndex(null);
                                    } else {
                                        setViewingHistoryIndex(i);
                                    }
                                }}
                            >
                                <span className="opacity-40 text-[10px] w-6 text-right leading-none">{(i + 1).toString().padStart(2, '0')}</span>
                                <span className={h.text.includes('[') ? 'text-green-400 font-bold' : ''}>{h.text}</span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
