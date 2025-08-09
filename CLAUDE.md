# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Chrome extension that tracks time spent playing chess games on Chess.com. The extension automatically detects game sessions, parses time controls, and stores detailed game statistics including duration, opponent, result, and time control data.

## Architecture

### Core Components

- **background.js** - Service worker handling data storage, game deduplication, and message routing
- **content.js** - Content script injected into Chess.com pages for game detection and time tracking
- **popup.js/html/css** - Extension popup UI for viewing statistics and managing data
- **manifest.json** - Chrome extension configuration with Chess.com permissions

### Data Flow

1. **Game Detection**: Content script monitors DOM changes and clock movements on Chess.com
2. **State Machine**: Tracks game states (IDLE → WAITING → IN_GAME → OVER)
3. **Time Extraction**: Parses per-move timestamps from `data-time` attributes when available
4. **Deduplication**: Background script merges duplicate game records using multiple matching strategies
5. **Storage**: Games stored in Chrome local storage, organized by date keys

### Key Features

- **Time Control Detection**: Automatically detects and categorizes games (bullet/blitz/rapid/classical)
- **Multiple Data Sources**: Uses per-move timestamps when available, fallback to dwell time
- **Smart Deduplication**: Prevents duplicate records using game keys, URLs, and timing heuristics
- **Multi-language Support**: Handles French interface elements
- **Export/Reset**: CSV export and data reset functionality

## Development Commands

Since this is a Chrome extension without build tools:

- **Load Extension**: Chrome → Extensions → Developer mode → Load unpacked
- **Debug Content Script**: Enable debug mode in popup settings, check Chess.com console for `[CTT/content]` logs
- **Debug Background**: Check extension service worker console for `[CTT/bg]` logs
- **Test**: Manual testing on Chess.com with different time controls and game scenarios

## Code Architecture Details

### Game State Management (content.js)
- State machine: `IDLE` → `WAITING` → `IN_GAME` → `OVER`
- Detection triggers: clock movement, move count changes, timestamp nodes
- Finalization triggers: game over UI, stable clocks, page unload

### Data Storage Schema (background.js)
- Storage key: `gamesV7` (current version)
- Date-based partitioning: `YYYY-MM-DD` keys
- Game objects contain: timestamps, duration, time control, opponent, result, source

### Time Control Parsing
- Primary: `N+M` format (e.g., "3+2")
- Secondary: Minutes extraction from UI text
- Bucket classification: <3min=bullet, ≤5min=blitz, ≤15min=rapid, >15min=classical

### Deduplication Strategy
1. Exact key match (`live:gameId` or `href:url`)
2. Same URL + result + endedAt within 60s
3. Same URL + startedAt within 60s
4. Merge strategy preserves maximum duration and most complete data

## Important Implementation Notes

- Extension uses Manifest V3 with service worker
- All DOM queries use multiple selectors for Chess.com UI variations
- French language support throughout UI
- Debug mode toggle affects console logging verbosity
- Legacy storage keys (`gamesV4-V6`) are cleaned up on reset