'use client';

import { useParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import ChessGame from '@/components/ChessGame';
import { supabase } from '@/lib/supabase';

export default function RoomPage() {
    const params = useParams();
    const roomCode = params.code as string;
    const [playerColor, setPlayerColor] = useState<'w' | 'b' | null>(null);
    const [availableColors, setAvailableColors] = useState({ w: true, b: true });

    useEffect(() => {
        const fetchAvailability = async () => {
            const { data } = await supabase.from('games').select('state').eq('room_code', roomCode).single();
            if (data?.state?.players) {
                setAvailableColors({
                    w: !data.state.players.w,
                    b: !data.state.players.b,
                });
            }
        };
        fetchAvailability();

        const channel = supabase.channel(`room_lobby:${roomCode}`)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `room_code=eq.${roomCode}` }, (payload) => {
                if (payload.new.state?.players) {
                    setAvailableColors({
                        w: !payload.new.state.players.w,
                        b: !payload.new.state.players.b,
                    });
                }
            }).subscribe();

        return () => { supabase.removeChannel(channel); };
    }, [roomCode]);

    const handleSelectColor = async (color: 'w' | 'b') => {
        setPlayerColor(color);
        const { data } = await supabase.from('games').select('state').eq('room_code', roomCode).single();
        if (data) {
            const newState = { ...data.state };
            newState.players = newState.players || { w: false, b: false };
            newState.players[color] = true;
            await supabase.from('games').update({ state: newState }).eq('room_code', roomCode);
        } else {
            const initialState = { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', turn: 'w', upgrades: [], modifiers: {}, walls: {}, players: { w: color === 'w', b: color === 'b' } };
            await supabase.from('games').insert([{ room_code: roomCode, state: initialState }]);
        }
    };

    const handleAbort = async () => {
        if (playerColor) {
            const { data } = await supabase.from('games').select('state').eq('room_code', roomCode).single();
            if (data?.state?.players) {
                const newState = { ...data.state };
                newState.players[playerColor] = false;
                await supabase.from('games').update({ state: newState }).eq('room_code', roomCode);
            }
        }
        setPlayerColor(null);
    };

    if (!playerColor) {
        return (
            <main className="flex min-h-screen flex-col items-center justify-center p-8 bg-black text-green-500 font-mono">
                <h1 className="text-3xl font-bold mb-8 drop-shadow-[0_0_8px_rgba(74,222,128,0.8)]">&gt; HASH: {roomCode}</h1>
                <div className="flex gap-4">
                    <button
                        onClick={() => handleSelectColor('w')}
                        disabled={!availableColors.w}
                        className="bg-green-900 border border-green-400 text-green-200 px-8 py-4 font-bold hover:bg-green-700 transition-colors uppercase tracking-widest disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        {availableColors.w ? '[ INIT_WHITE ]' : '[ WHITE_TAKEN ]'}
                    </button>
                    <button
                        onClick={() => handleSelectColor('b')}
                        disabled={!availableColors.b}
                        className="bg-black border border-green-700 text-green-600 px-8 py-4 font-bold hover:bg-green-900 hover:text-green-400 transition-colors uppercase tracking-widest disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        {availableColors.b ? '[ INIT_BLACK ]' : '[ BLACK_TAKEN ]'}
                    </button>
                </div>
            </main>
        );
    }

    return (
        <main className="flex min-h-screen flex-col items-center p-8 bg-black text-green-500 font-mono">
            <div className="w-full max-w-[600px] flex justify-between items-center mb-8 border-b border-green-900 pb-4">
                <div>
                    <h1 className="text-2xl font-bold text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.5)]">
                        &gt; SESSION: <span className="tracking-wider">{roomCode}</span>
                    </h1>
                </div>
                <button
                    onClick={handleAbort}
                    className="text-sm text-green-800 hover:text-green-500 transition-colors"
                >
                    [ ABORT ]
                </button>
            </div>

            <ChessGame roomCode={roomCode} playerColor={playerColor} />
        </main>
    );
}
