# Product

## Register

product

## Users

Music listeners. Someone drops in a track (or lets the default load), hits play, and
watches their lyrics come alive. They are here to enjoy a song, not to operate a tool —
so the player should mostly get out of the way and let the visuals carry the screen.

Note: the current maintainer does not own the upstream project; this is a personal fork-in-progress
being tuned for personal use. Keep changes self-contained and low-ceremony.

## Product Purpose

An audio-reactive lyric visualizer. Audio analysis decides *how* text moves; Pretext decides
*where* text can safely exist before it moves. Success = a track plays, lyrics sync and react to
the beat, and the result is something you'd leave running full-screen because it looks good.

## Brand Personality

Moody, fluid, hypnotic. Slow, atmospheric, dreamy — the music should dissolve into motion rather
than be charted on meters. Cinematic and immersive: dark canvas takes over the screen, controls
recede until needed.

## Anti-references

- **Corporate SaaS dark mode** (Stripe/Linear dashboard chrome). Too clinical and product-y for music.
- **Cluttered DJ software** — dense panels, knobs, meters, readouts everywhere. The opposite of immersive.
- Also avoid by default: dated Winamp/MilkDrop spectrum-bar clichés and neon-synthwave vaporwave kitsch.

## Design Principles

1. **The music owns the screen.** Visuals are the product; chrome is a guest that shows up when touched and fades otherwise.
2. **Motion is the message.** Energy is expressed through fluid, decaying movement — not gauges, bars, or numeric readouts.
3. **Readability survives the motion.** Lyrics can move aggressively but must never collapse into unreadable overlap; layout stability (Pretext) is non-negotiable.
4. **Atmosphere over information.** When in doubt, fewer controls, more space, more depth.

## Accessibility & Inclusion

Sensible defaults, no formal target:
- Lyric text keeps readable contrast against the canvas even mid-motion.
- `prefers-reduced-motion` gets a calmer fallback (reduced/instant motion, no aggressive beat throw).
- Core transport (play/pause, seek) reachable by keyboard.
