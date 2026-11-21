import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
];

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
SCOPES.forEach((scope) => provider.addScope(scope));

let isSigningIn = false;
let cachedAccessToken: string | null = null;
let currentUser: User | null = null;

export interface CalendarReminderOverride {
  method: 'popup' | 'email';
  minutes: number;
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  location?: string;
  date: string; // YYYY-MM-DD
  allDay: boolean;
  startTime?: string; // HH:mm
  durationMinutes?: number;
  reminderMinutes: number;
  reminderMethod: 'popup' | 'email' | 'both';
  entityId: string;
  entityType: string;
  reminderKind?: string;
}

export interface CalendarEventRecord {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

function nextDate(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

function buildEventPayload(input: CalendarEventInput) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let start: { date?: string; dateTime?: string; timeZone?: string };
  let end: { date?: string; dateTime?: string; timeZone?: string };

  if (input.allDay) {
    start = { date: input.date };
    end = { date: nextDate(input.date) };
  } else {
    const timeStr = input.startTime || '09:00';
    const startDt = new Date(`${input.date}T${timeStr}:00`);
    const dur = Math.max(15, input.durationMinutes || 30);
    const endDt = new Date(startDt.getTime() + dur * 60000);
    start = { dateTime: startDt.toISOString(), timeZone: tz };
    end = { dateTime: endDt.toISOString(), timeZone: tz };
  }

  const overrides: CalendarReminderOverride[] = [];
  if (input.reminderMethod === 'both') {
    overrides.push({ method: 'popup', minutes: input.reminderMinutes });
    overrides.push({ method: 'email', minutes: input.reminderMinutes });
  } else {
    overrides.push({ method: input.reminderMethod, minutes: input.reminderMinutes });
  }

  return {
    summary: input.summary,
    description: input.description || '',
    location: input.location || '',
    start,
    end,
    reminders: {
      useDefault: false,
      overrides,
    },
    extendedProperties: {
      private: {
        phdMapApp: 'true',
        phdMapEntityId: input.entityId,
        phdMapType: input.entityType,
        phdMapKind: input.reminderKind || 'custom',
      },
    },
  };
}

async function calendarFetch(url: string, init: RequestInit = {}) {
  const token = cachedAccessToken;
  if (!token) {
    throw new Error('AUTH_REQUIRED');
  }
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) {
    cachedAccessToken = null;
    window.dispatchEvent(new CustomEvent('phdmap:gcal-auth-changed', {
      detail: { signedIn: false, user: currentUser },
    }));
    throw new Error('AUTH_EXPIRED');
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson?.error?.message) detail = errJson.error.message;
    } catch {
      // ignore json parse failure
    }
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

const emitGoogleAuthState = (user: User | null) => {
  window.dispatchEvent(new CustomEvent('phdmap:google-auth-changed', {
    detail: {
      authenticated: Boolean(user),
      calendarConnected: Boolean(cachedAccessToken && user),
      user,
    },
  }));
};

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, (user: User | null) => {
    currentUser = user;
    if (user) {
      if (cachedAccessToken) {
        onAuthSuccess?.(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        onAuthFailure?.();
      }
    } else {
      cachedAccessToken = null;
      onAuthFailure?.();
    }
    emitGoogleAuthState(user);
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string }> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Google Calendar access token.');
    }
    cachedAccessToken = credential.accessToken;
    currentUser = result.user;
    window.dispatchEvent(new CustomEvent('phdmap:gcal-auth-changed', {
      detail: { signedIn: true, user: result.user },
    }));
    emitGoogleAuthState(result.user);
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => cachedAccessToken;

export const getIdToken = async (forceRefresh = false): Promise<string | null> => {
  if (!currentUser) return null;
  return currentUser.getIdToken(forceRefresh);
};

export const logout = async () => {
  await auth.signOut();
  cachedAccessToken = null;
  currentUser = null;
  window.dispatchEvent(new CustomEvent('phdmap:gcal-auth-changed', {
    detail: { signedIn: false, user: null },
  }));
  emitGoogleAuthState(null);
};

export const listEntityEvents = async (entityId: string): Promise<CalendarEventRecord[]> => {
  const params = new URLSearchParams({
    privateExtendedProperty: `phdMapEntityId=${entityId}`,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '25',
  });
  const data = await calendarFetch(`${CALENDAR_API}?${params.toString()}`);
  return data?.items || [];
};

export const listAllPhdMapEvents = async (): Promise<CalendarEventRecord[]> => {
  const params = new URLSearchParams({
    privateExtendedProperty: 'phdMapApp=true',
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });
  const data = await calendarFetch(`${CALENDAR_API}?${params.toString()}`);
  return data?.items || [];
};

export const createCalendarEvent = async (input: CalendarEventInput): Promise<CalendarEventRecord> => {
  return calendarFetch(CALENDAR_API, {
    method: 'POST',
    body: JSON.stringify(buildEventPayload(input)),
  });
};

export const updateCalendarEvent = async (
  eventId: string,
  input: CalendarEventInput
): Promise<CalendarEventRecord> => {
  return calendarFetch(`${CALENDAR_API}/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify(buildEventPayload(input)),
  });
};

export const deleteCalendarEvent = async (eventId: string): Promise<void> => {
  await calendarFetch(`${CALENDAR_API}/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  });
};

declare global {
  interface Window {
    GoogleCalendarBridge: {
      SCOPES: string[];
      initAuth: typeof initAuth;
      googleSignIn: typeof googleSignIn;
      getAccessToken: typeof getAccessToken;
      getIdToken: typeof getIdToken;
      logout: typeof logout;
      isSignedIn: () => boolean;
      isGoogleAuthenticated: () => boolean;
      getUserInfo: () => { email: string | null; displayName: string | null } | null;
      listEntityEvents: typeof listEntityEvents;
      listAllPhdMapEvents: typeof listAllPhdMapEvents;
      createCalendarEvent: typeof createCalendarEvent;
      updateCalendarEvent: typeof updateCalendarEvent;
      deleteCalendarEvent: typeof deleteCalendarEvent;
    };
  }
}

window.GoogleCalendarBridge = {
  SCOPES,
  initAuth,
  googleSignIn,
  getAccessToken,
  getIdToken,
  logout,
  isSignedIn: () => Boolean(cachedAccessToken && currentUser),
  isGoogleAuthenticated: () => Boolean(currentUser),
  getUserInfo: () => currentUser ? { email: currentUser.email, displayName: currentUser.displayName } : null,
  listEntityEvents,
  listAllPhdMapEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
};
