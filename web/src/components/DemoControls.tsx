import { useEffect, useState } from 'react';
import {
  getClubs,
  getPreferences,
  postEvent,
  putPreferences,
} from '../lib/api';
import type { Club, EventType, Me, Preferences } from '../lib/types';

const EVENT_TYPES: { value: EventType; label: string }[] = [
  { value: 'member_join', label: 'Member join' },
  { value: 'match_start', label: 'Match start' },
  { value: 'poll_open', label: 'Poll open' },
  { value: 'announcement', label: 'Announcement' },
];

export function DemoControls({ me }: { me: Me | null }) {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [clubId, setClubId] = useState('');
  const [type, setType] = useState<EventType>('announcement');
  const [text, setText] = useState('');
  const [firing, setFiring] = useState(false);
  const [fired, setFired] = useState(false);
  const [fireErr, setFireErr] = useState<string | null>(null);

  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [savingPref, setSavingPref] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getClubs()
      .then((cs) => {
        if (!alive) return;
        setClubs(cs);
        if (cs.length > 0) setClubId((prev) => prev || cs[0].id);
      })
      .catch(() => {
        /* clubs unavailable; select stays empty */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    getPreferences(me.userId)
      .then((p) => alive && setPrefs(p))
      .catch(() => {
        /* preferences unavailable */
      });
    return () => {
      alive = false;
    };
  }, [me]);

  const onFire = async () => {
    if (!clubId || firing) return;
    setFiring(true);
    setFireErr(null);
    try {
      await postEvent({ clubId, type, text: text.trim() || undefined });
      setFired(true);
      setText('');
      window.setTimeout(() => setFired(false), 1500);
    } catch (e) {
      setFireErr(e instanceof Error ? e.message : 'Failed to queue event');
    } finally {
      setFiring(false);
    }
  };

  const togglePref = async (key: 'inApp' | 'email' | 'push') => {
    if (!prefs) return;
    const next: Preferences = { ...prefs, [key]: !prefs[key] };
    setPrefs(next); // optimistic
    setSavingPref(key);
    try {
      const saved = await putPreferences(next);
      setPrefs(saved);
    } catch {
      setPrefs(prefs); // revert
    } finally {
      setSavingPref(null);
    }
  };

  return (
    <section className="panel controls">
      <div className="panel-head">
        <h2 className="panel-title">Demo Controls</h2>
      </div>

      <label className="field">
        <span className="field-label">Club</span>
        <select
          className="input"
          value={clubId}
          onChange={(e) => setClubId(e.target.value)}
          disabled={clubs.length === 0}
        >
          {clubs.length === 0 && <option value="">Loading clubs…</option>}
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.memberCount.toLocaleString()} · {c.kind}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field-label">Event type</span>
        <select
          className="input"
          value={type}
          onChange={(e) => setType(e.target.value as EventType)}
        >
          {EVENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field-label">Text (optional)</span>
        <input
          className="input"
          type="text"
          placeholder="e.g. Weekly blitz arena tonight!"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={140}
        />
      </label>

      <button
        className="btn btn--primary"
        onClick={onFire}
        disabled={firing || fired || !clubId}
      >
        {fired ? 'queued ✓' : firing ? 'firing…' : 'Simulate event'}
      </button>
      {fireErr && <p className="field-err">{fireErr}</p>}
      <p className="helper">
        Fires into the write-path buffer and returns immediately.
      </p>

      <div className="controls-divider" />

      <div className="prefs">
        <h3 className="prefs-title">Notification preferences</h3>
        {prefs == null ? (
          <p className="helper">Loading preferences…</p>
        ) : (
          <div className="toggle-row-group">
            <Toggle
              label="In-app"
              on={prefs.inApp}
              busy={savingPref === 'inApp'}
              onClick={() => togglePref('inApp')}
            />
            <Toggle
              label="Email"
              on={prefs.email}
              busy={savingPref === 'email'}
              onClick={() => togglePref('email')}
            />
            <Toggle
              label="Push"
              on={prefs.push}
              busy={savingPref === 'push'}
              onClick={() => togglePref('push')}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function Toggle({
  label,
  on,
  busy,
  onClick,
}: {
  label: string;
  on: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`toggle-row ${on ? 'is-on' : ''}`}
      onClick={onClick}
      disabled={busy}
      role="switch"
      aria-checked={on}
    >
      <span className="toggle-label">{label}</span>
      <span className="toggle-switch">
        <span className="toggle-knob" />
      </span>
    </button>
  );
}
