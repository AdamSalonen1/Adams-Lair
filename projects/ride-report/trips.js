// Ride Report — session and trips UI.
//
// Login and trips share a file because they are one feature: the only reason
// this page has a sign-in is to unlock the trips section. There is no other
// authenticated surface.
//
// The section's visibility is cosmetic. RLS is what protects the rows — an
// anonymous query for trips comes back empty no matter what the DOM is doing.

import {
  isConfigured,
  getSession,
  onAuthChange,
  sendMagicLink,
  signOut,
  listTrips,
  latestTripReports,
  latestTripReport,
  createTrip,
  updateTrip,
  deleteTrip,
} from './supabase.js';

const HOME = { location_name: 'Fargo, ND', lat: 46.8772, lon: -96.7898 };

// How long to wait for the Pi after a save. The listener debounces ~5s, then a
// synthesis run is tens of seconds on a Pi; 90s covers that with room, and if
// the lock is held by a scheduled run it can legitimately take longer — hence
// the timeout message says "still working" rather than "failed".
const WATCH_MS = 90_000;
const POLL_MS = 5_000;

let el = {};
let session = null;
let editingId = null;
let started = false;

// Trips whose outlook we're waiting on, and the report stamp each had at save
// time. Module-level rather than per-card because refreshTrips() rebuilds every
// card from scratch — state living on a DOM node would not survive the rerender
// that the save itself triggers.
const watching = new Map();
// Trips whose watch ran out before a report landed, mapped to the stamp they
// were waiting to see replaced. Distinct from "pending" because it means
// something different: the Pi was asked and hasn't answered yet, rather than
// never having been asked. Keeping the stamp lets a later refresh notice the
// outlook did eventually land and drop the message.
const stalled = new Map();
// Latest reports from the most recent refresh, so a save knows which stamp it
// is waiting to see replaced without an extra round trip to ask.
let lastReports = new Map();

function byId(id) {
  return document.getElementById(id);
}

function show(node, visible) {
  node.hidden = !visible;
}

function setMessage(node, text, isError = false) {
  node.textContent = text || '';
  node.classList.toggle('is-error', Boolean(text) && isError);
  show(node, Boolean(text));
}

// ===== Formatting =====

/**
 * 'YYYY-MM-DD' -> Date at local midnight. Passing the bare string to `new Date`
 * would parse it as UTC and render as the day before for anyone west of
 * Greenwich, which is everyone this page is for.
 */
function localDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`);
}

function formatRange(startStr, endStr) {
  const start = localDate(startStr);
  const end = localDate(endStr);
  const sameYear = start.getFullYear() === end.getFullYear();
  const thisYear = start.getFullYear() === new Date().getFullYear();

  const md = { month: 'short', day: 'numeric' };
  const fmt = (d, withYear) => new Intl.DateTimeFormat('en-US', withYear ? { ...md, year: 'numeric' } : md).format(d);

  if (startStr === endStr) return fmt(start, !thisYear);
  return `${fmt(start, !sameYear)} – ${fmt(end, !thisYear || !sameYear)}`;
}

function formatStamp(iso) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

function formatWeekday(dateStr) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(localDate(dateStr));
}

// ===== Trip list =====

function tripCard(trip, report) {
  const li = document.createElement('li');
  li.className = 'trip-card';

  const head = document.createElement('div');
  head.className = 'trip-card-head';

  const title = document.createElement('h3');
  title.textContent = trip.title;

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn-sm';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openForm(trip));

  head.append(title, edit);

  const meta = document.createElement('p');
  meta.className = 'trip-meta';
  meta.textContent = `${trip.location_name} · ${formatRange(trip.start_date, trip.end_date)}`;

  li.append(head, meta);

  if (trip.notes) {
    const notes = document.createElement('p');
    notes.className = 'trip-notes';
    notes.textContent = trip.notes;
    li.appendChild(notes);
  }

  // Written by the Pi — either the listener, seconds after a save, or the
  // scheduled run refreshing it as the forecast firms up. Each branch below is
  // a real state the trip can be in; none of them is an empty space.
  const outlook = document.createElement('p');
  outlook.className = 'trip-outlook';

  if (watching.has(trip.id)) {
    outlook.classList.add('is-generating');
    outlook.textContent = 'Outlook generating…';
  } else if (stalled.has(trip.id)) {
    outlook.classList.add('is-pending');
    outlook.textContent = 'Still working on the outlook — check back in a minute.';
  } else if (report?.payload?.summary) {
    outlook.textContent = report.payload.summary;
    const stamp = document.createElement('span');
    stamp.className = 'trip-stamp';
    stamp.textContent = ` — ${formatStamp(report.generated_at)}`;
    outlook.appendChild(stamp);
  } else {
    outlook.classList.add('is-pending');
    outlook.textContent = 'Outlook pending.';
  }
  li.appendChild(outlook);

  // The days worth riding, already ranked by the worker. Deterministic data, so
  // it stays true even when the narrative above came from the fallback.
  const best = report?.payload?.best_days;
  if (best?.length && !watching.has(trip.id)) {
    const line = document.createElement('p');
    line.className = 'trip-best';
    line.textContent = `Best: ${best.map(formatWeekday).join(', ')}`;
    li.appendChild(line);
  }

  return li;
}

async function refreshTrips() {
  // The render is inside the try on purpose: a malformed row that blows up in
  // tripCard should surface as the same visible message as a failed request,
  // not as an unhandled rejection in the console.
  try {
    // Sequential because the report lookup is keyed by the trip ids. Both are
    // owner-scoped by RLS, so neither needs to know who is logged in.
    const trips = await listTrips();
    const reports = await latestTripReports(trips.map((trip) => trip.id));
    lastReports = reports;

    // A watch that timed out doesn't mean the Pi gave up — a run queued behind
    // the scheduled job can land minutes later. If the outlook has since
    // arrived, retire the "still working" line rather than leaving it up.
    for (const [tripId, since] of stalled) {
      const arrived = reports.get(tripId);
      if (arrived && arrived.generated_at !== since) stalled.delete(tripId);
    }

    el.tripList.replaceChildren(...trips.map((trip) => tripCard(trip, reports.get(trip.id))));
    show(el.tripsEmpty, trips.length === 0);
  } catch (err) {
    console.error('Ride Report: could not load trips.', err);
    setMessage(el.tripError, 'Could not load trips. Try refreshing.', true);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll one trip's report until a newer one appears, then rerender.
 *
 * Polling rather than a browser Realtime subscription. Both were on the table
 * and the socket is the prettier answer, but it isn't the cheaper one here: it
 * would mean enabling the publication on `reports` and trusting Realtime's RLS
 * handling for a table whose whole security story is that trip narratives are
 * owner-only. This runs for ninety seconds after a deliberate click, a handful
 * of times a week. Polling is a fair trade for keeping that table off the wire.
 */
async function watchOutlook(tripId, token) {
  const deadline = Date.now() + WATCH_MS;
  // A save during an active watch starts a new one. The token is how this loop
  // notices it has been superseded — without it, two loops would poll the same
  // trip and race to rerender.
  const stillMine = () => watching.get(tripId)?.token === token;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    // Cancelled (deleted, signed out) or superseded.
    if (!stillMine()) return;

    let report;
    try {
      report = await latestTripReport(tripId);
    } catch (err) {
      // Transient — a dropped request shouldn't abandon the watch. If it keeps
      // failing, the deadline ends it.
      console.warn('Ride Report: polling for the trip outlook failed.', err);
      continue;
    }

    if (!stillMine()) return;

    if (report && report.generated_at !== watching.get(tripId).since) {
      watching.delete(tripId);
      stalled.delete(tripId);
      await refreshTrips();
      return;
    }
  }

  if (!stillMine()) return;
  const { since } = watching.get(tripId);
  watching.delete(tripId);
  stalled.set(tripId, since);
  await refreshTrips();
}

let watchToken = 0;

/** Begin watching a trip for a fresh outlook, superseding any watch in flight. */
function startWatch(tripId) {
  stalled.delete(tripId);
  const token = (watchToken += 1);
  watching.set(tripId, { since: lastReports.get(tripId)?.generated_at ?? null, token });
  watchOutlook(tripId, token);
}

// ===== Trip form =====

function openForm(trip = null) {
  editingId = trip?.id ?? null;

  el.tripTitle.value = trip?.title ?? '';
  el.tripLocation.value = trip?.location_name ?? HOME.location_name;
  el.tripLat.value = trip?.lat ?? HOME.lat;
  el.tripLon.value = trip?.lon ?? HOME.lon;
  el.tripStart.value = trip?.start_date ?? '';
  el.tripEnd.value = trip?.end_date ?? '';
  el.tripNotes.value = trip?.notes ?? '';

  setMessage(el.tripError, '');
  show(el.tripDelete, Boolean(trip));
  show(el.tripForm, true);
  show(el.tripAdd, false);
  el.tripTitle.focus();
}

function closeForm() {
  editingId = null;
  el.tripForm.reset();
  setMessage(el.tripError, '');
  show(el.tripForm, false);
  show(el.tripAdd, true);
}

/**
 * Read a coordinate input. The blank check is load-bearing: `Number('')` is 0,
 * not NaN, so an empty field would otherwise sail through a Number.isFinite
 * test and be saved as a perfectly plausible zero. Latitude 0, longitude 0 is a
 * real spot in the Gulf of Guinea, and the worker will happily forecast it —
 * which is exactly how a trip ends up with a confident outlook for open ocean.
 */
function readCoordinate(input, name, limit) {
  const raw = input.value.trim();
  // Also catches `type="number"` bad input, which reports an empty string.
  if (!raw) return { error: `${name} is required — it's what the forecast is fetched for.` };

  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: `${name} must be a number.` };
  if (value < -limit || value > limit) return { error: `${name} must be between -${limit} and ${limit}.` };

  return { value };
}

function readForm() {
  const lat = readCoordinate(el.tripLat, 'Latitude', 90);
  if (lat.error) return { error: lat.error };
  const lon = readCoordinate(el.tripLon, 'Longitude', 180);
  if (lon.error) return { error: lon.error };

  const fields = {
    title: el.tripTitle.value.trim(),
    location_name: el.tripLocation.value.trim(),
    lat: lat.value,
    lon: lon.value,
    start_date: el.tripStart.value,
    end_date: el.tripEnd.value,
    notes: el.tripNotes.value.trim() || null,
  };

  if (!fields.title) return { error: 'Give the trip a title.' };
  if (!fields.start_date || !fields.end_date) return { error: 'Both dates are required.' };
  // ISO dates compare correctly as strings, and the same rule is enforced by a
  // CHECK constraint — this exists to say so in English before the round trip.
  if (fields.end_date < fields.start_date) return { error: 'The end date is before the start date.' };

  return { fields };
}

async function handleSubmit(event) {
  event.preventDefault();

  const { fields, error } = readForm();
  if (error) {
    setMessage(el.tripError, error, true);
    return;
  }

  el.tripSave.disabled = true;
  try {
    // The saved row's id, which for a create is only knowable after the insert.
    const saved = editingId ? await updateTrip(editingId, fields) : await createTrip(fields);
    closeForm();
    // Order matters: mark it watched before rendering, so the card comes back
    // saying "generating…" rather than flashing the old outlook first.
    if (saved?.id) startWatch(saved.id);
    await refreshTrips();
  } catch (err) {
    console.error('Ride Report: saving the trip failed.', err);
    setMessage(el.tripError, err.message || 'Could not save the trip.', true);
  } finally {
    el.tripSave.disabled = false;
  }
}

async function handleDelete() {
  if (!editingId) return;
  if (!window.confirm('Delete this trip? Its reports go with it.')) return;

  el.tripDelete.disabled = true;
  try {
    const deletedId = editingId;
    await deleteTrip(deletedId);
    // Stop any watch on it — its reports went with it via the FK cascade, so
    // there is nothing left to poll for.
    watching.delete(deletedId);
    stalled.delete(deletedId);
    closeForm();
    await refreshTrips();
  } catch (err) {
    console.error('Ride Report: deleting the trip failed.', err);
    setMessage(el.tripError, err.message || 'Could not delete the trip.', true);
  } finally {
    el.tripDelete.disabled = false;
  }
}

// ===== Session =====

async function handleMagicLink(event) {
  event.preventDefault();
  const email = el.authEmail.value.trim();
  if (!email) return;

  el.authSend.disabled = true;
  setMessage(el.authMsg, 'Sending…');
  try {
    await sendMagicLink(email);
    show(el.authForm, false);
    show(el.authOpen, true); // so a link that never arrives can be re-requested
    // Deliberately vague about whether the address has an account: signups are
    // disabled, and a precise answer here would be an account-existence oracle.
    setMessage(el.authMsg, 'Check your email for a sign-in link.');
  } catch (err) {
    console.error('Ride Report: magic link failed.', err);
    setMessage(el.authMsg, err.message || 'Could not send the link.', true);
  } finally {
    el.authSend.disabled = false;
  }
}

/**
 * Single place where "is someone logged in" turns into visible state. Called on
 * load and again from onAuthChange, so the magic-link return needs no special
 * handling — it arrives as just another session.
 */
function applySession(next) {
  const wasLoggedIn = Boolean(session);
  session = next;

  show(el.authOpen, !session);
  show(el.authForm, false);
  show(el.authSession, Boolean(session));
  show(el.trips, Boolean(session));

  if (session) {
    el.authWho.textContent = session.user?.email ?? 'Signed in';
    setMessage(el.authMsg, '');
    if (!wasLoggedIn) refreshTrips();
  } else {
    closeForm();
    // Drop every watch: the polls would 200-with-nothing under RLS anyway, and
    // a signed-out page has no card left to rerender into.
    watching.clear();
    stalled.clear();
    lastReports = new Map();
    el.tripList.replaceChildren();
    show(el.tripsEmpty, false);
  }
}

export function initTripsUi() {
  // Guard against a second call: onAuthChange would end up double-subscribed
  // and every listener would fire twice.
  if (started || !isConfigured()) return;
  started = true;

  el = {
    trips: byId('trips'),
    tripList: byId('trip-list'),
    tripsEmpty: byId('trips-empty'),
    tripAdd: byId('trip-add'),
    tripForm: byId('trip-form'),
    tripTitle: byId('trip-title'),
    tripLocation: byId('trip-location'),
    tripLat: byId('trip-lat'),
    tripLon: byId('trip-lon'),
    tripStart: byId('trip-start'),
    tripEnd: byId('trip-end'),
    tripNotes: byId('trip-notes'),
    tripError: byId('trip-error'),
    tripSave: byId('trip-save'),
    tripCancel: byId('trip-cancel'),
    tripDelete: byId('trip-delete'),
    authBar: byId('auth-bar'),
    authOpen: byId('auth-open'),
    authForm: byId('auth-form'),
    authEmail: byId('auth-email'),
    authSend: byId('auth-send'),
    authCancel: byId('auth-cancel'),
    authSession: byId('auth-session'),
    authWho: byId('auth-who'),
    authSignout: byId('auth-signout'),
    authMsg: byId('auth-msg'),
  };

  el.tripAdd.addEventListener('click', () => openForm());
  el.tripCancel.addEventListener('click', closeForm);
  el.tripDelete.addEventListener('click', handleDelete);
  el.tripForm.addEventListener('submit', handleSubmit);

  el.authOpen.addEventListener('click', () => {
    setMessage(el.authMsg, '');
    show(el.authOpen, false); // the form replaces the button rather than joining it
    show(el.authForm, true);
    el.authEmail.focus();
  });
  el.authCancel.addEventListener('click', () => {
    show(el.authForm, false);
    show(el.authOpen, true);
    setMessage(el.authMsg, '');
  });
  el.authForm.addEventListener('submit', handleMagicLink);
  el.authSignout.addEventListener('click', async () => {
    await signOut();
    applySession(null);
  });

  show(el.authBar, true);

  getSession().then(applySession).catch((err) => {
    console.warn('Ride Report: could not read the session.', err);
  });
  onAuthChange(applySession);
}
