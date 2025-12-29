# Undercover / Mr. White Game

A fun party game for 3-20 players! Play locally on one device (pass-and-play style).

## How to Play

### Game Rules
- **Civilians** get the same word and must find the infiltrators
- **Undercovers** get a similar but different word and must blend in
- **Mr. White** gets no word at all but must deduce what everyone is talking about

Each round:
1. Players describe their word (without saying it directly)
2. Discuss and figure out who's suspicious
3. Vote to eliminate someone
4. If Mr. White is caught, they get one chance to guess the Civilian word to win!

### Win Conditions
- **Civilians win**: Eliminate all infiltrators
- **Infiltrators win**: Outnumber or equal the civilians
- **Mr. White wins**: Correctly guess the Civilian word when eliminated

## Quick Start

### 1. Start a local server

You need a local server because browsers block `fetch()` for local files. Choose one:

```bash
# Python 3
python -m http.server 8000

# Python 2
python -m SimpleHTTPServer 8000

# Node.js (if you have npx)
npx serve .
```

### 2. Open in browser

```
http://localhost:8000
```

### 3. Play!

1. Add player names (3-20 players)
2. Set number of Undercovers and Mr. Whites
3. Start the game
4. Pass the device around for word reveals
5. Have fun!

## Files

- `index.html` - The complete game (HTML + CSS + JavaScript)
- `words.json` - Word pairs for the game (don't peek if you want to play!)
- `README.md` - This file

## Tips

- Best with 5-10 players
- Recommended: 1 Undercover and 1 Mr. White for most games
- The game works great on phones - just pass it around!
- Keep `words.json` secret from yourself to enjoy playing

## Customization

Want to add your own words? Edit `words.json`:

```json
{
  "pairs": [
    { "civilian": "YourWord1", "undercover": "SimilarWord1" },
    { "civilian": "YourWord2", "undercover": "SimilarWord2" }
  ]
}
```

Make sure the words are similar enough to be confusing but different enough to catch!

Enjoy the game!
