import { useEffect, useState } from 'react';
import { getMetrics } from '../lib/api';
import type { ClientStats, Metrics } from '../lib/types';

interface Props {
  stats: ClientStats;
}

// Server counters we surface, in display order. Only rendered if present.
const SERVER_FIELDS: { key: string; label: string; highlight?: boolean }[] = [
  { key: 'ingested', label: 'Ingested' },
  { key: 'drained', label: 'Drained' },
  { key: 'published', label: 'Published' },
  { key: 'fanned', label: 'Fanned' },
  { key: 'materialized', label: 'Materialized' },
  { key: 'digestCoalesced', label: 'Digest folded' },
  { key: 'digestFlushed', label: 'Digest summaries' },
  { key: 'notifyDelivered', label: 'Notifications' },
  { key: 'notifyDeduped', label: 'Deduped (exactly-once)', highlight: true },
  { key: 'bufferDepth', label: 'Buffer depth', highlight: true },
];

function fmt(n: number): string {
  return n.toLocaleString();
}

export function MetricsWidget({ stats }: Props) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const m = await getMetrics();
        if (!alive) return;
        setMetrics(m);
        setReachable(true);
      } catch {
        if (alive) setReachable(false);
      }
    };
    void tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const zeroGood = (n: number) => n === 0;

  return (
    <section className="panel metrics">
      <div className="panel-head">
        <h2 className="panel-title">Live guarantees</h2>
        <span className={`mini-pill ${reachable ? 'mini-pill--ok' : 'mini-pill--warn'}`}>
          {reachable ? 'polling 1s' : 'metrics offline'}
        </span>
      </div>

      {/* Client-observed guarantees (from the socket stream itself). */}
      <div className="metrics-client">
        <div className={`stat stat--big ${zeroGood(stats.duplicates) ? 'stat--good' : 'stat--bad'}`}>
          <span className="stat-num">{fmt(stats.duplicates)}</span>
          <span className="stat-label">Duplicates</span>
        </div>
        <div className={`stat stat--big ${zeroGood(stats.lost) ? 'stat--good' : 'stat--bad'}`}>
          <span className="stat-num">{fmt(stats.lost)}</span>
          <span className="stat-label">Lost</span>
        </div>
        <div className="stat stat--big">
          <span className="stat-num">{fmt(stats.delivered)}</span>
          <span className="stat-label">Delivered</span>
        </div>
      </div>

      <div className="metrics-latency">
        <span className="lat-item">
          <span className="lat-label">e2e latency</span>
          <span className="lat-val">
            {stats.lastLatencyMs == null ? '—' : `${stats.lastLatencyMs} ms`}
          </span>
        </span>
        <span className="lat-item">
          <span className="lat-label">rolling avg</span>
          <span className="lat-val">
            {stats.avgLatencyMs == null ? '—' : `${stats.avgLatencyMs} ms`}
          </span>
        </span>
      </div>

      <div className="metrics-divider">
        <span>server counters</span>
      </div>

      {metrics == null ? (
        <div className="metrics-loading">
          <span className="spinner" /> awaiting metrics…
        </div>
      ) : (
        <div className="metrics-grid">
          {SERVER_FIELDS.filter((f) => f.key in metrics).map((f) => (
            <div className={`mcell ${f.highlight ? 'mcell--hi' : ''}`} key={f.key}>
              <span className="mcell-num">{fmt(metrics[f.key])}</span>
              <span className="mcell-label">{f.label}</span>
            </div>
          ))}
        </div>
      )}
      <p className="helper">
        Duplicates &amp; Lost are computed from the socket stream this browser
        receives; server counters come from <code>/api/metrics</code>.
      </p>
    </section>
  );
}
