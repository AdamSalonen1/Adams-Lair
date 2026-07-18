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
  createTrip,
  updateTrip,
  deleteTrip,
} from './supabase.js';

const HOME = { location_name: 'Fargo, ND', lat: 46.8772, lon: -96.7898 };

let el = {};
let session = null;
let editingId = null;
let started = false;

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

  // Populated by the Phase 4 listener. Until then every trip shows the pending
  // line, which is the honest state rather than an empty space.
  const outlook = document.createElement('p');
  outlook.className = 'trip-outlook';
  if (report?.payload?.summary) {
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

    el.tripList.replaceChildren(...trips.map((trip) => tripCard(trip, reports.get(trip.id))));
    show(el.tripsEmpty, trips.length === 0);
  } catch (err) {
    console.error('Ride Report: could not load trips.', err);
    setMessage(el.tripError, 'Could not load trips. Try refreshing.', true);
  }
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

function readForm() {
  const fields = {
    title: el.tripTitle.value.trim(),
    location_name: el.tripLocation.value.trim(),
    lat: Number(el.tripLat.value),
    lon: Number(el.tripLon.value),
    start_date: el.tripStart.value,
    end_date: el.tripEnd.value,
    notes: el.tripNotes.value.trim() || null,
  };

  if (!fields.title) return { error: 'Give the trip a title.' };
  if (!fields.start_date || !fields.end_date) return { error: 'Both dates are required.' };
  // ISO dates compare correctly as strings, and the same rule is enforced by a
  // CHECK constraint — this exists to say so in English before the round trip.
  if (fields.end_date < fields.start_date) return { error: 'The end date is before the start date.' };
  if (!Number.isFinite(fields.lat) || !Number.isFinite(fields.lon)) {
    return { error: 'Latitude and longitude must be numbers.' };
  }

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
    if (editingId) await updateTrip(editingId, fields);
    else await createTrip(fields);
    closeForm();
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
    await deleteTrip(editingId);
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
