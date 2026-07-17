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
| `songs.json` | Song data — **the source of truth. Hand-maintained; edit it directly.** |

The daily song is picked by shuffling all 182 songs with a fixed seed and walking
one per day, so every player gets the same song and none repeats for 182 days.
There's no server; progress lives in `localStorage`.

## Tools

```sh
node --test tools/test-logic.mjs  # test the game rules against the real data
```

## Where the song data comes from

`songs.json` is hand-maintained. There is no build step and nothing regenerates
it — edit it directly and let `test-logic.mjs` catch mistakes.

- **Track numbers, lengths, titles** were pulled once from
  [MusicBrainz](https://musicbrainz.org), pinning an exact *release* MBID per album
  (MusicBrainz carries dozens of releases per album — clean edits, Japanese bonus
  discs, vinyl splits — that disagree on track numbers and durations). The MBIDs
  are recorded in `tools/archive/build-songs.mjs`.
- **Featured artists** are compiled from the per-album personnel and guest-vocal
  sections on [Wikipedia](https://en.wikipedia.org/wiki/Kanye_West_discography)
  (CC BY-SA 4.0) and then hand-edited.

MusicBrainz alone is **not** sufficient for features and never will be. It credits
all of *The Life of Pablo* and *Donda* to Kanye West alone — ~47 songs with no
features at all. That's faithful, not buggy: Donda shipped with no feature credits
(only "Jail" and "Hurricane" carry a "with"), and TLOP's final 20-track release is
credited solely to West. The March 2016 TLOP releases do carry credits, but on a
different tracklist, so no pin gives correct track numbers *and* correct features.
`tools/archive/build-songs.mjs` is retired for this reason and refuses to run
without `--bootstrap`; it exists to seed a new album, not to own the file.

Editorial calls in the data, in case they need revisiting:

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
  so typing "mercy" still finds it. A song's optional `aliases` array widens the
  search for tracks whose released title isn't what anyone calls them (TLOP's "Pt. 2").
- **Features mean performers, not personnel.** Guests are included whether or not
  the official credits name them — André 3000 on "30 Hours", Kid Cudi on "Guilt
  Trip", every Donda feature. Session and background singers, engineers and choirs
  are excluded even where Wikipedia lists them beside the guests (Tony Williams,
  Jeff Bhasker, Caroline Shaw, Noah Goldstein, the Sunday Service Choir), because
  a player guessing "featured artists" doesn't mean the engineer.
