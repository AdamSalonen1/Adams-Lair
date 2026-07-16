# Adams-Lair

Repo filled with all of my amazing ideas. A plain static site — no build step, no
dependencies. Open `index.html` and it works.

## Local preview

The KanYeezle page loads its song data with `fetch`, which browsers block on
`file://` URLs, so serve the folder over HTTP rather than double-clicking the file:

```sh
python -m http.server 8000
# then http://localhost:8000
```

## Projects

### KanYeezle (`projects/kanyeezle/`)

A daily Kanye song guessing game: eight tries, four clues (album, track number,
song length, featured artists). The pool is 182 songs across the 13 albums from
*The College Dropout* (2004) to *Donda* (2021) — the pre-*Ye* run.

| File | Role |
| --- | --- |
| `index.html` | Page markup |
| `kanyeezle.css` | Game styles (extends the site's `css/style.css`) |
| `logic.js` | Pure game rules — scoring, daily selection, search. No DOM. |
| `game.js` | DOM wiring, state, rendering |
| `songs.json` | Generated song data — **do not hand-edit** |

The daily song is picked by shuffling all 182 songs with a fixed seed and walking
one per day, so every player gets the same song and none repeats for 182 days.
There's no server; progress lives in `localStorage`.

## Tools

```sh
node tools/build-songs.mjs      # regenerate projects/kanyeezle/songs.json
node --test tools/test-logic.mjs  # test the game rules against the real data
```

`build-songs.mjs` pulls track numbers, lengths and credits from
[MusicBrainz](https://musicbrainz.org). Each album pins an exact *release* MBID:
MusicBrainz carries dozens of releases per album (clean edits, Japanese bonus
discs, vinyl splits, bootlegs) that disagree on both track numbers and durations,
so resolving by title would silently drift. Responses are cached in
`tools/.cache/` (gitignored) — delete it to refetch.

Editorial calls baked into the generator, in case they need revisiting:

- **Deluxe vs. standard.** *Watch the Throne* uses the 16-track deluxe (what streams
  today); *Donda* uses the original 27-track cut, not the 32-track deluxe;
  *Graduation* includes "Good Night"; *The Life of Pablo* uses the final 20-track version.
- **Skits** are excluded — 9 tracks whose titles say so. Some non-obvious ones
  survive on purpose: "Workout Plan" (0:46, the College Dropout skit) sits in the
  pool two tracks away from the real "The New Workout Plan".
- **Cruel Summer** is included in full, including the 5 tracks with no Kanye
  credit at all (The Morning, Higher, Sin City, Creepers, Bliss).
- **Titles are verbatim.** Cruel Summer's ".1" suffixes ("Mercy.1", "New God Flow.1")
  are real released titles, not data artifacts. The guess box matches on substrings
  so typing "mercy" still finds it. `ALIASES` in the generator widens the search for
  tracks whose released title isn't what anyone calls them (TLOP's "Pt. 2").
