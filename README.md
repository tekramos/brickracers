# Brick Racers

A cartoon brick kart racer for up to 5 players, inspired by the classic brick racing games of the
late 90s. The race runs in the browser on a big screen; every player uses their phone as the controller.
Built with three.js (WebGPU, falling back to WebGL 2 by itself).

Created by **Tekramos** · [www.tekramos.com](https://www.tekramos.com)

## Play

Serve the folder over http(s) (any static host: GitHub Pages, Vercel, Netlify, or `python3 -m http.server`)
and open `index.html` on the computer or TV. three.js loads from a CDN, so it needs internet.

1. The lobby shows a QR code and a 4-letter room code.
2. Each player scans the QR code with their phone, types a name and taps **Join race** (up to 5 phones).
3. Anyone presses **START** on their phone (or Enter / the Start button) to race. Empty slots are
   filled with AI racers (switch them off in the lobby).

The screen splits for each human player: 1 full screen, 2 side by side, 3 or 4 in a 2x2 grid, 5 in a 3x2 grid.
The spare cell (3 or 5 players) shows the whole island from above with the standings.

### Phone controller (`pad.html`)
- Left half: slide your thumb to steer (or switch on **TILT** and steer by tilting the phone).
- **GAS** (hold), **BRAKE** (hold, reverses when stopped), the **brick button** uses your power-up,
  **LOOK BACK** in the top bar.
- The phone shows your place, lap and the power-up you are carrying, and buzzes when you are hit.

### Keyboard (for testing or a couch player)
- Player 1: arrows, Space = fire, Shift = look back
- Player 2: WASD, F = fire, R = look back
- Enter = start, Esc / P = pause, M = music

## Bricks and power-ups

Drive through the floating bricks. A **colour brick** sets the kind of power-up; **white bricks** (up to 3)
make it stronger. Using it spends them all, so you can fire a weak one now or build it up.

| Brick  | 0 white      | 1 white        | 2 white       | 3 white                         |
|--------|--------------|----------------|---------------|---------------------------------|
| Red    | Cannon ball  | Homing missile | Twin missiles | Lightning hits everyone ahead   |
| Yellow | Oil slick    | Mine           | Mine field    | Shockwave flips karts around you |
| Blue   | Shield       | Long shield    | Spike shield (spins karts you touch) | Super shield (faster, 10s) |
| Green  | Turbo        | Big turbo      | Mega turbo    | Warp ahead down the track       |

Holding GAS when the lights say GO gives a rocket start.

## How the phone link works

Same technology as SpaceGeo, extended to many phones (`js/padhost.js`, `pad.html`):
- Every message first goes through a public MQTT-over-WebSocket broker (works on any network).
- Through that relay each phone sets up its own direct WebRTC data channel with the game; on the same
  Wi-Fi that is a few milliseconds, and the relay stays as the backup.
- Phones publish on `brickracers/v1/<code>/up` with their key; the game answers on `.../down`, addressing one
  phone with `to`. Buttons are sent as running counters, so a lost packet never drops a press.
- A phone that reloads or briefly drops gets its own kart back (its key lives in the tab's session storage).
- No server of our own is needed.

## Files

- `index.html` – lobby, HUD and overlays (styles inline), import map for three.js
- `js/main.js` – renderer, players (phones, keyboards, AI), lobby, split screen, HUD, phone status feed
- `js/race.js` – driving, laps and places, bricks, power-ups, AI drivers, effects
- `js/track.js` – the spline track, road, brick walls, island scenery
- `js/models.js` – toon materials, cartoon outlines, karts, minifigure drivers, bricks, trees, huts
- `js/padhost.js` – the game side of the phone link (up to 5 phones)
- `js/audio.js` – synth sound effects, engine and music (Web Audio, no files)
- `pad.html` – the phone controller
- `sw.js`, `manifest.webmanifest`, `pad.webmanifest` – installable app / offline cache

Add `?webgl` to the address to force the WebGL 2 renderer, or `?q=low` for low graphics.
