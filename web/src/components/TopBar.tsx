export function TopBar({ connected }: { connected: boolean }) {
  return (
    <header className="topbar">
      <div className="topbar-titles">
        <h1 className="topbar-title">Club Activity</h1>
        <p className="topbar-crumb">Social · Clubs · Activity</p>
      </div>
      <div
        className={`status-pill ${connected ? 'status-pill--live' : 'status-pill--off'}`}
        role="status"
      >
        <span className="status-dot" />
        {connected ? 'Live' : 'Reconnecting…'}
      </div>
    </header>
  );
}
