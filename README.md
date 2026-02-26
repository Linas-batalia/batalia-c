# Batalia - Hex-based Strategy Game

A turn-based tactical strategy game with hex grid, featuring multiple game modes including online multiplayer.

## Game Modes

- **Classic** - Traditional gameplay without terrain effects
- **Arcade** - Quick matches with simplified rules
- **Demo** - Full terrain system with fog of war, line of sight, and advanced tactics
- **Online Multiplayer** - Play against other players in real-time

## Features

- Hex-based tactical combat
- Multiple unit types: Knights, Archers, Shieldmen, Warriors, and more
- Terrain effects: Hills, Forests, Lakes
- Fog of War and Line of Sight system
- Unit progression and army building
- AI opponent with adjustable difficulty

## Project Structure

```
batalia/
├── client/                 # Game client files
│   ├── game.html          # Main game file
│   ├── ai.js              # AI logic
│   ├── demo-rules.js      # Terrain rules for Demo mode
│   ├── units_table.html   # Unit stats editor
│   └── images/            # Game assets
│
├── server.js              # Socket.io multiplayer server
├── package.json           # Node.js dependencies
├── Dockerfile             # Docker deployment
├── fly.toml               # Fly.io config
├── railway.json           # Railway config
└── README.md
```

## Quick Start (Local Play)

1. Open `game.html` in a web browser
2. Select game mode and configure your army
3. Click "TO BATTLE" to start

## Online Multiplayer Setup

### Server Deployment

#### Option 1: Fly.io (Recommended)

```bash
fly launch
fly deploy
```

#### Option 2: Railway

```bash
# Connect to Railway and deploy via dashboard
```

#### Option 3: Local Development

```bash
npm install
node server.js
```

Server runs on port 8080 by default.

### Client Setup

1. Host the client files on any static hosting (GitHub Pages, Netlify, Vercel)
2. Or open `game.html` locally

### Playing Online

1. Start the game and select "Online" mode
2. Enter your server URL (e.g., `https://your-server.fly.dev`)
3. Create a room or join with a room code
4. Share the 4-character room code with your opponent
5. Both players click "Ready" to start

## Game Rules

### Units

| Unit | HP | AP | Special |
|------|----|----|---------|
| Knight | 8 | 3 | Charge, Trample |
| Shieldman | 6 | 2 | Castle, Shield, Regroup |
| Archer | 5 | 2 | Ranged attack (3 hex) |
| Warrior | 7 | 3 | Castle |

### Terrain (Demo Mode)

- **Plains** - No effects
- **Forest** - Concealment (hidden if >1 hex from enemy), blocks LOS
- **Hills** - Elevated view, blocks LOS to lowland
- **Hill+Forest** - Blocks all LOS, concealment
- **Lake** - Impassable

### Combat

- **Melee** - Adjacent units, uses Attack + Counter values
- **Ranged** - Archers can shoot up to 3 hexes (reduced from hills)
- **Backstab** - +1 damage when attacking from behind
- **Charge** - Knights deal +1 damage on first attack

### Victory Conditions

- Eliminate the enemy General
- Or capture the central flag for 4 turns (Demo mode)

## Development

### Modifying Units

Edit `units_table.html` to customize unit stats. Changes are saved to localStorage.

### Custom Maps

In Demo mode, you can save and load custom terrain maps.

## License

MIT License

## Credits

Created with Claude Code assistance.
