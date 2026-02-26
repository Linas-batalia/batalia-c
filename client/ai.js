// ===== BATALIA AI ENGINE =====
// Monte Carlo Tree Search (MCTS) + Greedy AI for Batalia game
// Extracted from game.html for maintainability

// Helper function to check if unit has General feature
function isGeneral(unit) {
    return unit && unit.features && unit.features.includes('General');
}

// ===== MCTS CONSTANTS AND STATE =====
const MCTS_TIME_LIMIT = 800; // ms per move decision
const MCTS_EXPLORATION = 1.41; // UCB1 exploration constant
let mctsStats = { gamesPlayed: 0, wins: 0, totalSimulations: 0 };

// Load learned data from localStorage
function loadMCTSData() {
    try {
        const saved = localStorage.getItem('batalia_mcts');
        if (saved) mctsStats = JSON.parse(saved);
    } catch (e) { console.log('MCTS load failed:', e); }
}
function saveMCTSData() {
    try {
        localStorage.setItem('batalia_mcts', JSON.stringify(mctsStats));
    } catch (e) { console.log('MCTS save failed:', e); }
}

// ===== SIMULATION FUNCTIONS =====

// Clone game state for simulation
function cloneGameState() {
    return {
        pieces: pieces.map(p => ({...p, engagedWith: null})),
        activeTeam: activeTeam,
        turnNumber: turnNumber
    };
}

// Restore engagement links after cloning
function fixEngagements(state) {
    state.pieces.forEach(p => {
        if (p.engagedWith) {
            const originalEngaged = pieces.find(op => op === p.engagedWith);
            if (originalEngaged) {
                p.engagedWith = state.pieces.find(sp =>
                    sp.c === originalEngaged.c && sp.r === originalEngaged.r && sp.color === originalEngaged.color
                );
            }
        }
    });
}

// Get all possible actions for a unit in simulation
function getSimulationActions(unit, state) {
    const actions = [];
    const aiColor = aiTeam === 'green' ? GCOL : RCOL;

    if (unit.hp <= 0 || unit.color !== aiColor) return actions;

    // If engaged
    if (unit.engagedWith) {
        actions.push({ type: 'defend', unit });
        if (unit.canMelee !== false && unit.ap >= 1) actions.push({ type: 'counter', unit });
        return actions;
    }

    // Ranged unit can shoot
    if (unit.canShoot && unit.ap >= 1) {
        const enemies = state.pieces.filter(p => p.color !== aiColor && p.hp > 0);
        enemies.forEach(enemy => {
            const dist = hexDistance(unit.c, unit.r, enemy.c, enemy.r);
            // Get effective range (considers uphill penalty) - getEffectiveShootRange is defined in game.html
            const effectiveRange = (typeof getEffectiveShootRange !== 'undefined')
                ? getEffectiveShootRange(unit, enemy.c, enemy.r)
                : (unit.shootRange || 3);
            // Check range and Line of Sight (hasLineOfSight is defined in game.html)
            if (dist <= effectiveRange && dist > 0 && (typeof hasLineOfSight === 'undefined' || hasLineOfSight(unit.c, unit.r, enemy.c, enemy.r))) {
                actions.push({ type: 'shoot', unit, target: enemy });
            }
        });
    }

    // Movement and melee attack (simplified for simulation)
    // Cannot move after attacking unless unit has Swift feature
    const hasSwift = unit.features && unit.features.includes('Swift');
    const canMove = !unit.hasFought || hasSwift;

    if (unit.ap >= 1) {
        const neighbors = getNeighbors(unit.c, unit.r);
        neighbors.forEach(n => {
            if (grid.get(`${n.c},${n.r}`)?.active) {
                const occupant = state.pieces.find(p => p.c === n.c && p.r === n.r && p.hp > 0);
                if (!occupant && canMove) {
                    actions.push({ type: 'move', unit, dest: n });
                } else if (occupant && occupant.color !== aiColor && unit.canMelee !== false) {
                    actions.push({ type: 'attack', unit, target: occupant });
                }
            }
        });
    }

    // Rotate
    if (unit.freeTurns > 0 || unit.ap > 0) {
        actions.push({ type: 'rotate', unit, dir: 1 });
        actions.push({ type: 'rotate', unit, dir: -1 });
    }

    // Shieldman special actions: Regroup and Shield
    if (unit.type === 'shieldman' && unit.ap >= 1) {
        const maxHP = isGeneral(unit) ? 8 : 6;
        const regroupUsed = unit.regroupCount || 0;
        // Regroup: restore 1 HP if below max, used less than 3 times, not used this turn
        if (unit.hp < maxHP && regroupUsed < 2 && !unit.regroupedThisTurn) {
            actions.push({ type: 'regroup', unit });
        }
        // Shield: block first arrow from each archer
        if (!unit.shieldActive) {
            actions.push({ type: 'shield', unit });
        }
    }

    if (actions.length === 0) actions.push({ type: 'pass', unit });
    return actions;
}

// Apply action in simulation (mutates state)
function applySimulationAction(action, state) {
    const unit = state.pieces.find(p => p.c === action.unit.c && p.r === action.unit.r && p.color === action.unit.color);
    if (!unit || unit.hp <= 0) return;

    switch (action.type) {
        case 'move':
            // Update rotation to face move direction
            const oldPos = getHexCenter(unit.c, unit.r);
            const newPos = getHexCenter(action.dest.c, action.dest.r);
            unit.rotation = Math.atan2(newPos.y - oldPos.y, newPos.x - oldPos.x);
            unit.c = action.dest.c;
            unit.r = action.dest.r;
            unit.ap -= 1;
            break;
        case 'attack':
            const target = state.pieces.find(p => p.c === action.target.c && p.r === action.target.r);
            if (target) {
                // Calculate backstab bonus
                const unitPos = getHexCenter(unit.c, unit.r);
                const targetPos = getHexCenter(target.c, target.r);
                const attackAngle = Math.atan2(unitPos.y - targetPos.y, unitPos.x - targetPos.x);
                const isBackstab = Math.abs(normalizeAngle(attackAngle - (target.rotation || 0))) > Math.PI / 2;

                // Use unit's melee attack damage + backstab bonus
                let atkDmg = unit.melee ? unit.melee.atk : (unit.type === 'knight' ? 2 : 1);
                if (isBackstab) atkDmg += 1; // Backstab bonus

                // Counter damage (attacker doesn't get backstab bonus on counter)
                const retDmg = target.melee ? target.melee.counter : 1;

                target.hp -= atkDmg;
                unit.hp -= retDmg;
                unit.ap = 0;

                // Update unit rotation to face target
                unit.rotation = Math.atan2(targetPos.y - unitPos.y, targetPos.x - unitPos.x);
            }
            break;
        case 'shoot':
            const shootTarget = state.pieces.find(p => p.c === action.target.c && p.r === action.target.r);
            if (shootTarget) {
                const shotDmg = unit.ranged ? unit.ranged.dmgMin : 1;
                shootTarget.hp -= shotDmg;
                // If locked, damage partner too
                if (shootTarget.engagedWith) {
                    const partner = state.pieces.find(p => p === shootTarget.engagedWith);
                    if (partner) partner.hp -= 1;
                }
                unit.ap -= 1;
            }
            break;
        case 'defend':
        case 'counter':
            // Simplified: both take 1 damage, engagement breaks
            if (unit.engagedWith) {
                const engaged = state.pieces.find(p => p === unit.engagedWith);
                if (engaged) {
                    engaged.hp -= 1;
                    unit.hp -= 1;
                    unit.engagedWith = null;
                    engaged.engagedWith = null;
                }
            }
            break;
        case 'rotate':
            unit.rotation += action.dir * Math.PI / 3;
            if (unit.freeTurns > 0) unit.freeTurns--;
            else unit.ap--;
            break;
        case 'regroup':
            // Shieldman restores 1 HP
            const maxHP = isGeneral(unit) ? 8 : 6;
            unit.hp = Math.min(unit.hp + 1, maxHP);
            unit.regroupCount = (unit.regroupCount || 0) + 1;
            unit.regroupedThisTurn = true;
            unit.ap -= 1;
            break;
        case 'shield':
            // Shieldman activates shield
            unit.shieldActive = true;
            unit.ap -= 1;
            break;
    }
}

// Check winner in simulation
function checkSimulationWinner(state) {
    const redGeneral = state.pieces.find(p => p.color === RCOL && isGeneral(p) && p.hp > 0);
    const greenGeneral = state.pieces.find(p => p.color === GCOL && isGeneral(p) && p.hp > 0);
    if (!redGeneral) return 'green';
    if (!greenGeneral) return 'red';
    return null;
}

// ===== MCTS NODE =====

class MCTSNode {
    constructor(state, parent = null, action = null) {
        this.state = state;
        this.parent = parent;
        this.action = action;
        this.children = [];
        this.visits = 0;
        this.wins = 0;
        this.untriedActions = null;
    }

    getUCB1(explorationConstant) {
        if (this.visits === 0) return Infinity;
        return (this.wins / this.visits) +
               explorationConstant * Math.sqrt(Math.log(this.parent.visits) / this.visits);
    }

    selectChild() {
        let best = null;
        let bestUCB = -Infinity;
        for (const child of this.children) {
            const ucb = child.getUCB1(MCTS_EXPLORATION);
            if (ucb > bestUCB) {
                bestUCB = ucb;
                best = child;
            }
        }
        return best;
    }
}

// ===== MCTS SEARCH =====

function runMCTS(timeLimit = MCTS_TIME_LIMIT) {
    const startTime = Date.now();
    const rootState = cloneGameState();
    const root = new MCTSNode(rootState);

    // Get all units that can act
    const aiColor = aiTeam === 'green' ? GCOL : RCOL;
    const aiUnits = rootState.pieces.filter(p => p.color === aiColor && p.hp > 0);

    // Collect all possible first actions
    let allActions = [];
    aiUnits.forEach(unit => {
        const actions = getSimulationActions(unit, rootState);
        allActions = allActions.concat(actions);
    });

    if (allActions.length === 0) return null;

    root.untriedActions = [...allActions];
    let simCount = 0;

    while (Date.now() - startTime < timeLimit) {
        let node = root;

        // Selection - traverse to leaf
        while (node.untriedActions && node.untriedActions.length === 0 && node.children.length > 0) {
            node = node.selectChild();
        }

        // Expansion - add new child
        if (node.untriedActions && node.untriedActions.length > 0) {
            const actionIdx = Math.floor(Math.random() * node.untriedActions.length);
            const action = node.untriedActions.splice(actionIdx, 1)[0];

            const newState = JSON.parse(JSON.stringify(node.state));
            newState.pieces = newState.pieces.map(p => ({...p}));
            applySimulationAction(action, newState);

            const childNode = new MCTSNode(newState, node, action);
            // Get actions for next unit or end turn
            const nextActions = [];
            const nextAiUnits = newState.pieces.filter(p => p.color === aiColor && p.hp > 0 && p.ap > 0);
            nextAiUnits.forEach(u => {
                nextActions.push(...getSimulationActions(u, newState));
            });
            childNode.untriedActions = nextActions;
            node.children.push(childNode);
            node = childNode;
        }

        // Simulation - random playout
        let simState = JSON.parse(JSON.stringify(node.state));
        simState.pieces = simState.pieces.map(p => ({...p}));
        let depth = 0;
        const maxDepth = 20;

        while (depth < maxDepth && !checkSimulationWinner(simState)) {
            // Random moves for current team
            const currentColor = simState.activeTeam === 'red' ? RCOL : GCOL;
            const units = simState.pieces.filter(p => p.color === currentColor && p.hp > 0);

            if (units.length > 0) {
                const unit = units[Math.floor(Math.random() * units.length)];
                const actions = getSimulationActions(unit, simState);
                if (actions.length > 0) {
                    const action = actions[Math.floor(Math.random() * actions.length)];
                    applySimulationAction(action, simState);
                }
            }

            // Switch teams occasionally
            if (Math.random() < 0.3) {
                simState.activeTeam = simState.activeTeam === 'red' ? 'green' : 'red';
                simState.pieces.forEach(p => {
                    const pColor = simState.activeTeam === 'red' ? RCOL : GCOL;
                    if (p.color === pColor) { p.ap = 3; p.freeTurns = 1; }
                });
            }
            depth++;
        }

        // Evaluate final state
        const winner = checkSimulationWinner(simState);
        let result = 0.5; // Draw
        if (winner === aiTeam) result = 1;
        else if (winner) result = 0;
        else {
            // Heuristic: count HP advantage + positional safety
            const aiColor = aiTeam === 'green' ? GCOL : RCOL;
            const aiPieces = simState.pieces.filter(p => p.color === aiColor && p.hp > 0);
            const enemyPieces = simState.pieces.filter(p => p.color !== aiColor && p.hp > 0);

            const aiHP = aiPieces.reduce((sum, p) => sum + p.hp, 0);
            const enemyHP = enemyPieces.reduce((sum, p) => sum + p.hp, 0);

            // Base HP ratio
            let hpRatio = aiHP / (aiHP + enemyHP + 1);

            // Positional danger adjustment (simplified for simulation speed)
            // Check if AI units are exposed (enemies behind them)
            let aiDanger = 0;
            let enemyDanger = 0;

            for (const unit of aiPieces) {
                for (const enemy of enemyPieces) {
                    const dist = hexDistance(unit.c, unit.r, enemy.c, enemy.r);
                    if (dist <= 2) {
                        // Simplified backstab check using rotation
                        const unitPos = getHexCenter(unit.c, unit.r);
                        const enemyPos = getHexCenter(enemy.c, enemy.r);
                        const threatAngle = Math.atan2(enemyPos.y - unitPos.y, enemyPos.x - unitPos.x);
                        const angleDiff = Math.abs(normalizeAngle(threatAngle - (unit.rotation || 0)));
                        if (angleDiff > Math.PI / 2) {
                            // Enemy is behind this unit
                            aiDanger += (3 - dist) * 2;
                        }
                    }
                }
            }

            for (const unit of enemyPieces) {
                for (const aiUnit of aiPieces) {
                    const dist = hexDistance(unit.c, unit.r, aiUnit.c, aiUnit.r);
                    if (dist <= 2) {
                        const unitPos = getHexCenter(unit.c, unit.r);
                        const aiPos = getHexCenter(aiUnit.c, aiUnit.r);
                        const threatAngle = Math.atan2(aiPos.y - unitPos.y, aiPos.x - unitPos.x);
                        const angleDiff = Math.abs(normalizeAngle(threatAngle - (unit.rotation || 0)));
                        if (angleDiff > Math.PI / 2) {
                            // AI unit is behind enemy
                            enemyDanger += (3 - dist) * 2;
                        }
                    }
                }
            }

            // Adjust result based on positional advantage
            const dangerBonus = (enemyDanger - aiDanger) * 0.02;
            result = Math.max(0, Math.min(1, hpRatio + dangerBonus));

            // Flag capture bonus in simulation evaluation
            if (typeof captureTheFlagEnabled !== 'undefined' && captureTheFlagEnabled &&
                typeof hexNumToCoord !== 'undefined' && typeof CENTRAL_HEX_NUM !== 'undefined') {
                const centralCoord = hexNumToCoord.get(CENTRAL_HEX_NUM);
                if (centralCoord) {
                    // Check if any AI unit is on the flag
                    const aiOnFlag = simState.pieces.some(p =>
                        p.color === aiColor && p.hp > 0 &&
                        p.c === centralCoord.c && p.r === centralCoord.r
                    );
                    const enemyOnFlag = simState.pieces.some(p =>
                        p.color !== aiColor && p.hp > 0 &&
                        p.c === centralCoord.c && p.r === centralCoord.r
                    );

                    if (aiOnFlag) result = Math.min(1, result + 0.15);
                    if (enemyOnFlag) result = Math.max(0, result - 0.1);
                }
            }
        }

        // Backpropagation
        while (node) {
            node.visits++;
            node.wins += result;
            node = node.parent;
        }
        simCount++;
    }

    mctsStats.totalSimulations += simCount;

    // Select best action (most visited)
    if (root.children.length === 0) {
        // Fallback to random action
        return allActions[Math.floor(Math.random() * allActions.length)];
    }

    // Sort children by visits
    const sortedChildren = [...root.children].sort((a, b) => b.visits - a.visits);

    // Early game variety: randomly choose from top moves in first 3 turns
    const isEarlyGame = turnNumber <= 3;

    if (isEarlyGame && sortedChildren.length > 1) {
        // Pick randomly from top 3-4 children (with at least 50% of best's visits)
        const bestVisits = sortedChildren[0].visits;
        const topChildren = sortedChildren.filter(c => c.visits >= bestVisits * 0.5).slice(0, 4);
        const chosen = topChildren[Math.floor(Math.random() * topChildren.length)];
        console.log(`MCTS Early game variety: chose from ${topChildren.length} options, visits: ${chosen.visits}`);
        return chosen.action;
    }

    const bestChild = sortedChildren[0];
    console.log(`MCTS: ${simCount} simulations, best action visits: ${bestChild.visits}`);
    return bestChild ? bestChild.action : allActions[0];
}

// ===== DANGER EVALUATION =====

// Calculate how dangerous a position is based on enemy threats
// Returns a danger score (higher = more dangerous)
function calculatePositionDanger(c, r, unitRotation, unit) {
    const aiColor = aiTeam === 'green' ? GCOL : RCOL;
    const enemies = pieces.filter(p => p.color !== aiColor && p.hp > 0);
    let danger = 0;

    const posCenter = getHexCenter(c, r);

    for (const enemy of enemies) {
        const dist = hexDistance(c, r, enemy.c, enemy.r);

        // Adjacent enemies are immediate threats
        if (dist === 1) {
            // Calculate if enemy would be attacking from behind
            const enemyPos = getHexCenter(enemy.c, enemy.r);
            const attackAngle = Math.atan2(enemyPos.y - posCenter.y, enemyPos.x - posCenter.x);
            const angleDiff = Math.abs(normalizeAngle(attackAngle - unitRotation));

            // Behind = angle diff > 90 degrees (PI/2)
            const isBehind = angleDiff > Math.PI / 2;

            if (isBehind) {
                // High danger - enemy can backstab!
                danger += 25;
                // Extra danger from knights (high damage)
                if (enemy.type === 'knight') danger += 15;
                // Extra danger if enemy has AP to attack
                if (enemy.ap > 0) danger += 10;
            } else {
                // Still some danger from adjacent enemies
                danger += 8;
                if (enemy.type === 'knight') danger += 5;
            }
        }
        // Enemies 2 hexes away can reach us next turn
        else if (dist === 2) {
            // Check if enemy could move adjacent and attack from behind
            const enemyNeighbors = getNeighbors(enemy.c, enemy.r);
            for (const n of enemyNeighbors) {
                if (hexDistance(n.c, n.r, c, r) === 1) {
                    // Enemy could move to n and be adjacent to us
                    const nPos = getHexCenter(n.c, n.r);
                    const attackAngle = Math.atan2(nPos.y - posCenter.y, nPos.x - posCenter.x);
                    const angleDiff = Math.abs(normalizeAngle(attackAngle - unitRotation));
                    const wouldBeBehind = angleDiff > Math.PI / 2;

                    if (wouldBeBehind) {
                        danger += 12;
                        if (enemy.type === 'knight') danger += 8;
                    } else {
                        danger += 4;
                    }
                    break; // Only count each enemy once
                }
            }
        }
        // Ranged enemies can shoot from distance (check LOS and arrow blocking)
        // Get effective range considering uphill penalty
        else if (enemy.canShoot) {
            const enemyEffectiveRange = (typeof getEffectiveShootRange !== 'undefined')
                ? getEffectiveShootRange(enemy, c, r)
                : (enemy.shootRange || 3);
            if (dist <= enemyEffectiveRange && (typeof hasLineOfSight === 'undefined' || hasLineOfSight(enemy.c, enemy.r, c, r))) {
                // Check if arrows would be blocked by terrain (forest protection)
                let arrowBlocked = false;
                if (typeof DemoRules !== 'undefined' && typeof terrain !== 'undefined') {
                    const targetTerrain = terrain.get(`${c},${r}`);
                    arrowBlocked = DemoRules.isArrowBlocked(targetTerrain, dist);
                }
                if (arrowBlocked) continue; // No danger from this shooter
                danger += 5;
                // More danger if we'd be shot from behind
                const enemyPos = getHexCenter(enemy.c, enemy.r);
                const shotAngle = Math.atan2(enemyPos.y - posCenter.y, enemyPos.x - posCenter.x);
                const angleDiff = Math.abs(normalizeAngle(shotAngle - unitRotation));
                if (angleDiff > Math.PI / 2) {
                    danger += 5; // Backstab shot does more damage
                }
            }
        }
    }

    // Reduce danger if we have friendly units nearby (protection)
    const friendlies = pieces.filter(p => p.color === aiColor && p.hp > 0 && !(p.c === unit.c && p.r === unit.r));
    for (const friend of friendlies) {
        const dist = hexDistance(c, r, friend.c, friend.r);
        if (dist === 1) {
            danger -= 5; // Adjacent friendly provides some protection
        } else if (dist === 2) {
            danger -= 2;
        }
    }

    return Math.max(0, danger);
}

// Calculate optimal facing direction for a position to minimize danger
function calculateSafestRotation(c, r, unit) {
    const aiColor = aiTeam === 'green' ? GCOL : RCOL;
    const enemies = pieces.filter(p => p.color !== aiColor && p.hp > 0);

    if (enemies.length === 0) return unit.rotation;

    // Find the "threat centroid" - weighted average position of nearby enemies
    let threatX = 0, threatY = 0, totalWeight = 0;
    const posCenter = getHexCenter(c, r);

    for (const enemy of enemies) {
        const dist = hexDistance(c, r, enemy.c, enemy.r);
        if (dist <= 3) {
            const weight = (4 - dist) * (enemy.type === 'knight' ? 2 : 1);
            const enemyPos = getHexCenter(enemy.c, enemy.r);
            threatX += enemyPos.x * weight;
            threatY += enemyPos.y * weight;
            totalWeight += weight;
        }
    }

    if (totalWeight === 0) return unit.rotation;

    threatX /= totalWeight;
    threatY /= totalWeight;

    // Face toward the threat centroid
    const targetAngle = Math.atan2(threatY - posCenter.y, threatX - posCenter.x);
    return snapRotation(targetAngle);
}

// Evaluate a move considering both offensive value and defensive danger
function evaluateMoveWithDanger(c, r, cost, unit, enemies) {
    const aiColor = aiTeam === 'green' ? GCOL : RCOL;
    let score = 0;

    // --- Flag capture scoring (Demo mode with capture flag enabled) ---
    if (typeof captureTheFlagEnabled !== 'undefined' && captureTheFlagEnabled &&
        typeof hexNumToCoord !== 'undefined' && typeof CENTRAL_HEX_NUM !== 'undefined') {
        const centralCoord = hexNumToCoord.get(CENTRAL_HEX_NUM);
        if (centralCoord) {
            const distToFlag = hexDistance(c, r, centralCoord.c, centralCoord.r);

            // Bonus for being close to or on the flag
            if (distToFlag === 0) {
                // Standing on the flag is very valuable
                score += 50;
                // Extra bonus if we don't control the flag yet
                if (typeof centralHexControl !== 'undefined' && centralHexControl.team !== aiColor) {
                    score += 30; // Take control!
                }
            } else {
                // Closer to flag is better
                score += (5 - distToFlag) * 8;
            }

            // Urgency: if enemy is close to winning via flag, prioritize contesting
            if (typeof centralHexControl !== 'undefined' && centralHexControl.team &&
                centralHexControl.team !== aiColor && centralHexControl.turns >= 3) {
                // Enemy is halfway to winning! Urgent to contest
                const urgencyBonus = (centralHexControl.turns - 2) * 20;
                if (distToFlag === 0) {
                    score += urgencyBonus * 2; // Contest immediately!
                } else if (distToFlag <= 2) {
                    score += urgencyBonus;
                }
            }
        }
    }

    // --- Offensive scoring ---

    // Distance to closest enemy
    let minEnemyDist = Infinity;
    for (const enemy of enemies) {
        const dist = hexDistance(c, r, enemy.c, enemy.r);
        if (dist < minEnemyDist) minEnemyDist = dist;
    }
    score -= minEnemyDist * 8; // Closer is better
    score -= cost * 2; // Prefer cheaper moves

    // Bonus for positions adjacent to enemies (attack opportunity)
    const adjEnemies = getNeighbors(c, r)
        .map(n => pieces.find(p => p.c === n.c && p.r === n.r && p.color !== aiColor && p.hp > 0))
        .filter(Boolean);

    for (const enemy of adjEnemies) {
        score += 10; // Attack opportunity
        // Backstab bonus
        const hexPos = getHexCenter(c, r);
        const enemyPos = getHexCenter(enemy.c, enemy.r);
        const attackAngle = Math.atan2(hexPos.y - enemyPos.y, hexPos.x - enemyPos.x);
        const isBackstab = Math.abs(normalizeAngle(attackAngle - enemy.rotation)) > Math.PI / 2;
        if (isBackstab) score += 15;
        // General target bonus
        if (isGeneral(enemy)) score += 20;
    }

    // --- Defensive scoring (danger awareness) ---

    // Calculate safest rotation for this position
    const safeRotation = calculateSafestRotation(c, r, unit);
    const danger = calculatePositionDanger(c, r, safeRotation, unit);

    // Apply danger penalty based on difficulty
    let dangerMultiplier = 1.0;
    if (aiDifficulty === 'easy') dangerMultiplier = 0.3; // Easy AI ignores most danger
    else if (aiDifficulty === 'normal') dangerMultiplier = 0.7;
    else if (aiDifficulty === 'hard') dangerMultiplier = 1.2; // Hard AI is very cautious

    score -= danger * dangerMultiplier;

    // Extra penalty if this unit is the General
    if (isGeneral(unit)) {
        score -= danger * 0.5; // Generals should be extra careful
    }

    // Penalty for moving to a position where we'd have our back to enemies
    // even if they're not immediately adjacent
    const currentPos = getHexCenter(unit.c, unit.r);
    const newPos = getHexCenter(c, r);
    const moveDirection = Math.atan2(newPos.y - currentPos.y, newPos.x - currentPos.x);

    // After moving, unit typically faces move direction - check danger with that facing
    const dangerWithMoveFacing = calculatePositionDanger(c, r, moveDirection, unit);
    if (dangerWithMoveFacing > danger + 10) {
        score -= 8; // Penalty if move direction facing is worse than optimal
    }

    return score;
}

// ===== AI DECISION MAKING =====

function findShootTarget(archer) {
    const aiColor = aiTeam === 'green' ? GCOL : RCOL;
    const enemies = pieces.filter(p => p.color !== aiColor && p.hp > 0);
    let bestTarget = null;
    let bestScore = -Infinity;

    for (let enemy of enemies) {
        const dist = hexDistance(archer.c, archer.r, enemy.c, enemy.r);
        // Get effective range (considers uphill penalty)
        const effectiveRange = (typeof getEffectiveShootRange !== 'undefined')
            ? getEffectiveShootRange(archer, enemy.c, enemy.r)
            : (archer.shootRange || 3);
        // Check range and Line of Sight
        if (dist <= effectiveRange && dist > 0 && (typeof hasLineOfSight === 'undefined' || hasLineOfSight(archer.c, archer.r, enemy.c, enemy.r))) {
            // Check if arrow would be blocked by terrain (forest protection)
            if (typeof DemoRules !== 'undefined' && typeof terrain !== 'undefined') {
                const targetTerrain = terrain.get(`${enemy.c},${enemy.r}`);
                if (DemoRules.isArrowBlocked(targetTerrain, dist)) {
                    continue; // Skip - arrow would be blocked
                }
            }
            const archerPos = getHexCenter(archer.c, archer.r);
            const enemyPos = getHexCenter(enemy.c, enemy.r);
            const attackAngle = Math.atan2(archerPos.y - enemyPos.y, archerPos.x - enemyPos.x);
            const isBackstab = Math.abs(normalizeAngle(attackAngle - enemy.rotation)) > Math.PI / 2;
            const dmgToEnemy = isBackstab ? 2 : 1;

            let score = (10 - enemy.hp) + (isBackstab ? 5 : 0);
            // Bonus for killing enemy
            if (enemy.hp <= dmgToEnemy) score += 10;
            // Big bonus for killing enemy general
            if (isGeneral(enemy)) score += 15;
            if (isGeneral(enemy) && enemy.hp <= dmgToEnemy) score += 50;

            // Check if enemy is locked in combat with a friendly unit
            const partner = enemy.engagedWith;
            if (partner && partner.color === aiColor && partner.hp > 0) {
                // Partner is friendly - shooting will damage them too!
                const partnerPos = getHexCenter(partner.c, partner.r);
                const partnerAngle = Math.atan2(archerPos.y - partnerPos.y, archerPos.x - partnerPos.x);
                const partnerBackstab = Math.abs(normalizeAngle(partnerAngle - partner.rotation)) > Math.PI / 2;
                const dmgToFriendly = partnerBackstab ? 2 : 1;

                // NEVER shoot if it would kill our own General
                if (isGeneral(partner) && partner.hp <= dmgToFriendly) {
                    continue; // Skip this target entirely
                }

                // NEVER shoot if it would kill any friendly unit
                if (partner.hp <= dmgToFriendly) {
                    // Would kill friendly - only acceptable if killing enemy general
                    if (isGeneral(enemy) && enemy.hp <= dmgToEnemy) {
                        score += 30; // Worth it to kill enemy general
                    } else {
                        continue; // Not worth killing our own unit
                    }
                }

                // For easy/normal AI: avoid friendly fire entirely unless killing enemy general
                if (aiDifficulty === 'easy' || aiDifficulty === 'normal') {
                    if (!(isGeneral(enemy) && enemy.hp <= dmgToEnemy)) {
                        continue; // Skip - don't shoot locked pairs with friendlies
                    }
                }

                // Advanced AI: heavy penalty for friendly fire but may still shoot
                score -= dmgToFriendly * 8; // Heavy penalty
                if (isGeneral(partner)) score -= 20;
                if (partner.type === 'knight') score -= 5;
            }

            if (score > bestScore) {
                bestScore = score;
                bestTarget = enemy;
            }
        }
    }

    // Only return target if score is positive (worthwhile shot)
    return bestScore > 0 ? bestTarget : null;
}

function findBestMoveTarget(unit) {
    const reachable = calculateReachable(unit);
    if (reachable.size === 0) return null;

    const aiColor = aiTeam === 'green' ? GCOL : RCOL;
    const enemies = pieces.filter(p => p.color !== aiColor && p.hp > 0);
    if (enemies.length === 0) return null;

    // Double-check: filter out any hexes that are currently occupied (safety check)
    reachable.forEach((data, key) => {
        const [c, r] = key.split(',').map(Number);
        const isOccupied = pieces.some(p => p !== unit && p.hp > 0 && p.c === c && p.r === r);
        if (isOccupied) {
            console.warn('findBestMoveTarget: removing occupied hex', c, r, 'from reachable');
            reachable.delete(key);
        }
    });

    if (reachable.size === 0) return null;

    // Collect all moves with scores for variety selection
    let allMoves = [];

    // Prioritize enemy general
    const enemyGeneral = enemies.find(e => isGeneral(e));

    reachable.forEach((data, key) => {
        const [c, r] = key.split(',').map(Number);

        // Use comprehensive danger-aware evaluation
        let score = evaluateMoveWithDanger(c, r, data.cost, unit, enemies);

        // Bonus for getting close to enemy general
        if ((aiDifficulty === 'hard' || aiDifficulty === 'normal') && enemyGeneral) {
            const distToGeneral = hexDistance(c, r, enemyGeneral.c, enemyGeneral.r);
            score += (5 - distToGeneral) * 5;
        }

        // Consider staying put if current position is safer
        if (c === unit.c && r === unit.r) {
            const currentDanger = calculatePositionDanger(c, r, unit.rotation, unit);
            if (currentDanger < 10) {
                score += 5; // Small bonus for staying in a safe position
            }
        }

        allMoves.push({ c, r, cost: data.cost, score });
    });

    // Sort by score descending
    allMoves.sort((a, b) => b.score - a.score);

    // Early game variety: randomly choose from top moves in first 3 turns
    const isEarlyGame = turnNumber <= 3;
    let bestHex = null;
    let bestScore = -Infinity;

    if (isEarlyGame && allMoves.length > 1) {
        // Pick randomly from top 3-4 moves (within 15 points of best)
        const topMoves = allMoves.filter(m => m.score >= allMoves[0].score - 15).slice(0, 4);
        const chosen = topMoves[Math.floor(Math.random() * topMoves.length)];
        bestHex = { c: chosen.c, r: chosen.r, cost: chosen.cost };
        bestScore = chosen.score;
        console.log('Early game variety: chose move', bestHex.c, bestHex.r, 'from', topMoves.length, 'options');
    } else if (allMoves.length > 0) {
        bestHex = { c: allMoves[0].c, r: allMoves[0].r, cost: allMoves[0].cost };
        bestScore = allMoves[0].score;
    }

    // If best move is too dangerous compared to staying, prefer staying
    if (bestHex && aiDifficulty !== 'easy') {
        const currentDanger = calculatePositionDanger(unit.c, unit.r, unit.rotation, unit);
        const bestDanger = calculatePositionDanger(bestHex.c, bestHex.r,
            calculateSafestRotation(bestHex.c, bestHex.r, unit), unit);

        // If moving would significantly increase danger, reconsider
        if (bestDanger > currentDanger + 20 && !isGeneral(enemies.find(e =>
            hexDistance(bestHex.c, bestHex.r, e.c, e.r) === 1))) {
            // Don't make very dangerous moves unless attacking enemy general
            const stayScore = evaluateMoveWithDanger(unit.c, unit.r, 0, unit, enemies);
            if (stayScore > bestScore - 15) {
                return null; // Stay put instead
            }
        }
    }

    return bestHex;
}

function findFlankingMove(unit) {
    // Advanced AI: Try to get behind enemies, but not at the cost of exposing our back
    const reachable = calculateReachable(unit);
    if (reachable.size === 0) return null;

    const aiColor = aiTeam === 'green' ? GCOL : RCOL;
    const enemies = pieces.filter(p => p.color !== aiColor && p.hp > 0);

    let bestFlank = null;
    let bestScore = -Infinity;

    reachable.forEach((data, key) => {
        const [c, r] = key.split(',').map(Number);

        // Check if this position is adjacent to an enemy and behind them
        const adjEnemies = getNeighbors(c, r)
            .map(n => pieces.find(p => p.c === n.c && p.r === n.r && p.color !== unit.color && p.hp > 0))
            .filter(Boolean);

        for (let enemy of adjEnemies) {
            const hexPos = getHexCenter(c, r);
            const enemyPos = getHexCenter(enemy.c, enemy.r);
            const attackAngle = Math.atan2(hexPos.y - enemyPos.y, hexPos.x - enemyPos.x);
            const isBackstab = Math.abs(normalizeAngle(attackAngle - enemy.rotation)) > Math.PI / 2;

            if (isBackstab) {
                let score = 20 - data.cost;
                // Prefer flanking high-value targets
                if (isGeneral(enemy)) score += 30;
                else if (enemy.type === 'knight') score += 10;

                // CRITICAL: Evaluate danger of this flanking position
                // After attacking, we'll face the enemy - calculate rotation toward them
                const attackRotation = Math.atan2(enemyPos.y - hexPos.y, enemyPos.x - hexPos.x);
                const danger = calculatePositionDanger(c, r, attackRotation, unit);

                // Subtract danger from score
                score -= danger * 0.8;

                // Extra penalty if we'd be exposing our back to other enemies
                const otherEnemies = enemies.filter(e => e !== enemy);
                for (const other of otherEnemies) {
                    const otherDist = hexDistance(c, r, other.c, other.r);
                    if (otherDist <= 2) {
                        const otherPos = getHexCenter(other.c, other.r);
                        const otherAngle = Math.atan2(otherPos.y - hexPos.y, otherPos.x - hexPos.x);
                        const behindUs = Math.abs(normalizeAngle(otherAngle - attackRotation)) > Math.PI / 2;
                        if (behindUs) {
                            score -= 15; // Another enemy would be behind us!
                            if (other.type === 'knight') score -= 10;
                        }
                    }
                }

                // Don't flank if it's a death trap for our General
                if (isGeneral(unit) && danger > 20) {
                    continue; // Skip this flanking position entirely
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestFlank = { c, r, cost: data.cost };
                }
            }
        }
    });

    // Only return flanking move if the score is positive (worth the risk)
    return bestScore > 0 ? bestFlank : null;
}

function shouldRotate(unit) {
    // Rotate to face threats - uses threat centroid for smart positioning
    const aiColor = aiTeam === 'green' ? GCOL : RCOL;
    const enemies = pieces.filter(p => p.color !== aiColor && p.hp > 0);
    if (enemies.length === 0) return null;

    const unitPos = getHexCenter(unit.c, unit.r);

    // Check for adjacent enemies - MUST face them
    const neighbors = getNeighbors(unit.c, unit.r);
    const adjacentEnemies = [];
    for (let n of neighbors) {
        const enemy = pieces.find(p => p.c === n.c && p.r === n.r && p.color !== unit.color && p.hp > 0);
        if (enemy) adjacentEnemies.push(enemy);
    }

    let targetAngle;

    if (adjacentEnemies.length > 0) {
        // Face toward the center of adjacent enemies (or single enemy)
        if (adjacentEnemies.length === 1) {
            const enemyPos = getHexCenter(adjacentEnemies[0].c, adjacentEnemies[0].r);
            targetAngle = Math.atan2(enemyPos.y - unitPos.y, enemyPos.x - unitPos.x);
        } else {
            // Multiple adjacent enemies - face their weighted center
            // Weight by threat (knights are more dangerous)
            let cx = 0, cy = 0, totalWeight = 0;
            for (const enemy of adjacentEnemies) {
                const weight = enemy.type === 'knight' ? 2 : 1;
                const pos = getHexCenter(enemy.c, enemy.r);
                cx += pos.x * weight;
                cy += pos.y * weight;
                totalWeight += weight;
            }
            cx /= totalWeight;
            cy /= totalWeight;
            targetAngle = Math.atan2(cy - unitPos.y, cx - unitPos.x);
        }
    } else {
        // No adjacent enemies - face toward nearest threat or threat cluster
        // Use calculateSafestRotation which considers all nearby enemies
        const safeAngle = calculateSafestRotation(unit.c, unit.r, unit);

        // Only rotate if we're significantly misaligned (more than 60 degrees off)
        const currentDiff = Math.abs(normalizeAngle(safeAngle - unit.rotation));
        if (currentDiff < Math.PI / 3) return null;

        targetAngle = safeAngle;
    }

    targetAngle = snapRotation(targetAngle);
    const currentAngle = unit.rotation;

    // Check if already facing roughly the right direction (within 60 degrees)
    const angleDiff = Math.abs(normalizeAngle(targetAngle - currentAngle));
    if (angleDiff < Math.PI / 3) return null; // Already facing threat direction

    // Determine shortest rotation direction
    const diff = normalizeAngle(targetAngle - currentAngle);
    return diff > 0 ? 1 : -1;
}

function decideAction(unit) {
    const aiColor = aiTeam === 'green' ? GCOL : RCOL;
    const enemies = pieces.filter(p => p.color !== aiColor);

    // Easy AI: Basic greedy, some randomness
    // Normal AI: Better targeting, protects general
    // Advanced AI: Flanking, coordinated attacks, defensive positioning

    // 1. If engaged - defend, counter, or retreat
    if (unit.engagedWith && !unit.isAggressor) {
        const enemy = unit.engagedWith;
        const unitIsGeneral = isGeneral(unit);

        // Calculate expected TOTAL damage in combat (4 phases)
        // Defend: we strike phases 1,3 (counter dmg), enemy strikes phases 2,4 (counter dmg)
        // Counter: we strike phases 1,3 (atk then counter), enemy strikes phases 2,4 (counter dmg)
        // Both options: we take enemyCounterDmg * 2
        const enemyCounterDmg = enemy.melee ? enemy.melee.counter : 1;

        // Total damage we'd take in full combat (same for both Defend and Counter)
        const totalDmgInCombat = enemyCounterDmg * 2;  // Enemy counters twice (phases 2 and 4)

        // Damage we deal differs:
        const ourCounterDmg = unit.melee ? unit.melee.counter : 1;
        const ourAtkDmg = unit.melee ? unit.melee.atk : 1;
        const dmgWeDoInDefend = ourCounterDmg * 2;  // We strike twice with counter
        const dmgWeDoInCounter = ourAtkDmg + ourCounterDmg;  // We strike with atk then counter

        console.log('=== AI ENGAGED UNIT DECISION ===');
        console.log('Unit:', unit.type, 'HP:', unit.hp, 'isGeneral:', unitIsGeneral);
        console.log('Enemy:', enemy.type, 'counterDmg:', enemyCounterDmg);
        console.log('Combat: both Defend/Counter = we take', totalDmgInCombat, 'dmg');
        console.log('Defend deals:', dmgWeDoInDefend, '| Counter deals:', dmgWeDoInCounter);
        console.log('Would die in combat?', unit.hp <= totalDmgInCombat, '(', unit.hp, '<=', totalDmgInCombat, ')');

        // Find retreat hexes
        const retreatHexes = getNeighbors(unit.c, unit.r).filter(n => {
            const key = `${n.c},${n.r}`;
            return grid.get(key)?.active && !pieces.some(p => p.c === n.c && p.r === n.r && p.hp > 0);
        });
        console.log('Available retreat hexes:', retreatHexes.length, retreatHexes);

        // If we're the General and would die from combat, RETREAT!
        if (unitIsGeneral && unit.hp <= totalDmgInCombat && retreatHexes.length > 0) {
            console.log('>>> DECISION: RETREAT (General would die in combat)');
            // Find safest retreat hex (furthest from enemies)
            let bestHex = retreatHexes[0];
            let bestScore = -Infinity;
            for (const hex of retreatHexes) {
                let score = 0;
                const enemies = pieces.filter(p => p.color !== unit.color && p.hp > 0);
                for (const e of enemies) {
                    score += hexDistance(hex.c, hex.r, e.c, e.r);
                }
                // Prefer hexes behind friendly units
                const friendlyNeighbors = getNeighbors(hex.c, hex.r).filter(n =>
                    pieces.some(p => p.c === n.c && p.r === n.r && p.color === unit.color && p.hp > 0)
                );
                score += friendlyNeighbors.length * 3;
                if (score > bestScore) {
                    bestScore = score;
                    bestHex = hex;
                }
            }
            return { type: 'retreat', destination: bestHex };
        }

        // Check if defending would help friendly archers shoot the enemy
        if (aiDifficulty === 'hard' || aiDifficulty === 'normal') {
            const friendlyShooters = pieces.filter(p => p.color === aiColor && p.canShoot && p.hp > 0 && !p.engagedWith && p.ap >= 1);

            for (const archer of friendlyShooters) {
                const dist = hexDistance(archer.c, archer.r, enemy.c, enemy.r);
                // Check range and Line of Sight
                if (dist <= (archer.shootRange || 3) && dist > 0 && (typeof hasLineOfSight === 'undefined' || hasLineOfSight(archer.c, archer.r, enemy.c, enemy.r))) {
                    // Check if arrow would be blocked by terrain
                    let arrowBlocked = false;
                    if (typeof DemoRules !== 'undefined' && typeof terrain !== 'undefined') {
                        const targetTerrain = terrain.get(`${enemy.c},${enemy.r}`);
                        arrowBlocked = DemoRules.isArrowBlocked(targetTerrain, dist);
                    }
                    if (!arrowBlocked) {
                        console.log('>>> DECISION: DEFEND (archer can shoot enemy)');
                        return { type: 'defend' };
                    }
                }
            }
        }

        // If combat would kill us, retreat (Defend and Counter have same damage taken)
        if (unit.canMelee !== false && unit.ap >= 1) {
            // Both Defend and Counter: enemy counters twice, we take totalDmgInCombat
            if (unitIsGeneral && unit.hp <= totalDmgInCombat && retreatHexes.length > 0) {
                console.log('>>> DECISION: RETREAT (combat would kill General, total dmg:', totalDmgInCombat, ')');
                return { type: 'retreat', destination: retreatHexes[0] };
            }
            if (aiDifficulty === 'hard' || (aiDifficulty === 'normal' && Math.random() > 0.3)) {
                console.log('>>> DECISION: COUNTER');
                return { type: 'counter' };
            }
            if (aiDifficulty === 'easy' && Math.random() > 0.5) {
                console.log('>>> DECISION: DEFEND (easy AI)');
                return { type: 'defend' };
            }
            console.log('>>> DECISION: COUNTER (default)');
            return { type: 'counter' };
        }

        // Can't counter (ranged or no AP) - check if defend is safe
        // In defend, we take enemy counter * 2 = totalDmgInCombat
        if (unitIsGeneral && unit.hp <= totalDmgInCombat && retreatHexes.length > 0) {
            console.log('>>> DECISION: RETREAT (can\'t counter, would die from total dmg:', totalDmgInCombat, ')');
            return { type: 'retreat', destination: retreatHexes[0] };
        }
        console.log('>>> DECISION: DEFEND (no other option)');
        return { type: 'defend' };
    }

    // 1.5. URGENT: Contest flag if enemy is close to winning via flag capture
    if (!unit.engagedWith && unit.ap > 0 &&
        typeof captureTheFlagEnabled !== 'undefined' && captureTheFlagEnabled &&
        typeof hexNumToCoord !== 'undefined' && typeof CENTRAL_HEX_NUM !== 'undefined' &&
        typeof centralHexControl !== 'undefined') {

        const aiColor = aiTeam === 'green' ? GCOL : RCOL;

        // If enemy controls flag and is getting close to winning (4+ turns)
        if (centralHexControl.team && centralHexControl.team !== aiColor && centralHexControl.turns >= 4) {
            const centralCoord = hexNumToCoord.get(CENTRAL_HEX_NUM);
            if (centralCoord) {
                const reachable = calculateReachable(unit);
                const flagKey = `${centralCoord.c},${centralCoord.r}`;

                // Can we reach the flag this turn?
                if (reachable.has(flagKey)) {
                    const flagData = reachable.get(flagKey);
                    console.log('>>> URGENT: Contesting flag! Enemy at', centralHexControl.turns, 'turns');
                    return { type: 'move', destination: { c: centralCoord.c, r: centralCoord.r, cost: flagData.cost } };
                }

                // Can we get close to the flag?
                let closestToFlag = null;
                let minDist = Infinity;
                reachable.forEach((data, key) => {
                    const [c, r] = key.split(',').map(Number);
                    const dist = hexDistance(c, r, centralCoord.c, centralCoord.r);
                    if (dist < minDist) {
                        minDist = dist;
                        closestToFlag = { c, r, cost: data.cost };
                    }
                });

                if (closestToFlag && minDist <= 2 && aiDifficulty !== 'easy') {
                    console.log('>>> URGENT: Moving toward flag to contest, dist:', minDist);
                    return { type: 'move', destination: closestToFlag };
                }
            }
        }
    }

    // 1.6. Shieldman special actions: Regroup and Shield
    if (unit.type === 'shieldman' && unit.ap >= 1 && !unit.engagedWith) {
        const maxHP = isGeneral(unit) ? 8 : 6;
        const regroupUsed = unit.regroupCount || 0;
        const aiColor = aiTeam === 'green' ? GCOL : RCOL;

        // Check for nearby enemy archers
        const enemyArchers = pieces.filter(p => p.color !== aiColor && p.hp > 0 && p.canShoot);
        let archerThreat = false;
        for (const archer of enemyArchers) {
            const dist = hexDistance(unit.c, unit.r, archer.c, archer.r);
            if (dist <= (archer.shootRange || 3)) {
                archerThreat = true;
                break;
            }
        }

        // Use Shield if there are enemy archers in range and shield not active
        if (archerThreat && !unit.shieldActive && (aiDifficulty === 'hard' || (aiDifficulty === 'normal' && Math.random() > 0.3))) {
            console.log('>>> DECISION: SHIELD (enemy archers in range)');
            return { type: 'shield' };
        }

        // Use Regroup if HP is low and conditions are met
        if (unit.hp < maxHP && regroupUsed < 2 && !unit.regroupedThisTurn) {
            // Regroup if HP is below 50% or if General and below 70%
            const hpThreshold = isGeneral(unit) ? maxHP * 0.7 : maxHP * 0.5;
            if (unit.hp <= hpThreshold || (aiDifficulty === 'hard' && unit.hp < maxHP - 1)) {
                console.log('>>> DECISION: REGROUP (HP:', unit.hp, '/', maxHP, ')');
                return { type: 'regroup' };
            }
        }
    }

    // 2. Ranged unit - shoot if possible
    if (unit.canShoot && unit.ap >= 1 && !unit.engagedWith) {
        const target = findShootTarget(unit);
        if (target) {
            if (aiDifficulty === 'easy' && Math.random() > 0.7) {
                // Skip shooting sometimes
            } else {
                return { type: 'shoot', target };
            }
        }
    }

    // 3. Melee - attack adjacent enemy
    if (unit.canMelee !== false && unit.ap > 0) {
        // Check if this unit has General feature - avoid suicidal attacks
        const unitIsGeneral = isGeneral(unit);

        if (unit.engagedWith && unit.isAggressor && unit.engagedWith.hp > 0) {
            // Check if counter-attack would kill our General
            const enemy = unit.engagedWith;
            const enemyCounterDmg = enemy.melee ? enemy.melee.counter : 1;
            if (unitIsGeneral && unit.hp <= enemyCounterDmg) {
                // Don't attack - would lose the game!
                return { type: 'pass' };
            }
            return { type: 'attack', target: unit.engagedWith };
        }
        if (!unit.engagedWith) {
            const attackTarget = findAdjacentEnemy(unit);
            if (attackTarget && attackTarget.hp > 0) {
                // Check if counter-attack would kill our General
                const enemyCounterDmg = attackTarget.melee ? attackTarget.melee.counter : 1;
                if (unitIsGeneral && unit.hp <= enemyCounterDmg) {
                    // Don't attack - would lose the game!
                    // Instead, try to move away or pass
                } else {
                    if (aiDifficulty === 'hard' || aiDifficulty === 'normal') {
                        const adjEnemies = getNeighbors(unit.c, unit.r)
                            .map(n => pieces.find(p => p.c === n.c && p.r === n.r && p.color !== unit.color && p.hp > 0))
                            .filter(Boolean);

                        // Filter out enemies that would kill our General with counter-attack
                        const safeEnemies = unitIsGeneral
                            ? adjEnemies.filter(e => {
                                const counterDmg = e.melee ? e.melee.counter : 1;
                                return unit.hp > counterDmg;
                            })
                            : adjEnemies;

                        if (safeEnemies.length > 0) {
                            const general = safeEnemies.find(e => isGeneral(e));
                            if (general) return { type: 'attack', target: general };
                            if (aiDifficulty !== 'easy') {
                                const weakest = safeEnemies.reduce((w, e) => (!w || e.hp < w.hp) ? e : w, null);
                                if (weakest) return { type: 'attack', target: weakest };
                            }
                            return { type: 'attack', target: safeEnemies[0] };
                        }
                    } else {
                        return { type: 'attack', target: attackTarget };
                    }
                }
            }
        }
    }

    // 4. DANGER CHECK: Consider rotating BEFORE moving if currently exposed
    // This prevents the AI from moving while its back is to a threat
    if ((aiDifficulty === 'hard' || aiDifficulty === 'normal') && !unit.engagedWith) {
        const currentDanger = calculatePositionDanger(unit.c, unit.r, unit.rotation, unit);
        const safeRotation = calculateSafestRotation(unit.c, unit.r, unit);
        const dangerWithSafeRotation = calculatePositionDanger(unit.c, unit.r, safeRotation, unit);

        // If rotating would significantly reduce danger, do it first
        if (currentDanger > 15 && dangerWithSafeRotation < currentDanger - 10) {
            const rotDir = shouldRotate(unit);
            if (rotDir !== null && (unit.freeTurns > 0 || unit.ap > 0)) {
                console.log('>>> Proactive rotation: danger', currentDanger, '->', dangerWithSafeRotation);
                return { type: 'rotate', direction: rotDir };
            }
        }
    }

    // 5. Move toward enemy (cannot move after attacking unless Swift)
    const hasSwiftFeature = unit.features && unit.features.includes('Swift');
    const canMoveAfterFight = !unit.hasFought || hasSwiftFeature;
    if (unit.ap > 0 && !unit.engagedWith && canMoveAfterFight) {
        const moveTarget = findBestMoveTarget(unit);
        if (moveTarget) {
            if (aiDifficulty === 'easy' && Math.random() > 0.6) {
                const reachable = calculateReachable(unit);
                const hexes = Array.from(reachable.entries());
                if (hexes.length > 1) {
                    const randomHex = hexes[Math.floor(Math.random() * hexes.length)];
                    const [c, r] = randomHex[0].split(',').map(Number);
                    return { type: 'move', destination: { c, r, cost: randomHex[1].cost } };
                }
            }
            if (aiDifficulty === 'hard' && !unit.isRanged) {
                const flankTarget = findFlankingMove(unit);
                if (flankTarget) return { type: 'move', destination: flankTarget };
            }
            return { type: 'move', destination: moveTarget };
        }
    }

    // 6. Rotate toward enemy if needed (also use AP if necessary for safety)
    if (unit.freeTurns > 0 || unit.ap > 0) {
        const rotDir = shouldRotate(unit);
        if (rotDir !== null) {
            // For normal/hard AI, also check if rotation is worthwhile using AP
            if (unit.freeTurns > 0) {
                return { type: 'rotate', direction: rotDir };
            } else if (aiDifficulty !== 'easy') {
                // Use AP for rotation if it reduces danger significantly
                const currentDanger = calculatePositionDanger(unit.c, unit.r, unit.rotation, unit);
                if (currentDanger > 10) {
                    return { type: 'rotate', direction: rotDir };
                }
            }
        }
    }

    return { type: 'none' };
}

// ===== AI ACTION EXECUTION =====

function executeAIAction(unit, action, callback) {
    console.log('=== EXECUTE AI ACTION ===');
    console.log('Unit:', unit.type, 'at', unit.c, unit.r);
    console.log('Action:', action ? action.type : 'none');

    if (!action || action.type === 'none') {
        if (callback) callback();
        return;
    }

    // Save state for replay/undo before AI action (same as player actions)
    saveStateForUndo();

    if (action.type === 'retreat') {
        // AI retreat - similar to player retreat
        const enemy = unit.engagedWith;
        const dest = action.destination;
        console.log('=== AI RETREAT ATTEMPT (v2 - with aggressor move) ===');
        console.log('Unit:', unit.type, 'at', unit.c, unit.r);
        console.log('Enemy:', enemy ? enemy.type + ' at ' + enemy.c + ',' + enemy.r : 'NULL');
        console.log('Destination:', dest ? dest.c + ',' + dest.r : 'NULL');
        console.log('Version check: This log confirms v2 code is running');

        if (enemy && dest) {
            const oldC = unit.c, oldR = unit.r;

            // Verify enemy is in pieces array (not a stale reference)
            const actualEnemy = pieces.find(p => p === enemy);
            console.log('Enemy in pieces array?', !!actualEnemy);
            console.log('Enemy position BEFORE:', enemy.c, enemy.r);

            // CRITICAL: Validate retreat destination is not occupied
            const destOccupied = pieces.some(p => p !== unit && p.hp > 0 && p.c === dest.c && p.r === dest.r);
            if (destOccupied) {
                console.error('AI RETREAT BLOCKED: destination', dest.c, dest.r, 'is occupied! Retreat cancelled.');
                if (callback) setTimeout(callback, 100);
                return;
            }

            // Verify units are actually adjacent
            const dist = hexDistance(unit.c, unit.r, enemy.c, enemy.r);
            if (dist !== 1) {
                console.log('ERROR: Units not adjacent for AI retreat! Distance:', dist);
                // Clear invalid engagement and skip retreat
                unit.engagedWith = null;
                unit.isAggressor = false;
                enemy.engagedWith = null;
                enemy.isAggressor = false;
                if (callback) setTimeout(callback, 100);
                return;
            }

            // Clear any active combat
            activeCombat = null;

            // Unit takes retreat damage
            unit.hp -= 1;
            const defenderPos = getHexCenter(unit.c, unit.r);
            addFloatingText(defenderPos.x, defenderPos.y - 20 * scale, '-1', '#ff4444', 28, 'up-right');
            addFloatingText(defenderPos.x, defenderPos.y - 30 * scale, 'RETREAT!', '#ffaa00', 24, 'scale');

            // Move unit to new position
            // Retreating: unit faces the aggressor (who moves to unit's old position)
            console.log('Unit moving from', unit.c, unit.r, 'to', dest.c, dest.r);
            console.log('oldC/oldR captured as:', oldC, oldR);
            unit.c = dest.c;
            unit.r = dest.r;
            // Face the aggressor's new position (which is our old position)
            const newPos = getHexCenter(dest.c, dest.r);
            const aggressorNewPos = getHexCenter(oldC, oldR);
            unit.rotation = snapRotation(Math.atan2(aggressorNewPos.y - newPos.y, aggressorNewPos.x - newPos.x));
            unit.freeTurns = 1;
            unit.ap = Math.max(0, unit.ap - 1);  // Retreat consumes 1 AP

            // Aggressor moves to unit's old position
            console.log('Moving aggressor from', enemy.c, enemy.r, 'to', oldC, oldR);
            enemy.c = oldC;
            enemy.r = oldR;
            console.log('Aggressor position AFTER assignment:', enemy.c, enemy.r);
            const newEnemyPos = getHexCenter(oldC, oldR);
            const newUnitPos = getHexCenter(dest.c, dest.r);
            enemy.rotation = snapRotation(Math.atan2(newUnitPos.y - newEnemyPos.y, newUnitPos.x - newEnemyPos.x));

            // Verify change persisted in pieces array
            const enemyInPieces = pieces.find(p => p === enemy);
            console.log('Enemy in pieces after move:', enemyInPieces ? (enemyInPieces.c + ',' + enemyInPieces.r) : 'NOT FOUND');

            // Clear engagement
            enemy.engagedWith = null;
            enemy.isAggressor = false;
            unit.engagedWith = null;
            unit.isAggressor = false;

            // Note: Don't set hasFought for retreating unit - they can still act!
            // The aggressor already has hasFought=true from initial combat

            console.log('=== AI RETREAT COMPLETE ===');
            console.log('Unit now at:', unit.c, unit.r);
            console.log('Enemy now at:', enemy.c, enemy.r);
            console.log('Unit engagedWith:', unit.engagedWith);
            console.log('Enemy engagedWith:', enemy.engagedWith);

            // Check for death from retreat damage
            if (unit.hp <= 0) {
                removeDeadUnits();
                const winner = checkVictory();
                if (winner) { showVictory(winner); }
            }

            playSound('footstep');
            draw();

            // Final verification - log all piece positions
            console.log('=== FINAL POSITIONS AFTER DRAW ===');
            pieces.filter(p => p.hp > 0).forEach(p => {
                console.log(p.type, p.color, 'at', p.c, p.r, 'isGeneral:', isGeneral(p));
            });
        }
        if (callback) setTimeout(callback, 400);
        return;
    } else if (action.type === 'counter') {
        const enemy = unit.engagedWith;
        if (enemy) {
            unit.ap = 0;
            unit.isAggressor = true;
            enemy.isAggressor = false;
            startMeleeCombat(unit, enemy, false);
        }
    } else if (action.type === 'defend') {
        const agg = unit.engagedWith;
        if (agg) {
            unit.ap = 0;
            startMeleeCombat(agg, unit, true);
        }
    } else if (action.type === 'shoot') {
        const target = action.target;
        if (target && unit.ap >= 1) {
            handleShoot(unit, { c: target.c, r: target.r });
        }
    } else if (action.type === 'attack') {
        const target = action.target;
        const validTarget = pieces.find(p => p.c === target.c && p.r === target.r && p.color !== unit.color && p.hp > 0);
        if (validTarget) {
            const unitPos = getHexCenter(unit.c, unit.r);
            const targetPos = getHexCenter(validTarget.c, validTarget.r);
            unit.rotation = snapRotation(Math.atan2(targetPos.y - unitPos.y, targetPos.x - unitPos.x));
            startMeleeCombat(unit, validTarget, false);
            unit.ap = 0;
        }
    } else if (action.type === 'move') {
        // Engaged units cannot move!
        if (unit.engagedWith) {
            console.log('ERROR: Attempted to move engaged unit - blocking move');
            if (callback) setTimeout(callback, 100);
            return;
        }
        const dest = action.destination;
        if (dest) {
            // CRITICAL: Validate destination is not occupied before moving
            const destOccupied = pieces.some(p => p !== unit && p.hp > 0 && p.c === dest.c && p.r === dest.r);
            if (destOccupied) {
                console.error('AI MOVE BLOCKED: destination', dest.c, dest.r, 'is already occupied! Unit stays at', unit.c, unit.r);
                if (callback) setTimeout(callback, 100);
                return;
            }
            console.log('AI moving unit from', unit.c, unit.r, 'to', dest.c, dest.r);
            startMovementAnimation(unit, dest.c, dest.r, dest.cost, callback);
            return; // Animation handles callback
        }
    } else if (action.type === 'rotate') {
        const dir = action.direction;
        if (unit.freeTurns > 0 || unit.ap > 0) {
            startRotationAnimation(unit, dir, callback);
            return; // Animation handles callback
        }
    } else if (action.type === 'regroup') {
        // Shieldman Regroup: restore 1 HP
        const maxHP = isGeneral(unit) ? 8 : 6;
        unit.hp = Math.min(unit.hp + 1, maxHP);
        unit.regroupCount = (unit.regroupCount || 0) + 1;
        unit.regroupedThisTurn = true;
        unit.ap -= 1;
        const pos = getHexCenter(unit.c, unit.r);
        addFloatingText(pos.x, pos.y - 20 * scale, '+1', '#22c55e', 28, 'up');
        addFloatingText(pos.x, pos.y - 30 * scale, 'REGROUP', '#22c55e', 22, 'scale');
        playSound('heal');
        console.log('AI Shieldman Regroup: HP now', unit.hp, '/', maxHP);
    } else if (action.type === 'shield') {
        // Shieldman Shield: activate arrow blocking
        unit.shieldActive = true;
        unit.shieldBlockedArchers = [];
        unit.ap -= 1;
        const pos = getHexCenter(unit.c, unit.r);
        addFloatingText(pos.x, pos.y - 20 * scale, 'SHIELD!', '#6b8b8b', 26, 'scale');
        playSound('equip');
        console.log('AI Shieldman Shield activated');
    }

    draw();
    if (callback) setTimeout(callback, 100);
}

function processAIUnit(units, index) {
    // Check for victory after each action
    const winner = checkVictory();
    if (winner) {
        aiProcessing = false;
        showVictory(winner);
        return;
    }

    // Wait for any ongoing animations
    if (interactionState === 'animating' || activeMovement || activeRotation || activeProjectiles.length > 0 || activeCombat) {
        setTimeout(() => processAIUnit(units, index), 400);
        return;
    }

    if (index >= units.length) {
        aiProcessing = false;
        setTimeout(window.endTurn, 800);
        return;
    }

    const unit = units[index];

    // Log unit status
    console.log('--- Processing unit', index, '---');
    console.log('Type:', unit.type, 'HP:', unit.hp, 'AP:', unit.ap);
    console.log('Features:', unit.features);
    console.log('isGeneral:', isGeneral(unit));
    console.log('engagedWith:', unit.engagedWith ? unit.engagedWith.type : 'none');
    console.log('isAggressor:', unit.isAggressor);

    // Skip if unit is dead or has no AP
    if (!pieces.includes(unit) || unit.hp <= 0) {
        console.log('Skipping - unit dead or not in pieces');
        setTimeout(() => processAIUnit(units, index + 1), 300);
        return;
    }

    // Engaged defenders MUST choose an action (defend/counter/retreat) even if they have 0 AP
    // Defend doesn't cost AP, so they can always act
    const isEngagedDefender = unit.engagedWith && !unit.isAggressor;

    // Keep acting while unit has AP, OR if unit is an engaged defender
    if (unit.ap > 0 || unit.freeTurns > 0 || isEngagedDefender) {
        const action = decideAction(unit);
        if (action.type !== 'none') {
            // After defend/counter/attack, move to next unit
            // After retreat, unit can continue acting with remaining AP
            const moveToNextAfter = (action.type === 'defend' || action.type === 'counter' || action.type === 'attack');
            executeAIAction(unit, action, () => {
                if (moveToNextAfter) {
                    setTimeout(() => processAIUnit(units, index + 1), 600);
                } else {
                    setTimeout(() => processAIUnit(units, index), 600);
                }
            });
            return;
        }
    }

    // Move to next unit
    setTimeout(() => processAIUnit(units, index + 1), 600);
}

function executeAITurn() {
    console.log('=== AI TURN START (code version: v4-stacking-fix) ===');
    if (aiProcessing) return;
    aiProcessing = true;

    // STACKING DETECTION: Check if any units are stacked at turn start
    const positionMap = new Map();
    pieces.filter(p => p.hp > 0).forEach(p => {
        const key = `${p.c},${p.r}`;
        if (positionMap.has(key)) {
            console.error('STACKING DETECTED at', key, ':', positionMap.get(key).type, 'and', p.type);
        } else {
            positionMap.set(key, p);
        }
    });

    const aiColor = aiTeam === 'green' ? GCOL : RCOL;
    let aiUnits = pieces.filter(p => p.color === aiColor && p.hp > 0);

    // Find if our General is engaged and in danger
    const ourGeneral = aiUnits.find(u => isGeneral(u));
    console.log('Our General:', ourGeneral ? (ourGeneral.type + ' HP:' + ourGeneral.hp + ' at ' + ourGeneral.c + ',' + ourGeneral.r) : 'NOT FOUND');
    console.log('General engagedWith:', ourGeneral && ourGeneral.engagedWith ? ourGeneral.engagedWith.type : 'none');
    console.log('General isAggressor:', ourGeneral ? ourGeneral.isAggressor : 'N/A');

    const generalInDanger = ourGeneral && ourGeneral.engagedWith && !ourGeneral.isAggressor;
    console.log('General in danger (engaged as defender)?', generalInDanger);
    const generalEnemy = generalInDanger ? ourGeneral.engagedWith : null;

    // Log all engaged AI units
    const engagedUnits = aiUnits.filter(u => u.engagedWith);
    console.log('Engaged AI units:', engagedUnits.length);
    engagedUnits.forEach(u => {
        console.log('  -', u.type, 'at', u.c + ',' + u.r, 'engaged with', u.engagedWith.type, 'isAggressor:', u.isAggressor);
    });

    // Sort units by priority
    aiUnits.sort((a, b) => {
        // Priority 1: Units that can attack the enemy engaging our General (to free the General)
        if (generalInDanger && generalEnemy) {
            const aCanFreeGeneral = !a.engagedWith && a.ap > 0 && a.canMelee !== false &&
                getNeighbors(a.c, a.r).some(n => n.c === generalEnemy.c && n.r === generalEnemy.r);
            const bCanFreeGeneral = !b.engagedWith && b.ap > 0 && b.canMelee !== false &&
                getNeighbors(b.c, b.r).some(n => n.c === generalEnemy.c && n.r === generalEnemy.r);
            if (aCanFreeGeneral && !bCanFreeGeneral) return -1;
            if (!aCanFreeGeneral && bCanFreeGeneral) return 1;

            // Units that can shoot the enemy engaging General (check LOS and arrow blocking)
            const canShootTarget = (shooter, target) => {
                if (!shooter.canShoot || shooter.ap < 1 || shooter.engagedWith) return false;
                const dist = hexDistance(shooter.c, shooter.r, target.c, target.r);
                if (dist > (shooter.shootRange || 3) || dist <= 0) return false;
                if (typeof hasLineOfSight !== 'undefined' && !hasLineOfSight(shooter.c, shooter.r, target.c, target.r)) return false;
                // Check arrow blocking by terrain
                if (typeof DemoRules !== 'undefined' && typeof terrain !== 'undefined') {
                    const targetTerrain = terrain.get(`${target.c},${target.r}`);
                    if (DemoRules.isArrowBlocked(targetTerrain, dist)) return false;
                }
                return true;
            };
            const aCanShootGenEnemy = canShootTarget(a, generalEnemy);
            const bCanShootGenEnemy = canShootTarget(b, generalEnemy);
            if (aCanShootGenEnemy && !bCanShootGenEnemy) return -1;
            if (!aCanShootGenEnemy && bCanShootGenEnemy) return 1;
        }

        // Priority 2: Archers with shoot opportunities
        const aCanShoot = a.canShoot && a.ap >= 1 && !a.engagedWith && findShootTarget(a);
        const bCanShoot = b.canShoot && b.ap >= 1 && !b.engagedWith && findShootTarget(b);
        if (aCanShoot && !bCanShoot) return -1;
        if (!aCanShoot && bCanShoot) return 1;

        // Priority 3: Engaged defenders (but General goes LAST so others can free them first)
        const aEngaged = a.engagedWith && !a.isAggressor;
        const bEngaged = b.engagedWith && !b.isAggressor;
        if (aEngaged && bEngaged) {
            // General should act last among engaged units
            if (isGeneral(a) && !isGeneral(b)) return 1;
            if (!isGeneral(a) && isGeneral(b)) return -1;
        }
        if (aEngaged && !bEngaged) return -1;
        if (!aEngaged && bEngaged) return 1;

        return 0;
    });

    // For normal and hard difficulty, use MCTS to decide first action
    if (aiDifficulty === 'normal' || aiDifficulty === 'hard') {
        const timeLimit = aiDifficulty === 'hard' ? MCTS_TIME_LIMIT * 2 : MCTS_TIME_LIMIT;
        console.log(`Running MCTS (${aiDifficulty}, ${timeLimit}ms)...`);
        const mctsAction = runMCTS(timeLimit);
        if (mctsAction && mctsAction.type !== 'pass') {
            console.log('MCTS decided:', mctsAction.type);
            const unit = pieces.find(p =>
                p.c === mctsAction.unit.c &&
                p.r === mctsAction.unit.r &&
                p.color === mctsAction.unit.color
            );
            if (unit) {
                // IMPORTANT: If unit is engaged, skip MCTS action and let decideAction handle it
                // MCTS doesn't properly simulate engagements
                if (unit.engagedWith) {
                    console.log('MCTS unit is engaged - skipping MCTS action, will use decideAction');
                    setTimeout(() => processAIUnit(aiUnits, 0), 500);
                    return;
                }

                let action = { type: 'none' };
                if (mctsAction.type === 'shoot') {
                    action = { type: 'shoot', target: mctsAction.target };
                } else if (mctsAction.type === 'attack') {
                    action = { type: 'attack', target: mctsAction.target };
                } else if (mctsAction.type === 'move') {
                    action = { type: 'move', destination: { c: mctsAction.dest.c, r: mctsAction.dest.r, cost: 1 } };
                } else if (mctsAction.type === 'defend') {
                    action = { type: 'defend' };
                } else if (mctsAction.type === 'counter') {
                    action = { type: 'counter' };
                } else if (mctsAction.type === 'rotate') {
                    action = { type: 'rotate', direction: mctsAction.dir };
                }

                setTimeout(() => {
                    executeAIAction(unit, action, () => {
                        setTimeout(() => processAIUnit(aiUnits, 0), 300);
                    });
                }, 500);
                return;
            }
        }
    }

    setTimeout(() => processAIUnit(aiUnits, 0), 800);
}

// Initialize MCTS data on load
loadMCTSData();
