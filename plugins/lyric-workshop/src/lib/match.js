// 跨平台候选打分（移植自 SPlayer electron/main/apis/common/lyric/utils.ts）
// 从搜索结果里挑最匹配当前音频文件的那一条

const normalize = (text) => (text ? text.toLowerCase().replace(/[、&;，,/|()·・\s\-_'"`~!?？！.。]+/g, '') : '');

const bothContains = (left, right) =>
  left.length > 0 && right.length > 0 && (left.includes(right) || right.includes(left));

const splitArtists = (text) =>
  (text ?? '')
    .split(/[、&;，,/|·・]+/g)
    .map(normalize)
    .filter(Boolean);

const artistMatches = (candidateArtist, trackArtists) => {
  if (trackArtists.length === 0) return { exact: false, contains: false };
  const candFull = normalize(candidateArtist);
  const candParts = splitArtists(candidateArtist);
  if (!candFull) return { exact: false, contains: false };
  const exact = trackArtists.some(
    (artist) => candFull === artist || candParts.some((part) => part === artist)
  );
  if (exact) return { exact: true, contains: false };
  const contains = trackArtists.some(
    (artist) =>
      artist.length >= 2 &&
      (bothContains(candFull, artist) || candParts.some((part) => bothContains(part, artist)))
  );
  return { exact: false, contains };
};

const durationClose = (leftMs, rightMs, tolMs = 5000) => {
  if (!leftMs || !rightMs) return false;
  return Math.abs(leftMs - rightMs) <= tolMs;
};

const durationFar = (leftMs, rightMs, tolMs = 20000) => {
  if (!leftMs || !rightMs) return false;
  return Math.abs(leftMs - rightMs) > tolMs;
};

const NAME_CONTAIN_MIN_RATIO = 0.34;

/**
 * @param candidates [{name, artist, album?, duration?, extra}]
 * @param track {title, artists:[string], album?, durationMs?}
 * @returns 最匹配的候选；无命中返回 null
 */
export const pickBestCandidate = (candidates, track) => {
  const trackName = normalize(track.title);
  const trackArtists = (track.artists ?? []).map(normalize).filter(Boolean);
  const trackAlbum = normalize(track.album);
  const trackDuration = track.durationMs || 0;

  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const candName = normalize(candidate.name);
    const candAlbum = normalize(candidate.album);

    const nameExact = candName.length > 0 && candName === trackName;
    if (!nameExact) {
      if (!bothContains(candName, trackName)) continue;
      const longer = Math.max(candName.length, trackName.length);
      const shorter = Math.min(candName.length, trackName.length);
      if (shorter / longer < NAME_CONTAIN_MIN_RATIO) continue;
    }

    // 名字+歌手都精确匹配时不做时长否决：文件 TLEN 标签经常不准（差 30s+ 很常见）
    const artist = artistMatches(candidate.artist, trackArtists);
    if (trackArtists.length > 0 && !artist.exact && !artist.contains) continue;
    const strongMatch = nameExact && artist.exact;
    if (!strongMatch && durationFar(candidate.duration, trackDuration)) continue;
    if (!nameExact && !artist.exact && !artist.contains && !durationClose(candidate.duration, trackDuration)) {
      continue;
    }

    let score = nameExact ? 10 : 4;
    if (artist.exact) score += 5;
    else if (artist.contains) score += 2;
    if (trackAlbum && candAlbum === trackAlbum) score += 2;
    if (durationClose(candidate.duration, trackDuration)) score += 3;

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
};

/** 搜索关键词：标题 + 歌手（降低同名异歌手误命中） */
export const buildSearchKeyword = (title, artists, artistStr) =>
  [title, artistStr || (artists ?? []).join(' ')].filter(Boolean).join(' ').trim();
