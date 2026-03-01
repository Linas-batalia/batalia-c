/**
 * Demo Game Rules - Terrain-based modifications for Demo mode
 * This file extends the base game rules with terrain effects on units.
 * Changes here only affect Demo mode, not Classic or Arcade.
 *
 * Custom values can be set via units_table.html and are stored in localStorage.
 */

const DemoRules = (function() {
    'use strict';

    // ========== CUSTOM VALUES FROM LOCALSTORAGE ==========
    let customMovementCost = null;

    // Load custom terrain data from localStorage (set by units_table.html)
    function loadCustomTerrainData() {
        try {
            const saved = localStorage.getItem('bataliaTerrainData');
            console.log('DemoRules: Loading terrain data from localStorage:', saved ? 'found' : 'not found');
            if (saved) {
                const data = JSON.parse(saved);
                console.log('DemoRules: Parsed terrain data:', data);
                if (data.movementCost) {
                    customMovementCost = {};
                    Object.entries(data.movementCost).forEach(([terrain, units]) => {
                        customMovementCost[terrain] = {};
                        Object.entries(units).forEach(([unit, value]) => {
                            // Parse value - handle infinity symbol
                            if (value === '∞' || value === 'Infinity' || value === 'infinity') {
                                customMovementCost[terrain][unit] = Infinity;
                            } else {
                                const num = parseFloat(value);
                                if (!isNaN(num)) {
                                    customMovementCost[terrain][unit] = num;
                                }
                            }
                        });
                    });
                    console.log('DemoRules: Loaded custom movement costs:', customMovementCost);
                }
            }
        } catch (e) {
            console.warn('DemoRules: Could not load custom terrain data:', e);
        }
    }

    // Initialize custom data
    loadCustomTerrainData();

    // ========== TERRAIN DEFINITIONS ==========

    const TERRAIN_TYPES = {
        PLAINS: 'plains',
        FOREST: 'forest',
        HILLS: 'hills',              // Blocks ALL line of sight
        HIGHLAND: 'highland',        // Blocks LoS to lowland only (can shoot over to elevated)
        HILLS_FOREST: 'hillsForest',
        HIGHLAND_FOREST: 'highlandForest',
        LAKE: 'lake'
    };

    // ========== UNIT CATEGORIES ==========

    // Mounted units (cavalry, horses, elephants)
    const MOUNTED_UNITS = ['knight', 'light_cavalry', 'heavy_cavalry', 'cavalry', 'elephant'];

    // Ranged units (bows, crossbows)
    const RANGED_UNITS = ['archer', 'bowman', 'arbalest', 'longbowman', 'crossbowman'];

    /**
     * Get unit category for terrain effects
     * @param {string} unitType - The unit type
     * @param {Object} unitData - Optional unit data object with isRanged property
     * @returns {string} - 'mounted', 'ranged', or 'melee'
     */
    function getUnitCategory(unitType, unitData) {
        // Check if mounted
        if (MOUNTED_UNITS.includes(unitType)) {
            return 'mounted';
        }
        // Check if ranged (by type or by unitData.isRanged)
        if (RANGED_UNITS.includes(unitType) || (unitData && unitData.isRanged)) {
            return 'ranged';
        }
        // Default to melee
        return 'melee';
    }

    // ========== MOVEMENT MODIFIERS ==========

    // AP cost modifiers when entering terrain (multiplier)
    // 1.0 = normal cost, 2.0 = double cost, 0.5 = half cost
    // Categories: mounted (cavalry), melee (infantry), ranged (archers)
    const MOVEMENT_COST = {
        plains: {
            mounted: 1.0,
            melee: 1.0,
            ranged: 1.0
        },
        forest: {
            mounted: 1.5,     // Cavalry slowed in forest
            melee: 1.0,
            ranged: 1.0
        },
        hills: {
            mounted: 2.0,     // All units slowed on hills
            melee: 2.0,
            ranged: 2.0
        },
        highland: {
            mounted: 1.0,     // Highland acts like plains once on it
            melee: 1.0,
            ranged: 1.0
        },
        hillsForest: {
            mounted: 2.0,     // Very difficult terrain
            melee: 2.0,
            ranged: 2.0
        },
        highlandForest: {
            mounted: 1.5,     // Highland+forest: forest penalty only
            melee: 1.0,
            ranged: 1.0
        },
        lake: {
            mounted: Infinity, // Cannot enter
            melee: Infinity,
            ranged: Infinity
        }
    };

    // ========== RANGED COMBAT MODIFIERS ==========

    // Arrow protection: if distance > threshold, arrows deal no damage
    // null = no protection, 1 = protected if shooter > 1 hex away
    const ARROW_PROTECTION = {
        plains: null,         // No arrow protection
        forest: 1,            // Arrows blocked if shooter > 1 hex away
        hills: null,          // No arrow protection
        highland: null,       // No arrow protection
        hillsForest: 1,       // Arrows blocked if shooter > 1 hex away
        highlandForest: 1,    // Arrows blocked if shooter > 1 hex away
        lake: null
    };

    // Maximum shooting range from terrain (archer in this terrain)
    const MAX_SHOOT_RANGE = {
        plains: 3,            // Normal range
        forest: 1,            // Can only shoot 1 hex from forest
        hills: 3,             // Normal range (no bonus)
        highland: 3,          // Normal range (no bonus)
        hillsForest: 1,       // Forest limits range
        highlandForest: 1,    // Forest limits range
        lake: 0
    };

    // ========== MELEE COMBAT MODIFIERS ==========

    // Whether attacker locks (engages) defender when attacking into this terrain
    const COMBAT_LOCK = {
        plains: true,         // Normal locking
        forest: true,         // Normal locking
        hills: false,         // Attacker does NOT lock defender on hills
        highland: true,       // Highland acts like plains - normal locking
        hillsForest: false,   // Attacker does NOT lock defender
        highlandForest: true, // Highland+forest: normal locking (highland rules)
        lake: false
    };

    // Whether phase 3 attack is allowed without Mountaineer feature
    // true = normal (phase 1 and 3), false = only phase 1 without Mountaineer
    const ALLOW_PHASE_3 = {
        plains: true,
        forest: true,
        hills: false,         // Phase 3 requires Mountaineer
        highland: true,       // Highland acts like plains - normal combat
        hillsForest: false,   // Phase 3 requires Mountaineer
        highlandForest: true, // Highland+forest: highland rules apply
        lake: true
    };

    // ========== SPECIAL UNIT ABILITIES IN TERRAIN ==========

    const UNIT_TERRAIN_ABILITIES = {
        knight: {
            // Charge works on plains and highland (elevated plains)
            chargeTerrains: ['plains', 'highland'],
            // Cannot use Charge when attacking into these terrains
            noChargeInto: ['forest', 'hills', 'hillsForest', 'highlandForest', 'lake']
        },
        shieldman: {
            // No terrain-specific abilities, uses general hill rules
        },
        archer: {
            // No range bonus from any terrain
            rangeBonus: {},
            // Range limited in forest
            rangePenalty: {
                forest: 2,        // Reduce from 3 to 1
                hillsForest: 2,   // Reduce from 3 to 1
                highlandForest: 2 // Reduce from 3 to 1
            }
        }
    };

    // ========== VISIBILITY / LINE OF SIGHT ==========

    const BLOCKS_LOS = {
        plains: false,
        forest: true,     // Blocks line of sight for ranged attacks
        hills: true,      // Hills block ALL line of sight (cannot shoot over)
        highland: false,  // Highland blocks LoS to lowland only (handled in game.html)
        hillsForest: true,
        highlandForest: true,
        lake: false
    };

    // ========== HELPER FUNCTIONS ==========

    /**
     * Get terrain type for a hex
     * @param {Object} terrainData - The terrain data from terrain.get(key)
     * @returns {string} - Terrain type constant
     */
    function getTerrainType(terrainData) {
        if (!terrainData) return TERRAIN_TYPES.PLAINS;
        if (terrainData.lake) return TERRAIN_TYPES.LAKE;
        if (terrainData.hill && terrainData.forest) return TERRAIN_TYPES.HILLS_FOREST;
        if (terrainData.highland && terrainData.forest) return TERRAIN_TYPES.HIGHLAND_FOREST;
        if (terrainData.hill) return TERRAIN_TYPES.HILLS;
        if (terrainData.highland) return TERRAIN_TYPES.HIGHLAND;
        if (terrainData.forest) return TERRAIN_TYPES.FOREST;
        return TERRAIN_TYPES.PLAINS;
    }

    /**
     * Get movement cost multiplier for unit entering terrain
     * @param {string} unitType - Unit type (e.g., 'knight', 'warrior', 'archer')
     * @param {Object} terrainData - The terrain data
     * @param {Object} unitData - Optional unit data object with isRanged property
     * @returns {number} - Cost multiplier
     */
    function getMovementCost(unitType, terrainData, unitData) {
        const terrainType = getTerrainType(terrainData);
        const category = getUnitCategory(unitType, unitData);

        // First try custom values from localStorage (set via units_table.html)
        if (customMovementCost && customMovementCost[terrainType]) {
            const customValue = customMovementCost[terrainType][category];
            if (customValue !== undefined && !isNaN(customValue)) {
                return customValue;
            }
        }

        // Fall back to hardcoded defaults
        const costs = MOVEMENT_COST[terrainType];
        return costs ? (costs[category] || 1.0) : 1.0;
    }

    /**
     * Check if arrows are blocked by terrain based on distance
     * @param {Object} targetTerrain - Terrain where target is standing
     * @param {number} distance - Distance in hexes from shooter to target
     * @returns {boolean} - Whether arrows are blocked (true = no damage)
     */
    function isArrowBlocked(targetTerrain, distance) {
        const terrainType = getTerrainType(targetTerrain);
        const protectionThreshold = ARROW_PROTECTION[terrainType];

        // If no protection, arrows always hit
        if (protectionThreshold === null) return false;

        // If distance > threshold, arrows are blocked
        return distance > protectionThreshold;
    }

    /**
     * Get maximum shooting range for archer in terrain
     * @param {Object} archerTerrain - Terrain where archer is standing
     * @returns {number} - Maximum shooting range in hexes
     */
    function getMaxShootRange(archerTerrain) {
        const terrainType = getTerrainType(archerTerrain);
        return MAX_SHOOT_RANGE[terrainType] !== undefined ? MAX_SHOOT_RANGE[terrainType] : 3;
    }

    /**
     * Check if attacker locks (engages) defender based on defender's terrain
     * @param {Object} defenderTerrain - Terrain where defender is standing
     * @returns {boolean} - Whether combat lock applies
     */
    function doesCombatLock(defenderTerrain) {
        const terrainType = getTerrainType(defenderTerrain);
        return COMBAT_LOCK[terrainType] !== false;
    }

    /**
     * Check if phase 3 attack is allowed based on defender's terrain
     * @param {Object} defenderTerrain - Terrain where defender is standing
     * @param {boolean} hasMountaineer - Whether attacker has Mountaineer feature
     * @returns {boolean} - Whether phase 3 attack is allowed
     */
    function canAttackPhase3(defenderTerrain, hasMountaineer) {
        const terrainType = getTerrainType(defenderTerrain);

        // If terrain allows phase 3, it's always allowed
        if (ALLOW_PHASE_3[terrainType] !== false) return true;

        // Otherwise, only allowed with Mountaineer feature
        return hasMountaineer === true;
    }

    /**
     * Check if Charge ability can be used
     * @param {string} unitType - Unit type
     * @param {Object} fromTerrain - Terrain unit is charging from
     * @param {Object} toTerrain - Terrain unit is charging into
     * @param {Object} unitData - Optional unit data with features
     * @returns {boolean} - Whether Charge can be used
     */
    function canUseCharge(unitType, fromTerrain, toTerrain, unitData) {
        // Charge requires mounted unit or unit with Charge feature
        const isMounted = getUnitCategory(unitType) === 'mounted';
        const hasChargeFeature = unitData && unitData.features && unitData.features.includes('Charge');
        if (!isMounted && !hasChargeFeature) return false;

        const abilities = UNIT_TERRAIN_ABILITIES.knight;
        const toType = getTerrainType(toTerrain);

        // Charge works when attacking INTO plains (attacker can be anywhere)
        // Cannot charge into non-plains terrains (forest, hills, etc.)
        if (abilities.noChargeInto.includes(toType)) return false;

        return true;
    }

    /**
     * Get maximum archer range based on terrain
     * @param {Object} archerTerrain - Terrain where archer is standing
     * @returns {number} - Maximum range in hexes
     */
    function getArcherRangeModifier(archerTerrain) {
        // Return the difference from base range (3)
        return getMaxShootRange(archerTerrain) - 3;
    }

    /**
     * Check if terrain blocks line of sight
     * @param {Object} terrainData - The terrain data
     * @returns {boolean} - Whether terrain blocks LOS
     */
    function blocksLineOfSight(terrainData) {
        const terrainType = getTerrainType(terrainData);
        return BLOCKS_LOS[terrainType] || false;
    }

    /**
     * Get shieldman brace bonus in terrain (removed - no terrain-specific shieldman abilities)
     * @param {Object} terrainData - The terrain data
     * @returns {number} - Brace bonus (always 0 now)
     */
    function getBraceBonus(terrainData) {
        return 0; // Shieldmen have no terrain-specific abilities
    }

    // ========== PUBLIC API ==========

    return {
        // Constants
        TERRAIN_TYPES,
        MOVEMENT_COST,
        ARROW_PROTECTION,
        MAX_SHOOT_RANGE,
        COMBAT_LOCK,
        ALLOW_PHASE_3,
        UNIT_TERRAIN_ABILITIES,
        BLOCKS_LOS,
        MOUNTED_UNITS,
        RANGED_UNITS,

        // Functions
        getTerrainType,
        getUnitCategory,
        getMovementCost,
        isArrowBlocked,
        getMaxShootRange,
        doesCombatLock,
        canAttackPhase3,
        canUseCharge,
        getArcherRangeModifier,
        blocksLineOfSight,
        getBraceBonus,
        loadCustomTerrainData, // Reload custom values from localStorage

        // Version
        VERSION: '1.2.0'
    };
})();

// Make available globally if needed
if (typeof window !== 'undefined') {
    window.DemoRules = DemoRules;
}

console.log('Demo Rules v' + DemoRules.VERSION + ' loaded');
