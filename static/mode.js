const PLAYING = 2;

function named(value) {
  return value && typeof value === 'object' && typeof value.name === 'string' && value.name.trim() ? value : null;
}

/**
 * The ruleset the player is in. vosu keeps `beatmap.mode` as the map's original ruleset, so an
 * osu! map converted to mania still reports osu! there; gameplay uses `play.mode`, menus the
 * selected ruleset in `settings.mode`.
 */
export function activeMode(snapshot) {
  const v2 = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const playing = v2.state?.number === PLAYING;
  return (playing && named(v2.play?.mode)) || named(v2.settings?.mode) || named(v2.beatmap?.mode);
}
