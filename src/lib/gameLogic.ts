import { Chess } from 'chess.js';

export type UpgradeEntity = { id: string; x: number; y: number; type: string };
export type ModifiersMap = Record<string, any>;

const PIECE_VALUES: Record<string, number> = { q: 9, r: 5, b: 3, n: 3, p: 1, k: 0 };

export function calculateMaterialScore(board: any[][]): { w: number, b: number } {
    let score = { w: 0, b: 0 };
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = board[r][c];
            if (piece) {
                score[piece.color as 'w' | 'b'] += PIECE_VALUES[piece.type] || 0;
            }
        }
    }
    return score;
}

export function processEndTurnSpawnsAndMoves(
    chess: Chess,
    currentUpgrades: UpgradeEntity[]
): UpgradeEntity[] {
    const board = chess.board();
    let nextUpgrades = [...currentUpgrades];

    // 1. Move existing upgrades away from high value pieces (The Cowardly Lure)
    nextUpgrades = nextUpgrades.map(u => moveUpgradeCowardly(u, board, nextUpgrades));

    // 2. Ensure exactly 2 upgrades on board
    const scores = calculateMaterialScore(board);
    const diff = scores.w - scores.b; // > 0 means w is winning

    while (nextUpgrades.length < 2) {
        const newUpgrade = spawnUpgrade(board, nextUpgrades, diff);
        if (newUpgrade) {
            nextUpgrades.push(newUpgrade);
        } else {
            break; // nowhere to spawn
        }
    }

    return nextUpgrades;
}

function moveUpgradeCowardly(upgrade: UpgradeEntity, board: any[][], allUpgrades: UpgradeEntity[]): UpgradeEntity {
    // Find highest value piece
    let maxVal = -1;
    let targets: { c: number, r: number }[] = [];

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if (board[r][c]) {
                const val = PIECE_VALUES[board[r][c].type] || 0;
                if (val > maxVal) {
                    maxVal = val;
                    targets = [{ c, r }];
                } else if (val === maxVal) {
                    targets.push({ c, r });
                }
            }
        }
    }

    if (targets.length === 0) return upgrade; // no pieces?

    // Calculate distance sum to all targets and find best escaping move
    const getDist = (x1: number, y1: number, x2: number, y2: number) => Math.abs(x1 - x2) + Math.abs(y1 - y2);

    let bestPos = { x: upgrade.x, y: upgrade.y };
    let maxDistScore = -1;

    const moves = [
        { dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }
    ];

    for (const move of moves) {
        const nx = upgrade.x + move.dx;
        const ny = upgrade.y + move.dy;

        // Check bounds
        if (nx < 0 || nx > 7 || ny < 0 || ny > 7) continue;
        // Check if square is empty (no piece, no other upgrade)
        if (board[ny][nx]) continue;
        if (allUpgrades.some(u => u.id !== upgrade.id && u.x === nx && u.y === ny)) continue;

        // Calculate sum of distances to all targets (prefer larger sum -> moving away)
        let sumDist = 0;
        for (const t of targets) {
            sumDist += getDist(nx, ny, t.c, t.r);
        }

        if (sumDist > maxDistScore) {
            maxDistScore = sumDist;
            bestPos = { x: nx, y: ny };
        }
    }

    return { ...upgrade, x: bestPos.x, y: bestPos.y };
}

function spawnUpgrade(board: any[][], currentUpgrades: UpgradeEntity[], materialDiff: number): UpgradeEntity | null {
    // Diff > 0: White winning. Diff < 0: Black winning.
    // We want to pawn heavily weighted for losing player.
    // White side of board is y=4 to 7 (bottom). Black is y=0 to 3 (top).

    const possibleSquares: { x: number, y: number }[] = [];

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if (!board[r][c] && !currentUpgrades.some(u => u.x === c && u.y === r)) {
                possibleSquares.push({ x: c, y: r });
            }
        }
    }

    if (possibleSquares.length === 0) return null;

    // Weight RNG
    let chosenSquare;
    const isWhiteLosingBadly = materialDiff <= -3;
    const isBlackLosingBadly = materialDiff >= 3;

    if (isWhiteLosingBadly || isBlackLosingBadly) {
        const weightedSquares: { x: number, y: number }[] = [];
        for (const sq of possibleSquares) {
            let weight = 1;
            if (isWhiteLosingBadly && sq.y >= 4) weight = 10; // White side
            if (isBlackLosingBadly && sq.y <= 3) weight = 10; // Black side
            for (let i = 0; i < weight; i++) weightedSquares.push(sq);
        }
        const idx = Math.floor(Math.random() * weightedSquares.length);
        chosenSquare = weightedSquares[idx];
    } else {
        // Normal random
        const idx = Math.floor(Math.random() * possibleSquares.length);
        chosenSquare = possibleSquares[idx];
    }

    const upgradeTypes = ['double_move', 'martyrdom', 'hidden_move', 'swap', 'ghost', 'necromancer', 'sniper', 'builder'];

    return {
        id: Math.random().toString(36).substr(2, 9),
        x: chosenSquare.x,
        y: chosenSquare.y,
        type: upgradeTypes[Math.floor(Math.random() * upgradeTypes.length)]
    };
}
