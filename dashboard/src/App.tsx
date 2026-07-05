import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Zap, LayoutDashboard, Layers, Briefcase, Cpu, Skull,
  RefreshCw, Play, Pause, LogOut, ChevronRight, Search,
  CheckCircle, XCircle, Clock, AlertTriangle, Activity,
  ArrowUpRight, ArrowDownRight, RotateCcw, Eye, EyeOff,
  Shield, Wifi, WifiOff, Database, Server, Terminal,
  ChevronLeft, MoreHorizontal, Loader2, Inbox
} from 'lucide-react';
import { api } from './api/client';

// ─── Types ────────────────────────────────────────────────────────────────────

interface User { id: string; email: string; role: string; }
interface Queue {
  id: string; name: string; isPaused: boolean;
  concurrencyLimit: number; projectId: string;
}
interface QueueStats {
  queueId: string; queueName: string; isPaused: boolean;
  statusCounts: Record<string, number>; total: number;
  oldestQueuedJobAge: number | null;
}
interface Job {
  id: string; type: string; status: string; priority: number;
  retryCount: number; maxRetries: number; createdAt: string;
  runAt: string; completedAt?: string; startedAt?: string;
  idempotencyKey?: string; lastFailureReason?: string;
  queueId: string;
}
interface Worker {
  id: string; hostname: string; pid: number; status: string;
  concurrency: number; currentLoad: number; memoryMb: number;
  lastSeenAt: string; startedAt: string;
}
interface DLQEntry {
  id: string; jobId: string; queueId: string; reason: string;
  failedAt: string; retriedFromDlqAt?: string;
  payloadSnapshot: Record<string, unknown>;
}

type Page = 'overview' | 'queues' | 'jobs' | 'workers' | 'dlq';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase();
  const icons: Record<string, JSX.Element> = {
    queued:      <Clock size={9} />,
    claimed:     <Activity size={9} />,
    running:     <Loader2 size={9} className="animate-spin-slow" />,
    completed:   <CheckCircle size={9} />,
    failed:      <XCircle size={9} />,
    dead_letter: <Skull size={9} />,
    scheduled:   <Clock size={9} />,
    online:      <Wifi size={9} />,
    offline:     <WifiOff size={9} />,
    draining:    <AlertTriangle size={9} />,
  };
  return (
    <span className={`status-pill status-pill-${s}`}>
      {icons[s] ?? null}
      {status.replace('_', ' ')}
    </span>
  );
}

function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={{ height: 14, ...style }} />;
}

function EmptyState({ icon, title, subtitle }: { icon: JSX.Element; title: string; subtitle: string }) {
  return (
    <div className="empty-state">
      {icon}
      <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)' }}>{title}</p>
      <p style={{ fontSize: 13 }}>{subtitle}</p>
    </div>
  );
}

// ─── Logo ─────────────────────────────────────────────────────────────────────

function RelayLogo({ collapsed }: { collapsed: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        width: 32, height: 32, borderRadius: 9,
        background: 'linear-gradient(135deg, #7C3AED 0%, #4F46E5 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 0 20px #7C3AED33',
        flexShrink: 0,
      }}>
        <Zap size={16} color="white" fill="white" />
      </div>
      {!collapsed && (
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>
            Relay
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Job Infrastructure
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

interface NavItem { id: Page; label: string; icon: JSX.Element; badge?: number; }

function Sidebar({
  page, setPage, user, onLogout, dlqCount
}: {
  page: Page; setPage: (p: Page) => void;
  user: User; onLogout: () => void; dlqCount: number;
}) {
  const nav: NavItem[] = [
    { id: 'overview', label: 'Overview',     icon: <LayoutDashboard size={16} /> },
    { id: 'queues',   label: 'Queues',       icon: <Layers size={16} /> },
    { id: 'jobs',     label: 'Jobs',         icon: <Briefcase size={16} /> },
    { id: 'workers',  label: 'Workers',      icon: <Cpu size={16} /> },
    { id: 'dlq',      label: 'Dead Letters', icon: <Skull size={16} />, badge: dlqCount },
  ];

  return (
    <aside className="animate-slide-in-left" style={{
      width: 224, flexShrink: 0,
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      height: '100vh', position: 'sticky', top: 0,
    }}>
      {/* Logo */}
      <div style={{ padding: '20px 16px 18px', borderBottom: '1px solid var(--border)' }}>
        <RelayLogo collapsed={false} />
      </div>

      {/* Nav */}
      <nav style={{ padding: '10px 10px', flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {nav.map(item => (
          <button
            key={item.id}
            className={`nav-item ${page === item.id ? 'active' : ''}`}
            onClick={() => setPage(item.id)}
          >
            {item.icon}
            {item.label}
            {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
          </button>
        ))}
      </nav>

      {/* User */}
      <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
            background: 'linear-gradient(135deg, #7C3AED, #3B82F6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700, color: 'white',
          }}>
            {user.email[0].toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.email}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Shield size={10} color="var(--text-muted)" />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {user.role}
              </span>
            </div>
          </div>
        </div>
        <button className="btn btn-secondary" style={{ width: '100%', fontSize: 12 }} onClick={onLogout}>
          <LogOut size={13} />
          Sign out
        </button>
      </div>
    </aside>
  );
}

// ─── Top Bar ──────────────────────────────────────────────────────────────────

function TopBar({
  title, subtitle, isLive, lastUpdated, onRefresh, loading, actions
}: {
  title: string; subtitle?: string; isLive: boolean;
  lastUpdated: Date | null; onRefresh: () => void; loading: boolean;
  actions?: JSX.Element;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '16px 28px', borderBottom: '1px solid var(--border)',
      background: 'var(--bg-base)', position: 'sticky', top: 0, zIndex: 10,
      backdropFilter: 'blur(8px)',
    }}>
      <div>
        <h1 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>{subtitle}</p>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {lastUpdated && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Updated {timeAgo(lastUpdated.toISOString())}
          </span>
        )}
        {isLive && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#10B9811A', border: '1px solid #10B98122', borderRadius: 999, padding: '4px 10px' }}>
            <div className="live-dot" />
            <span style={{ fontSize: 11, fontWeight: 600, color: '#34D399', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Live</span>
          </div>
        )}
        <button className="btn-icon" onClick={onRefresh} disabled={loading} title="Refresh">
          <RefreshCw size={14} className={loading ? 'animate-spin-slow' : ''} />
        </button>
        {actions}
      </div>
    </div>
  );
}

// ─── Metric Card ──────────────────────────────────────────────────────────────

function MetricCard({
  label, value, icon, color, sub, loading
}: {
  label: string; value: number | string; icon: JSX.Element;
  color: string; sub?: string; loading?: boolean;
}) {
  return (
    <div className="metric-card animate-fade-in">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {label}
        </span>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: `${color}1A`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: color,
        }}>
          {icon}
        </div>
      </div>
      {loading
        ? <Skeleton className="" style={{ height: 32, width: '60%' }} />
        : (
          <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
            {value.toLocaleString()}
          </div>
        )
      }
      {sub && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>{sub}</p>}
    </div>
  );
}

// ─── Overview Page ────────────────────────────────────────────────────────────

function OverviewPage({ token }: { token: string }) {
  const [stats, setStats] = useState<{ queues: QueueStats[]; workers: Worker[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [queuesRes, workersRes] = await Promise.all([
        api.get('/api/queues', token),
        api.get('/api/workers', token),
      ]);
      const queueStats = await Promise.all(
        (queuesRes.data as Queue[]).map((q: Queue) => api.get(`/api/queues/${q.id}/stats`, token))
      );
      setStats({ queues: queueStats as QueueStats[], workers: workersRes.data as Worker[] });
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  const totals = stats?.queues.reduce((acc, q) => {
    Object.entries(q.statusCounts).forEach(([k, v]) => { acc[k] = (acc[k] ?? 0) + v; });
    acc._total = (acc._total ?? 0) + q.total;
    return acc;
  }, {} as Record<string, number>) ?? {};

  const onlineWorkers = stats?.workers.filter(w => w.status === 'ONLINE') ?? [];

  return (
    <div className="animate-fade-in">
      <TopBar
        title="Overview"
        subtitle="System-wide metrics across all queues and workers"
        isLive loading={loading}
        lastUpdated={lastUpdated}
        onRefresh={load}
      />
      <div style={{ padding: '28px', display: 'flex', flexDirection: 'column', gap: 28 }}>

        {/* System health strip */}
        <div className="card" style={{ padding: '14px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>System Health</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success)' }} />
              <Database size={13} color="var(--text-secondary)" />
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Postgres</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success)' }} />
              <Server size={13} color="var(--text-secondary)" />
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Redis</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: onlineWorkers.length > 0 ? 'var(--success)' : 'var(--danger)' }} />
              <Cpu size={13} color="var(--text-secondary)" />
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                {onlineWorkers.length} worker{onlineWorkers.length !== 1 ? 's' : ''} online
              </span>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="live-dot" />
              <span style={{ fontSize: 11.5, color: '#34D399', fontWeight: 600 }}>All systems operational</span>
            </div>
          </div>
        </div>

        {/* Metric cards */}
        <div className="stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          <MetricCard label="Total Jobs" value={totals._total ?? 0} icon={<Briefcase size={15} />} color="#7C3AED" sub="Across all queues" loading={loading} />
          <MetricCard label="Completed" value={totals.COMPLETED ?? 0} icon={<CheckCircle size={15} />} color="#10B981" sub={`${totals._total ? Math.round((totals.COMPLETED ?? 0) / totals._total * 100) : 0}% success rate`} loading={loading} />
          <MetricCard label="Failed / Retrying" value={(totals.FAILED ?? 0) + (totals.QUEUED ?? 0)} icon={<AlertTriangle size={15} />} color="#F59E0B" sub={`${totals.QUEUED ?? 0} queued`} loading={loading} />
          <MetricCard label="Dead Letters" value={totals.DEAD_LETTER ?? 0} icon={<Skull size={15} />} color="#EF4444" sub="Require attention" loading={loading} />
        </div>

        {/* Queue breakdown + Worker status side by side */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 20 }}>
          {/* Queue breakdown */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Queue Summary</h2>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{stats?.queues.length ?? 0} queues</span>
            </div>
            {loading ? (
              <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {[1, 2].map(i => <Skeleton key={i} style={{ height: 40 }} />)}
              </div>
            ) : stats?.queues.map(q => {
              const completed = q.statusCounts.COMPLETED ?? 0;
              const pct = q.total > 0 ? Math.round(completed / q.total * 100) : 0;
              return (
                <div key={q.queueId} style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: q.isPaused ? 'var(--warning)' : 'var(--success)' }} />
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{q.queueName}</span>
                      {q.isPaused && <StatusPill status="PAUSED" />}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{pct}% complete</span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{q.total} jobs</span>
                    </div>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-bar-fill" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, #7C3AED, #10B981)' }} />
                  </div>
                  <div style={{ display: 'flex', gap: 12 }}>
                    {Object.entries(q.statusCounts).map(([k, v]) => (
                      <span key={k} style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{v}</span> {k.toLowerCase()}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Workers panel */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Workers</h2>
            </div>
            {loading ? (
              <div style={{ padding: 20 }}><Skeleton style={{ height: 60 }} /></div>
            ) : stats?.workers.length === 0 ? (
              <EmptyState icon={<Cpu size={32} />} title="No workers" subtitle="Start a worker process to begin processing jobs" />
            ) : stats?.workers.map(w => {
              const loadPct = Math.round(w.currentLoad / w.concurrency * 100);
              return (
                <div key={w.id} style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{w.hostname}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono', marginTop: 2 }}>PID {w.pid}</div>
                    </div>
                    <StatusPill status={w.status} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Load {w.currentLoad}/{w.concurrency}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{w.memoryMb?.toFixed(1)} MB</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-bar-fill" style={{ width: `${loadPct}%`, background: loadPct > 80 ? 'var(--danger)' : loadPct > 50 ? 'var(--warning)' : 'var(--accent)' }} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Last seen {timeAgo(w.lastSeenAt)}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Queues Page ──────────────────────────────────────────────────────────────

function QueuesPage({ token }: { token: string }) {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [stats, setStats] = useState<Record<string, QueueStats>>({});
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/queues', token);
      const qs = res.data as Queue[];
      setQueues(qs);
      const statsArr = await Promise.all(qs.map(q => api.get(`/api/queues/${q.id}/stats`, token)));
      const statsMap: Record<string, QueueStats> = {};
      statsArr.forEach((s, i) => { statsMap[qs[i].id] = s as QueueStats; });
      setStats(statsMap);
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  const togglePause = async (q: Queue) => {
    setActionLoading(q.id);
    try {
      if (q.isPaused) await api.post(`/api/queues/${q.id}/resume`, {}, token);
      else await api.post(`/api/queues/${q.id}/pause`, {}, token);
      await load();
    } finally { setActionLoading(null); }
  };

  const STATUS_COLORS: Record<string, string> = {
    QUEUED: '#3B82F6', CLAIMED: '#F59E0B', RUNNING: '#7C3AED',
    COMPLETED: '#10B981', FAILED: '#EF4444', DEAD_LETTER: '#EF4444',
    SCHEDULED: '#F59E0B',
  };

  return (
    <div className="animate-fade-in">
      <TopBar title="Queues" subtitle="Monitor and control job queues" isLive loading={loading} lastUpdated={lastUpdated} onRefresh={load} />
      <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loading && queues.length === 0 ? (
          <div className="stagger" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {[1, 2].map(i => <div key={i} className="card"><Skeleton style={{ height: 100 }} /></div>)}
          </div>
        ) : queues.length === 0 ? (
          <EmptyState icon={<Layers size={36} />} title="No queues yet" subtitle="Create a queue via the API to get started" />
        ) : (
          <div className="stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 20 }}>
            {queues.map(q => {
              const s = stats[q.id];
              const total = s?.total ?? 0;
              const completed = s?.statusCounts.COMPLETED ?? 0;
              const dlq = s?.statusCounts.DEAD_LETTER ?? 0;
              const isActioning = actionLoading === q.id;
              return (
                <div key={q.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  {/* Header */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{
                        width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                        background: q.isPaused ? '#F59E0B1A' : '#7C3AED1A',
                        border: `1px solid ${q.isPaused ? '#F59E0B22' : '#7C3AED22'}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: q.isPaused ? '#FCD34D' : '#A78BFA',
                      }}>
                        <Layers size={17} />
                      </div>
                      <div>
                        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{q.name}</h3>
                        <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }}>{q.id.slice(0, 16)}…</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {dlq > 0 && (
                        <div style={{ background: '#EF44441A', border: '1px solid #EF444433', borderRadius: 6, padding: '2px 8px', fontSize: 11.5, color: '#F87171', fontWeight: 600 }}>
                          {dlq} DLQ
                        </div>
                      )}
                      <StatusPill status={q.isPaused ? 'PAUSED' : 'ONLINE'} />
                    </div>
                  </div>

                  {/* Stats */}
                  {s ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                      {[
                        { label: 'Total', val: total, color: 'var(--text-primary)' },
                        { label: 'Completed', val: completed, color: '#10B981' },
                        { label: 'Dead Letter', val: dlq, color: dlq > 0 ? '#EF4444' : 'var(--text-muted)' },
                      ].map(({ label, val, color }) => (
                        <div key={label} style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border-subtle)' }}>
                          <div style={{ fontSize: 19, fontWeight: 700, color, letterSpacing: '-0.02em' }}>{val}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
                        </div>
                      ))}
                    </div>
                  ) : <Skeleton style={{ height: 60 }} />}

                  {/* Status bar */}
                  {s && total > 0 && (
                    <div>
                      <div style={{ display: 'flex', height: 6, borderRadius: 999, overflow: 'hidden', gap: 1 }}>
                        {Object.entries(s.statusCounts).map(([k, v]) => (
                          <div key={k} style={{ flex: v, background: STATUS_COLORS[k] ?? 'var(--border)', transition: 'flex 0.4s ease' }} />
                        ))}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 8 }}>
                        {Object.entries(s.statusCounts).map(([k, v]) => (
                          <span key={k} style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            <span style={{ color: STATUS_COLORS[k] ?? 'var(--text-muted)', fontWeight: 600 }}>■</span> {v} {k}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Concurrency + age */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 0', borderTop: '1px solid var(--border-subtle)' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Concurrency: <strong style={{ color: 'var(--text-secondary)' }}>{q.concurrencyLimit}</strong>
                    </span>
                    {s?.oldestQueuedJobAge != null && (
                      <span style={{ fontSize: 12, color: s.oldestQueuedJobAge > 60000 ? 'var(--warning)' : 'var(--text-muted)' }}>
                        Oldest queued: <strong>{fmtDuration(s.oldestQueuedJobAge)}</strong>
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <button
                    className={`btn ${q.isPaused ? 'btn-success' : 'btn-secondary'}`}
                    onClick={() => togglePause(q)}
                    disabled={isActioning}
                    style={{ width: '100%' }}
                  >
                    {isActioning ? <Loader2 size={14} className="animate-spin-slow" /> : q.isPaused ? <Play size={14} /> : <Pause size={14} />}
                    {q.isPaused ? 'Resume Queue' : 'Pause Queue'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Jobs Page ────────────────────────────────────────────────────────────────

function JobsPage({ token }: { token: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const PAGE_SIZE = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status) params.set('status', status);
      if (type) params.set('type', type);
      const res = await api.get(`/api/jobs?${params}`, token);
      setJobs(res.data as Job[]);
      setTotal(res.pagination?.total ?? 0);
      setTotalPages(res.pagination?.totalPages ?? 1);
      setLastUpdated(new Date());
    } finally { setLoading(false); }
  }, [token, status, type, page]);

  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  const retryJob = async (jobId: string) => {
    setActionLoading(jobId);
    try { await api.post(`/api/jobs/${jobId}/retry`, {}, token); await load(); }
    finally { setActionLoading(null); }
  };

  const jobTypes = [...new Set(jobs.map(j => j.type))];

  return (
    <div className="animate-fade-in">
      <TopBar
        title="Jobs"
        subtitle={`${total.toLocaleString()} total jobs`}
        isLive loading={loading} lastUpdated={lastUpdated} onRefresh={load}
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="select" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All Statuses</option>
              {['QUEUED','CLAIMED','RUNNING','COMPLETED','FAILED','DEAD_LETTER','SCHEDULED'].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select className="select" value={type} onChange={e => { setType(e.target.value); setPage(1); }}>
              <option value="">All Types</option>
              {jobTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        }
      />
      <div style={{ padding: '0 0 28px' }}>
        <div className="card" style={{ margin: '24px 28px 0', padding: 0, overflow: 'hidden' }}>
          {loading && jobs.length === 0 ? (
            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[...Array(6)].map((_, i) => <Skeleton key={i} style={{ height: 20 }} />)}
            </div>
          ) : jobs.length === 0 ? (
            <EmptyState icon={<Inbox size={36} />} title="No jobs found" subtitle="Try adjusting your filters or create a new job via the API" />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Retries</th>
                  <th>Created</th>
                  <th>Started</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(j => (
                  <>
                    <tr key={j.id} style={{ cursor: 'pointer' }} onClick={() => setExpandedJob(expandedJob === j.id ? null : j.id)}>
                      <td className="mono">{j.id.slice(0, 20)}…</td>
                      <td className="primary">
                        <code style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 7px', fontSize: 11.5, color: '#A78BFA', fontFamily: 'JetBrains Mono' }}>
                          {j.type}
                        </code>
                      </td>
                      <td><StatusPill status={j.status} /></td>
                      <td>
                        <span style={{ fontFamily: 'JetBrains Mono', fontSize: 12, color: j.priority >= 8 ? '#F87171' : j.priority >= 5 ? '#FCD34D' : 'var(--text-muted)' }}>
                          P{j.priority}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontSize: 12.5, color: j.retryCount > 0 ? 'var(--warning)' : 'var(--text-muted)' }}>
                          {j.retryCount}/{j.maxRetries}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{timeAgo(j.createdAt)}</td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{j.startedAt ? timeAgo(j.startedAt) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                          {(j.status === 'FAILED' || j.status === 'DEAD_LETTER') && (
                            <button className="btn btn-secondary btn-sm" onClick={() => retryJob(j.id)} disabled={actionLoading === j.id}>
                              {actionLoading === j.id ? <Loader2 size={11} className="animate-spin-slow" /> : <RotateCcw size={11} />}
                              Retry
                            </button>
                          )}
                          <button className="btn-icon" style={{ padding: '4px 7px' }} onClick={() => setExpandedJob(expandedJob === j.id ? null : j.id)}>
                            {expandedJob === j.id ? <EyeOff size={12} /> : <Eye size={12} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedJob === j.id && (
                      <tr key={`${j.id}-detail`}>
                        <td colSpan={8} style={{ background: 'var(--bg-elevated)', padding: '14px 20px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                            {[
                              ['Queue ID', j.queueId],
                              ['Idempotency Key', j.idempotencyKey ?? '—'],
                              ['Run At', j.runAt ? new Date(j.runAt).toLocaleString() : '—'],
                            ].map(([k, v]) => (
                              <div key={k}>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{k}</div>
                                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono' }}>{v}</div>
                              </div>
                            ))}
                          </div>
                          {j.lastFailureReason && (
                            <div style={{ marginTop: 12 }}>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Last failure</div>
                              <div className="mono-block" style={{ color: '#F87171' }}>{j.lastFailureReason}</div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 28px' }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              Page {page} of {totalPages} · {total} jobs
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                <ChevronLeft size={13} />
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                <ChevronRight size={13} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Workers Page ─────────────────────────────────────────────────────────────

function WorkersPage({ token }: { token: string }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/workers', token);
      setWorkers(res.data as Worker[]);
      setLastUpdated(new Date());
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  return (
    <div className="animate-fade-in">
      <TopBar title="Workers" subtitle="Live worker fleet status and metrics" isLive loading={loading} lastUpdated={lastUpdated} onRefresh={load} />
      <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loading && workers.length === 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
            {[1, 2].map(i => <div key={i} className="card"><Skeleton style={{ height: 120 }} /></div>)}
          </div>
        ) : workers.length === 0 ? (
          <EmptyState icon={<Cpu size={36} />} title="No workers registered" subtitle="Run `npm run dev:worker` to start processing jobs" />
        ) : (
          <div className="stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 18 }}>
            {workers.map(w => {
              const loadPct = Math.round(w.currentLoad / w.concurrency * 100);
              const isOnline = w.status === 'ONLINE';
              return (
                <div key={w.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16, border: `1px solid ${isOnline ? '#10B98118' : 'var(--border)'}` }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{
                        width: 42, height: 42, borderRadius: 11, flexShrink: 0,
                        background: isOnline ? '#10B9811A' : 'var(--bg-elevated)',
                        border: `1px solid ${isOnline ? '#10B98122' : 'var(--border)'}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: isOnline ? '#34D399' : 'var(--text-muted)',
                        position: 'relative',
                      }}>
                        <Cpu size={18} />
                        {isOnline && (
                          <div style={{ position: 'absolute', bottom: 3, right: 3 }}>
                            <div className="live-dot" style={{ width: 6, height: 6 }} />
                          </div>
                        )}
                      </div>
                      <div>
                        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{w.hostname}</h3>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                          <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }}>PID {w.pid}</span>
                          <span style={{ color: 'var(--border)' }}>·</span>
                          <StatusPill status={w.status} />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Load */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Job Load</span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: loadPct > 80 ? '#F87171' : loadPct > 50 ? '#FCD34D' : '#34D399' }}>
                        {w.currentLoad}/{w.concurrency} ({loadPct}%)
                      </span>
                    </div>
                    <div className="progress-bar" style={{ height: 6 }}>
                      <div className="progress-bar-fill" style={{ width: `${loadPct}%`, background: loadPct > 80 ? 'var(--danger)' : loadPct > 50 ? 'var(--warning)' : 'linear-gradient(90deg, #7C3AED, #10B981)' }} />
                    </div>
                  </div>

                  {/* Stats row */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                    {[
                      { label: 'Memory', val: `${w.memoryMb?.toFixed(1)} MB` },
                      { label: 'Uptime', val: timeAgo(w.startedAt) },
                      { label: 'Last Seen', val: timeAgo(w.lastSeenAt) },
                    ].map(({ label, val }) => (
                      <div key={label} style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: '8px 10px', border: '1px solid var(--border-subtle)' }}>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', marginTop: 3 }}>{val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DLQ Page ─────────────────────────────────────────────────────────────────

function DLQPage({ token }: { token: string }) {
  const [entries, setEntries] = useState<DLQEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/api/dlq?page=${page}&pageSize=20`, token);
      setEntries(res.data as DLQEntry[]);
      setTotal(res.pagination?.total ?? 0);
      setTotalPages(res.pagination?.totalPages ?? 1);
      setLastUpdated(new Date());
    } finally { setLoading(false); }
  }, [token, page]);

  useEffect(() => { load(); }, [load]);

  const retryEntry = async (e: DLQEntry) => {
    setActionLoading(e.id);
    try { await api.post(`/api/jobs/${e.jobId}/retry`, {}, token); await load(); }
    finally { setActionLoading(null); }
  };

  return (
    <div className="animate-fade-in">
      <TopBar
        title="Dead Letters"
        subtitle={`${total} jobs failed all retry attempts`}
        isLive={false} loading={loading} lastUpdated={lastUpdated} onRefresh={load}
      />
      <div style={{ padding: '0 0 28px' }}>
        {total > 0 && (
          <div style={{ margin: '20px 28px 0', padding: '12px 16px', background: '#EF44440A', border: '1px solid #EF444422', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangle size={15} color="#F87171" />
            <span style={{ fontSize: 13, color: '#F87171' }}>
              <strong>{total}</strong> job{total !== 1 ? 's' : ''} exhausted all retries. Review the failure reasons below and retry or dismiss.
            </span>
          </div>
        )}
        <div className="card" style={{ margin: '16px 28px 0', padding: 0, overflow: 'hidden' }}>
          {loading && entries.length === 0 ? (
            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[...Array(4)].map((_, i) => <Skeleton key={i} style={{ height: 20 }} />)}
            </div>
          ) : entries.length === 0 ? (
            <EmptyState icon={<CheckCircle size={36} color="#10B981" />} title="No dead letters" subtitle="All jobs have been successfully processed or retried" />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Queue</th>
                  <th>Failure Reason</th>
                  <th>Failed At</th>
                  <th>Retried</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <>
                    <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                      <td className="mono">{e.jobId.slice(0, 18)}…</td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }}>{e.queueId.slice(0, 16)}…</td>
                      <td>
                        <span style={{ fontSize: 12.5, color: '#F87171', fontFamily: 'JetBrains Mono', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280, display: 'block' }}>
                          {e.reason}
                        </span>
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{timeAgo(e.failedAt)}</td>
                      <td>
                        {e.retriedFromDlqAt
                          ? <span style={{ fontSize: 11.5, color: '#34D399' }}>Retried {timeAgo(e.retriedFromDlqAt)}</span>
                          : <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }} onClick={ev => ev.stopPropagation()}>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => retryEntry(e)}
                            disabled={!!actionLoading}
                          >
                            {actionLoading === e.id ? <Loader2 size={11} className="animate-spin-slow" /> : <RotateCcw size={11} />}
                            Retry
                          </button>
                          <button className="btn-icon" style={{ padding: '4px 7px' }} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                            {expanded === e.id ? <EyeOff size={12} /> : <Eye size={12} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded === e.id && (
                      <tr key={`${e.id}-payload`}>
                        <td colSpan={6} style={{ background: 'var(--bg-elevated)', padding: '14px 20px' }}>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                            Payload Snapshot
                          </div>
                          <div className="mono-block">
                            {JSON.stringify(e.payloadSnapshot, null, 2)}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 28px' }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Page {page} of {totalPages} · {total} entries</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}><ChevronLeft size={13} /></button>
              <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}><ChevronRight size={13} /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Login Page ───────────────────────────────────────────────────────────────

function LoginPage({ onLogin }: { onLogin: (token: string, user: User) => void }) {
  const [email, setEmail] = useState('admin@demo.com');
  const [password, setPassword] = useState('password123');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPw, setShowPw] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await api.post('/api/auth/login', { email, password });
      onLogin(res.token, res.user);
    } catch {
      setError('Invalid credentials. Please check your email and password.');
    } finally { setLoading(false); }
  };

  return (
    <div className="login-page">
      <div className="animate-fade-in" style={{ width: '100%', maxWidth: 400, padding: '0 20px' }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14,
            background: 'linear-gradient(135deg, #7C3AED 0%, #4F46E5 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
            boxShadow: '0 0 40px #7C3AED44, 0 0 80px #7C3AED22',
          }}>
            <Zap size={24} color="white" fill="white" />
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginBottom: 6 }}>
            Relay
          </h1>
          <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>
            Distributed job infrastructure for engineering teams
          </p>
        </div>

        {/* Card */}
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 16, padding: 28,
          boxShadow: '0 0 0 1px #ffffff04, 0 20px 40px #00000044',
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 20 }}>
            Sign in to your workspace
          </h2>
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
                Email address
              </label>
              <input
                className="input"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoFocus
              />
            </div>
            <div>
              <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
                Password
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  className="input"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  style={{ paddingRight: 40 }}
                />
                <button type="button" onClick={() => setShowPw(!showPw)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            {error && (
              <div style={{ padding: '10px 12px', background: '#EF44440D', border: '1px solid #EF444422', borderRadius: 8, fontSize: 13, color: '#F87171' }}>
                {error}
              </div>
            )}
            <button className="btn btn-primary" type="submit" disabled={loading} style={{ marginTop: 4, padding: '10px 16px', fontSize: 14 }}>
              {loading ? <Loader2 size={15} className="animate-spin-slow" /> : <Zap size={15} fill="white" />}
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', marginTop: 20 }}>
          Relay · Distributed Job Infrastructure
        </p>
      </div>
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('relay_token') ?? '');
  const [user, setUser] = useState<User | null>(() => {
    try { return JSON.parse(localStorage.getItem('relay_user') ?? 'null'); } catch { return null; }
  });
  const [page, setPage] = useState<Page>('overview');
  const [dlqCount, setDlqCount] = useState(0);

  useEffect(() => {
    if (!token) return;
    const fetchDlq = async () => {
      try {
        const res = await api.get('/api/dlq?pageSize=1', token);
        setDlqCount(res.pagination?.total ?? 0);
      } catch {}
    };
    fetchDlq();
    const t = setInterval(fetchDlq, 15000);
    return () => clearInterval(t);
  }, [token]);

  const login = (t: string, u: User) => {
    localStorage.setItem('relay_token', t);
    localStorage.setItem('relay_user', JSON.stringify(u));
    setToken(t); setUser(u);
  };

  const logout = () => {
    localStorage.removeItem('relay_token');
    localStorage.removeItem('relay_user');
    setToken(''); setUser(null);
  };

  if (!token || !user) return <LoginPage onLogin={login} />;

  const pageContent: Record<Page, JSX.Element> = {
    overview: <OverviewPage token={token} />,
    queues:   <QueuesPage token={token} />,
    jobs:     <JobsPage token={token} />,
    workers:  <WorkersPage token={token} />,
    dlq:      <DLQPage token={token} />,
  };

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar page={page} setPage={setPage} user={user} onLogout={logout} dlqCount={dlqCount} />
      <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg-base)' }}>
        {pageContent[page]}
      </main>
    </div>
  );
}
