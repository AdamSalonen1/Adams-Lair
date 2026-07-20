// Daily Dozen — a thin wrapper over YouTube's IFrame Player API.
//
// This is the only place that talks to YouTube. It exists to turn a callback-
// and-global-variable API into two things app.js can reason about: a promise
// that resolves to a ready player, and a couple of events (a video ended, a
// video won't play). The anti-doomscroll stance lives in the playerVars here —
// no autoplay, related videos limited, no chrome inviting you elsewhere.

// The API signals readiness by calling one global function. Loading the script
// more than once would clobber that handshake, so the load is memoised.
let apiPromise = null;

function loadApi() {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    // Chain rather than overwrite: if anything else on the page ever waits on
    // the same global, both callbacks fire.
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') prev();
      resolve(window.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });

  return apiPromise;
}

// YouTube's onError codes worth naming. 100 = gone (deleted/private); 101 and
// 150 are the same thing — the owner disallowed embedding. All three mean "this
// tile is never going to play," which is the only distinction app.js cares about.
const UNPLAYABLE = new Set([100, 101, 150]);

/**
 * Build a player inside `elementId` and resolve once it's ready to take a video.
 *
 * @param {string} elementId
 * @param {{ onEnded?: () => void, onUnplayable?: (code:number) => void, onStateChange?: (state:number) => void }} handlers
 * @returns {Promise<{ cue:(id:string)=>void, play:()=>void, stop:()=>void, raw: any }>}
 */
export async function createPlayer(elementId, { onEnded, onUnplayable, onStateChange } = {}) {
  const YT = await loadApi();

  return new Promise((resolve) => {
    const player = new YT.Player(elementId, {
      width: '100%',
      height: '100%',
      playerVars: {
        rel: 0,             // keep end-screen suggestions to the same channel, not a fresh rabbit hole
        modestbranding: 1,  // less YouTube chrome nudging you off to YouTube
        playsinline: 1,     // play in place on iOS instead of hijacking fullscreen
        autoplay: 0,        // nothing plays until a human presses play
      },
      events: {
        onReady: () => resolve(controller),
        onStateChange: (e) => {
          if (typeof onStateChange === 'function') onStateChange(e.data);
          if (e.data === YT.PlayerState.ENDED && typeof onEnded === 'function') onEnded();
        },
        onError: (e) => {
          if (UNPLAYABLE.has(e.data) && typeof onUnplayable === 'function') onUnplayable(e.data);
        },
      },
    });

    // Defined after construction on purpose: onReady/onStateChange only fire on
    // a later tick, by which point this exists. cueVideoById loads a video in
    // the "cued" state — visible, paused, waiting for a press — which is exactly
    // the no-autoplay behaviour we want.
    const controller = {
      cue: (id) => player.cueVideoById(id),
      play: () => player.playVideo(),
      stop: () => player.stopVideo(),
      raw: player,
    };
  });
}
