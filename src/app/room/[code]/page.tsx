'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import ChessGame from '@/components/ChessGame';

export default function RoomPage() {
    const params = useParams();
    const roomCode = params.code as string;
    const [playerColor, setPlayerColor] = useState<'w' | 'b' | null>(null);

    if (!playerColor) {
        return (
            <main className="flex min-h-screen flex-col items-center justify-center p-8 bg-black text-green-500 font-mono">
                <h1 className="text-3xl font-bold mb-8 drop-shadow-[0_0_8px_rgba(74,222,128,0.8)]">&gt; HASH: {roomCode}</h1>
                <div className="flex gap-4">
                    <button
                        onClick={() => setPlayerColor('w')}
                        className="bg-green-900 border border-green-400 text-green-200 px-8 py-4 font-bold hover:bg-green-700 transition-colors uppercase tracking-widest"
                    >
                        [ INIT_WHITE ]
                    </button>
                    <button
                        onClick={() => setPlayerColor('b')}
                        className="bg-black border border-green-700 text-green-600 px-8 py-4 font-bold hover:bg-green-900 hover:text-green-400 transition-colors uppercase tracking-widest"
                    >
                        [ INIT_BLACK ]
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
                    onClick={() => setPlayerColor(null)}
                    className="text-sm text-green-800 hover:text-green-500 transition-colors"
                >
                    [ ABORT ]
                </button>
            </div>

            <ChessGame roomCode={roomCode} playerColor={playerColor} />
        </main>
    );
}
