// Brand marks for the streaming services the bridge can detect (from a
// now-playing title suffix or a native player name — see detectService in
// bridge/now-playing-core.mjs). serviceIcon(id) returns an inline <svg> string
// sized by CSS (.np-service svg); unknown/empty id → "" so the slot collapses.

// Generic eighth-note, used for services without a distinct simple mark.
const NOTE =
  "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z";

const ICONS = {
  spotify: {
    color: "#1DB954",
    label: "Spotify",
    d: "M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.84-.179-.96-.6-.122-.421.18-.84.6-.96 4.561-1.021 8.52-.6 11.64 1.32.42.18.479.66.301 1.021zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.42 1.56-.299.421-1.02.599-1.56.3z",
  },
  "youtube-music": {
    color: "#FF0033",
    label: "YouTube Music",
    d: "M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228s6.228-2.796 6.228-6.228S15.432 5.772 12 5.772zM9.684 15.54l6.132-3.54-6.132-3.54v7.08z",
  },
  youtube: {
    color: "#FF0000",
    label: "YouTube",
    d: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  },
  "apple-music": { color: "#FA243C", label: "Apple Music", d: NOTE },
  tidal: {
    color: "#FFFFFF",
    label: "Tidal",
    d: "M12.012 3.992 8.008 7.996 4.004 3.992 0 7.996l4.004 4.004 4.004-4.004 4.004 4.004-4.004 4.004 4.004 4.004 4.004-4.004L20.024 12l4.004-4.004-4.004-4.004-4.004 4.004z",
  },
  qobuz: { color: "#00C3A5", label: "Qobuz", d: NOTE },
  "amazon-music": { color: "#25D1DA", label: "Amazon Music", d: NOTE },
  pandora: { color: "#3668FF", label: "Pandora", d: NOTE },
  napster: { color: "#21B7EC", label: "Napster", d: NOTE },
  deezer: { color: "#A238FF", label: "Deezer", bars: true },
  soundcloud: { color: "#FF5500", label: "SoundCloud", bars: true },
};

// Simple 4-bar equalizer mark for the bar-style services (Deezer/SoundCloud).
function barsSvg(color) {
  const cols = [
    [3, 9],
    [8.5, 16],
    [14, 6],
    [19, 12],
  ];
  return cols
    .map(
      ([x, h]) =>
        `<rect x="${x}" y="${21 - h}" width="3" height="${h}" rx="1.2" fill="${color}"/>`,
    )
    .join("");
}

export function serviceLabel(id) {
  return ICONS[id] ? ICONS[id].label : "";
}

export function serviceIcon(id) {
  const s = ICONS[id];
  if (!s) return "";
  const inner = s.bars
    ? barsSvg(s.color)
    : `<path fill="${s.color}" d="${s.d}"/>`;
  return `<svg viewBox="0 0 24 24" role="img" aria-label="${s.label}">${inner}</svg>`;
}
