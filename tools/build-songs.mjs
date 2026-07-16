/**
 * Builds projects/kanyeezle/songs.json from MusicBrainz.
 *
 * Run: node tools/build-songs.mjs
 *
 * Release MBIDs are pinned deliberately. MusicBrainz has dozens of releases per
 * album (clean edits, Japanese bonus discs, vinyl splits, bootlegs) and they
 * disagree on both track numbers and durations, so resolving by title at build
 * time would silently drift. Each pin below is an official, explicit edition
 * matching the tracklist people actually stream.
 */

const UA = 'KanYeezle/0.1 ( adam.salonen@gmail.com )';
const OUT = new URL('../projects/kanyeezle/songs.json', import.meta.url);

// Ordered by release date -- the game's album-adjacency ("close" = yellow) logic
// depends on this array order, so keep it chronological.
const ALBUMS = [
  { name: 'The College Dropout', short: 'College Dropout', year: 2004, release: '4476cc6a-41ac-4df0-99ad-140218958b62', primary: ['Kanye West'] },
  { name: 'Late Registration', short: 'Late Registration', year: 2005, release: '0dc6b658-de04-43d3-8780-3e754141d0b8', primary: ['Kanye West'] },
  { name: 'Graduation', short: 'Graduation', year: 2007, release: 'ccd5625e-f49d-4b8a-a2f2-fecf7009f011', primary: ['Kanye West'] },
  { name: '808s & Heartbreak', short: '808s', year: 2008, release: '2e817d2f-34a3-3e6a-97e9-376453421fea', primary: ['Kanye West'] },
  { name: 'My Beautiful Dark Twisted Fantasy', short: 'MBDTF', year: 2010, release: '936085b3-ded4-4ebd-a6d8-eb8e9a5fea06', primary: ['Kanye West'] },
  { name: 'Watch the Throne', short: 'Watch the Throne', year: 2011, release: '196bb188-d579-4f00-ac29-9a83a7dc1b9c', primary: ['Kanye West', 'Jay-Z'] },
  { name: 'Cruel Summer', short: 'Cruel Summer', year: 2012, release: '8e94a9b7-1fed-46ad-a123-c3867d66c679', primary: ['Kanye West'], compilation: true },
  { name: 'Yeezus', short: 'Yeezus', year: 2013, release: '44f67341-2586-4283-bc3f-cf03ae89dc35', primary: ['Kanye West'] },
  { name: 'The Life of Pablo', short: 'TLOP', year: 2016, release: '03f03619-385a-4ed9-9974-cdcdf6404cf5', primary: ['Kanye West'] },
  { name: 'ye', short: 'ye', year: 2018, release: '59c3d788-8880-44ae-9897-bb098a80e663', primary: ['Kanye West'] },
  { name: 'Kids See Ghosts', short: 'Kids See Ghosts', year: 2018, release: '6e8842be-fe00-4f18-adb4-d4025204b722', primary: ['Kanye West', 'Kid Cudi', 'KIDS SEE GHOSTS'] },
  { name: 'Jesus Is King', short: 'Jesus Is King', year: 2019, release: '78881e0a-b2bd-4e7e-8aa8-0d524f8da328', primary: ['Kanye West'] },
  { name: 'Donda', short: 'Donda', year: 2021, release: '36cbd3f5-a595-4acb-bc82-412e27905beb', primary: ['Kanye West'] },
];

// Extra strings the guess box should match, for tracks whose released title
// isn't what anyone calls them. Display always uses the real title; these only
// widen the search. Keyed by exact title.
const ALIASES = {
  'Pt. 2': ['Father Stretch My Hands, Pt. 2'],
};

const SKIT = /\bskit\b|\binterlude\b|^intro$|^outro$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MusicBrainz renders the same artist several ways ("Jay-Z" / "JAY-Z" / "Jay‐Z"
// with a U+2010 hyphen). Fold to a comparable key before matching primaries.
const foldArtist = (s) =>
  s
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/[^a-z0-9]/g, '');

// MusicBrainz stores U+2010 HYPHEN in names ("Jay‐Z", "The‐Dream") where every
// other source uses ASCII. Left alone it renders as a stray glyph and breaks
// copy/paste, so fold it for display too.
const clean = (s) => s.replace(/[‐-―]/g, '-').trim();

// Titles are kept verbatim. Note that Cruel Summer's ".1" suffixes ("Mercy.1",
// "New God Flow.1") are the real released titles, not artifacts -- do not strip them.
const cleanTitle = clean;

const CACHE = new URL('.cache/', import.meta.url);

async function fetchRelease(mbid) {
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const cached = new URL(`${mbid}.json`, CACHE);
  try {
    return JSON.parse(await readFile(cached, 'utf8'));
  } catch {
    // not cached yet
  }
  const url = `https://musicbrainz.org/ws/2/release/${mbid}?fmt=json&inc=recordings+artist-credits`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${mbid}: HTTP ${res.status}`);
  const json = await res.json();
  await mkdir(CACHE, { recursive: true });
  await writeFile(cached, JSON.stringify(json));
  await sleep(1100); // MusicBrainz rate limit: 1 req/sec -- only pay it on a miss
  return json;
}

const songs = [];
const skipped = [];
const noKanye = [];

for (const album of ALBUMS) {
  const release = await fetchRelease(album.release);
  const primaryKeys = new Set(album.primary.map(foldArtist));
  let position = 0;

  for (const medium of release.media ?? []) {
    for (const track of medium.tracks ?? []) {
      position += 1; // continuous across discs, so a 2-disc release still reads 1..N
      const title = cleanTitle(track.title);
      const credits = track['artist-credit'] ?? track.recording?.['artist-credit'] ?? [];
      const names = credits.map((c) => clean(c.name));
      const features = names.filter((name) => !primaryKeys.has(foldArtist(name)));

      // Track length wins over recording length: the recording is shared across
      // releases and can carry a different edit's duration.
      const lengthMs = track.length ?? track.recording?.length ?? null;

      const row = {
        title,
        album: album.name,
        track: position,
        lengthMs,
        features,
      };
      if (ALIASES[title]) row.aliases = ALIASES[title];

      // Cruel Summer is a label compilation -- several tracks have no Kanye on
      // them at all. Surface those rather than letting them sit in the pool unseen.
      // (Only meaningful here: Kids See Ghosts credits the duo, not Kanye by name.)
      if (album.compilation && !names.some((n) => foldArtist(n) === foldArtist('Kanye West'))) {
        noKanye.push(row);
      }

      if (SKIT.test(title)) {
        skipped.push({ ...row, reason: 'skit' });
        continue;
      }
      if (lengthMs == null) {
        skipped.push({ ...row, reason: 'no length' });
        continue;
      }
      songs.push(row);
    }
  }

  const kept = songs.filter((s) => s.album === album.name).length;
  console.log(`${album.name.padEnd(34)} ${String(kept).padStart(2)} songs  (${position} tracks on release)`);
}

const payload = {
  generated: new Date().toISOString().slice(0, 10),
  source: 'MusicBrainz',
  albums: ALBUMS.map((a) => ({ name: a.name, short: a.short, year: a.year })),
  songs,
};

const { writeFile, mkdir } = await import('node:fs/promises');
await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n');

console.log(`\n${songs.length} songs -> ${OUT.pathname}`);
console.log(`\nExcluded (${skipped.length}):`);
for (const s of skipped) console.log(`  ${s.reason.padEnd(9)} ${s.album} #${s.track} — ${s.title}`);

if (noKanye.length) {
  console.log(`\nCompilation tracks with no Kanye credit (${noKanye.length}) — kept, but review:`);
  for (const s of noKanye) console.log(`  ${s.album} #${s.track} — ${s.title}`);
}

const shortest = [...songs].sort((a, b) => a.lengthMs - b.lengthMs).slice(0, 5);
console.log(`\nShortest tracks (possible uncaught skits):`);
for (const s of shortest) console.log(`  ${(s.lengthMs / 1000).toFixed(0).padStart(3)}s  ${s.album} #${s.track} — ${s.title}`);
