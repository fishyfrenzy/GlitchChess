'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState('');
  const [timeControl, setTimeControl] = useState('5'); // minutes
  const [increment, setIncrement] = useState('3'); // seconds

  const handleCreateRoom = () => {
    // Generate a 5-letter room code
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    router.push(`/room/${code}?t=${timeControl}&i=${increment}`);
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (joinCode.length === 5) {
      router.push(`/room/${joinCode.toUpperCase()}`);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24 bg-black text-green-500 font-mono">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm flex flex-col gap-8">
        <div className="text-center space-y-4">
          <h1 className="text-5xl font-extrabold tracking-tight lg:text-7xl text-green-400 drop-shadow-[0_0_10px_rgba(74,222,128,0.5)]">
            &gt; ROGUELIKE_CHESS.exe
          </h1>
          <p className="text-green-600 text-lg max-w-lg mx-auto">
            [SYS_MSG]: PvP realtime chess with chaotic powerups, upgrades, and a tug-of-war spawner.
          </p>
        </div>

        <div className="flex flex-col md:flex-row gap-12 mt-12 w-full max-w-2xl bg-black p-8 rounded-none border-2 border-green-500 shadow-[0_0_15px_rgba(74,222,128,0.2)]">
          <div className="flex-1 flex flex-col space-y-4 justify-center">
            <h2 className="text-2xl font-bold text-green-400">&gt; INIT_ROOM</h2>
            <p className="text-sm text-green-700">Start a new room and invite a local socket.</p>
            <div className="flex gap-4 mt-2">
              <select
                value={timeControl}
                onChange={e => setTimeControl(e.target.value)}
                className="bg-black border border-green-500 text-green-400 py-2 px-3 font-mono focus:outline-none focus:ring-1 focus:ring-green-400 w-1/2"
              >
                <option value="1">1 MINUTE</option>
                <option value="5">5 MINUTES</option>
                <option value="10">10 MINUTES</option>
              </select>
              <select
                value={increment}
                onChange={e => setIncrement(e.target.value)}
                className="bg-black border border-green-500 text-green-400 py-2 px-3 font-mono focus:outline-none focus:ring-1 focus:ring-green-400 w-1/2"
              >
                <option value="0">+0 SEC</option>
                <option value="1">+1 SEC</option>
                <option value="3">+3 SEC</option>
              </select>
            </div>
            <button
              onClick={handleCreateRoom}
              className="mt-4 bg-transparent border border-green-500 hover:bg-green-900/30 text-green-400 font-bold py-3 px-6 transition-colors"
            >
              [ CREATE ]
            </button>
          </div>

          <div className="w-px bg-green-900 hidden md:block"></div>
          <div className="h-px bg-green-900 md:hidden w-full"></div>

          <div className="flex-1 flex flex-col space-y-4 justify-center">
            <h2 className="text-2xl font-bold text-green-400">&gt; JOIN_ROOM</h2>
            <p className="text-sm text-green-700">Enter a 5-letter hash to connect.</p>
            <form onSubmit={handleJoinRoom} className="flex flex-col gap-3 mt-4">
              <input
                type="text"
                placeholder="HASH"
                maxLength={5}
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                className="bg-black border border-green-500 text-center font-mono text-lg py-3 px-4 focus:outline-none focus:ring-1 focus:ring-green-400 text-green-400 uppercase transition-all placeholder:text-green-900"
              />
              <button
                type="submit"
                disabled={joinCode.length !== 5}
                className="bg-green-500 hover:bg-green-400 text-black disabled:opacity-30 disabled:cursor-not-allowed font-bold py-3 px-6 transition-colors"
              >
                [ CONNECT ]
              </button>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
