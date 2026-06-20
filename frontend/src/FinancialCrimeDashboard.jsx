import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import {
  Users, ShieldAlert, DollarSign, Loader2, RefreshCw, X,
  AlertTriangle, ArrowUpRight, ArrowDownLeft, Radar, Activity,
  Search, Filter, Bell, TrendingUp, Eye, Zap, Lock, ChevronRight,
  List, ArrowUpDown, ArrowUp, ArrowDown,
} from 'lucide-react';

const API_BASE = 'http://localhost:5000';
const HIGH_RISK_THRESHOLD = 40;

const riskColor = (score) => {
  const s = Math.max(0, Math.min(100, score ?? 0));
  return s <= 50
    ? d3.interpolateRgb('#2dd36f', '#eab308')(s / 50)
    : d3.interpolateRgb('#eab308', '#ef4444')((s - 50) / 50);
};

const radiusScale = d3.scaleSqrt().domain([0, 100]).range([5, 26]);

const fmtCompact = (n) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

const fmtMoney = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

const fmtDate = (iso) => {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
};

function RiskBadge({ score }) {
  const color = score > 60 ? '#ef4444' : score > 40 ? '#eab308' : '#2dd36f';
  const label = score > 60 ? 'CRITICAL' : score > 40 ? 'SUSPECT' : 'CLEAN';
  return (
    <span style={{
      background: `${color}22`, color, border: `1px solid ${color}44`,
      borderRadius: 4, fontSize: 9, fontWeight: 700, padding: '2px 6px', letterSpacing: '0.15em'
    }}>{label}</span>
  );
}

function PulsingDot({ color = '#ef4444' }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 10, height: 10 }}>
      <span style={{
        position: 'absolute', inset: 0, borderRadius: '50%', background: color,
        animation: 'ping 1.4s cubic-bezier(0,0,0.2,1) infinite', opacity: 0.6
      }} />
      <span style={{ position: 'relative', width: 10, height: 10, borderRadius: '50%', background: color }} />
    </span>
  );
}

export default function FinancialCrimeDashboard() {
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState('all');
  const [alerts, setAlerts] = useState([]);
  const [showAlerts, setShowAlerts] = useState(false);
  const [alertCount, setAlertCount] = useState(0);
  const [activeTab, setActiveTab] = useState('graph');
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [ledgerSort, setLedgerSort] = useState({ key: 'timestamp', dir: 'desc' });
  const [ledgerRiskFilter, setLedgerRiskFilter] = useState('all');

  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const simRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const transformRef = useRef(d3.zoomIdentity);
  const sizeRef = useRef({ w: 0, h: 0 });
  const selectedIdRef = useRef(null);
  const hoveredIdRef = useRef(null);
  const rafRef = useRef(null);
  const angleRef = useRef(0);
  const alertTimerRef = useRef(null);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [accRes, txRes] = await Promise.all([
        fetch(`${API_BASE}/accounts`), fetch(`${API_BASE}/transactions`),
      ]);
      if (!accRes.ok || !txRes.ok) throw new Error('API error');
      const accs = await accRes.json();
      const txs = await txRes.json();
      setAccounts(accs); setTransactions(txs);
    } catch (e) {
      setError(e.message === 'Failed to fetch'
        ? `Cannot reach Flask API at ${API_BASE}. Run: python app.py`
        : e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Generate live alerts from high-risk accounts
  useEffect(() => {
    if (!accounts.length) return;
    const highRisk = accounts.filter(a => a.risk_score > HIGH_RISK_THRESHOLD);
    if (!highRisk.length) return;

    const generateAlert = () => {
      const acc = highRisk[Math.floor(Math.random() * highRisk.length)];
      const templates = [
        `Suspicious transfer detected from ${acc.name}`,
        `Velocity anomaly flagged: ${acc.name}`,
        `Pattern match: ${acc.name} linked to known ring`,
        `ML model flagged ${acc.name} (score: ${Math.round(acc.risk_score)})`,
        `New transaction cluster: ${acc.name}`,
      ];
      const msg = templates[Math.floor(Math.random() * templates.length)];
      const alert = { id: Date.now(), message: msg, account: acc, time: new Date().toLocaleTimeString() };
      setAlerts(prev => [alert, ...prev].slice(0, 20));
      setAlertCount(prev => prev + 1);
    };

    generateAlert();
    alertTimerRef.current = setInterval(generateAlert, 8000);
    return () => clearInterval(alertTimerRef.current);
  }, [accounts]);

  // Build & run simulation
  useEffect(() => {
    if (!accounts.length || !containerRef.current) return;
    const { width, height } = containerRef.current.getBoundingClientRect();
    sizeRef.current = { w: width, h: height };

    const visibleAccounts = filterMode === 'high'
      ? accounts.filter(a => a.risk_score > HIGH_RISK_THRESHOLD)
      : accounts;

    const visibleIds = new Set(visibleAccounts.map(a => a.id));

    const nodes = visibleAccounts.map((a) => ({
      ...a, r: radiusScale(a.risk_score ?? 0),
      x: width / 2 + (Math.random() - 0.5) * 200,
      y: height / 2 + (Math.random() - 0.5) * 200,
    }));

    const linkMap = new Map();
    for (const t of transactions) {
      if (!visibleIds.has(t.from) || !visibleIds.has(t.to)) continue;
      const key = `${t.from}->${t.to}`;
      if (!linkMap.has(key)) linkMap.set(key, { source: t.from, target: t.to, count: 0, amount: 0 });
      const l = linkMap.get(key); l.count += 1; l.amount += t.amount;
    }
    const links = Array.from(linkMap.values());

    nodesRef.current = nodes; linksRef.current = links;
    const maxR = Math.min(width, height) * 0.46;

    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id((d) => d.id).distance(40).strength(0.02))
      .force('charge', d3.forceManyBody().strength(-30).distanceMax(280))
      .force('collide', d3.forceCollide().radius((d) => d.r + 3).iterations(2))
      .force('radial', d3.forceRadial(
        (d) => maxR * (1 - (d.risk_score ?? 0) / 100), width / 2, height / 2
      ).strength(0.06))
      .force('center', d3.forceCenter(width / 2, height / 2).strength(0.02))
      .alphaDecay(0.02).velocityDecay(0.45);

    simRef.current = sim;
    return () => sim.stop();
  }, [accounts, transactions, filterMode]);

  // Canvas draw loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ctx = canvas.getContext('2d');

    function resize() {
      const { width, height } = container.getBoundingClientRect();
      sizeRef.current = { w: width, h: height };
      canvas.width = width * dpr; canvas.height = height * dpr;
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const zoom = d3.zoom().scaleExtent([0.1, 8])
      .on('zoom', (event) => { transformRef.current = event.transform; });
    d3.select(canvas).call(zoom).on('dblclick.zoom', null);

    function worldPoint(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      return { x: (clientX - rect.left - t.x) / t.k, y: (clientY - rect.top - t.y) / t.k };
    }

    function nodeAt(clientX, clientY) {
      const { x, y } = worldPoint(clientX, clientY);
      let found = null, bestDist = Infinity;
      for (const n of nodesRef.current) {
        const dist = Math.hypot(n.x - x, n.y - y);
        if (dist <= n.r + 4 && dist < bestDist) { bestDist = dist; found = n; }
      }
      return found;
    }

    function handleClick(e) { const n = nodeAt(e.clientX, e.clientY); setSelectedId(n ? n.id : null); }
    function handleMove(e) {
      const n = nodeAt(e.clientX, e.clientY);
      hoveredIdRef.current = n ? n.id : null;
      setHoveredNode(n || null);
      canvas.style.cursor = n ? 'pointer' : 'grab';
    }

    canvas.addEventListener('click', handleClick);
    canvas.addEventListener('mousemove', handleMove);

    function drawArrow(ctx, x1, y1, x2, y2, targetR, lw, alpha, color) {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const ex = x2 - Math.cos(angle) * (targetR + 2);
      const ey = y2 - Math.sin(angle) * (targetR + 2);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex, ey);
      ctx.strokeStyle = `rgba(${color},${alpha})`; ctx.lineWidth = lw; ctx.stroke();
      const hl = 5 + lw;
      ctx.beginPath(); ctx.moveTo(ex, ey);
      ctx.lineTo(ex - hl * Math.cos(angle - Math.PI / 7), ey - hl * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(ex - hl * Math.cos(angle + Math.PI / 7), ey - hl * Math.sin(angle + Math.PI / 7));
      ctx.closePath(); ctx.fillStyle = `rgba(${color},${Math.min(1, alpha + 0.15)})`; ctx.fill();
    }

    function frame() {
      const { w, h } = sizeRef.current;
      const t = transformRef.current;
      const nodes = nodesRef.current;
      const links = linksRef.current;
      const selId = selectedIdRef.current;
      const hovId = hoveredIdRef.current;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#060a12'; ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.translate(t.x, t.y); ctx.scale(t.k, t.k);

      // Dot grid
      ctx.fillStyle = 'rgba(148,163,184,0.05)';
      const gs = 44;
      const x0 = Math.floor((-t.x / t.k) / gs) * gs;
      const y0 = Math.floor((-t.y / t.k) / gs) * gs;
      for (let gx = x0; gx < x0 + w / t.k + gs; gx += gs)
        for (let gy = y0; gy < y0 + h / t.k + gs; gy += gs) {
          ctx.beginPath(); ctx.arc(gx, gy, 0.8, 0, Math.PI * 2); ctx.fill();
        }

      // Radar sweep
      if (ctx.createConicGradient && nodes.length) {
        angleRef.current += 0.003;
        const cx = w / 2, cy = h / 2;
        const maxR = Math.min(w, h) * 0.52;
        const grad = ctx.createConicGradient(angleRef.current, cx, cy);
        grad.addColorStop(0, 'rgba(240,180,41,0.08)');
        grad.addColorStop(0.05, 'rgba(240,180,41,0)');
        grad.addColorStop(1, 'rgba(240,180,41,0)');
        ctx.beginPath(); ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
        ctx.fillStyle = grad; ctx.fill();

        // Radar ring
        ctx.beginPath(); ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(240,180,41,0.06)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, maxR * 0.6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(240,180,41,0.04)'; ctx.lineWidth = 1; ctx.stroke();
      }

      // Edges
      const maxCount = Math.max(1, ...links.map((l) => l.count));
      for (const l of links) {
        const s = l.source, tg = l.target;
        if (!s || !tg || s.x == null || tg.x == null) continue;
        const touches = hovId && (s.id === hovId || tg.id === hovId);
        const selTouches = selId && (s.id === selId || tg.id === selId);
        const lw = 0.4 + Math.sqrt(l.count / maxCount) * 2;
        const isHighRisk = (s.risk_score > HIGH_RISK_THRESHOLD) && (tg.risk_score > HIGH_RISK_THRESHOLD);

        let color = '148,163,184';
        if (isHighRisk && selTouches) color = '239,68,68';
        else if (isHighRisk) color = '239,68,68';

        const alpha = selTouches ? 0.8 : touches ? 0.5 : isHighRisk ? 0.2 : 0.08;
        drawArrow(ctx, s.x, s.y, tg.x, tg.y, tg.r, lw, alpha, color);
      }

      // Nodes
      const now = Date.now();
      for (const n of nodes) {
        if (n.x == null) continue;
        const isHigh = (n.risk_score ?? 0) > HIGH_RISK_THRESHOLD;
        const isHov = n.id === hovId;
        const isSel = n.id === selId;
        const dim = (hovId || selId) && !isHov && !isSel;
        const col = riskColor(n.risk_score);

        if (isHigh) {
          const pulse = 0.5 + 0.5 * Math.sin(now / 500 + n.x * 0.1);
          ctx.shadowColor = col; ctx.shadowBlur = 8 + pulse * 14;
        } else { ctx.shadowBlur = 0; }

        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill();
        ctx.shadowBlur = 0;

        if (isSel) {
          ctx.lineWidth = 2.5 / t.k; ctx.strokeStyle = '#f0b429'; ctx.stroke();
          // Selection ring
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(240,180,41,0.3)'; ctx.lineWidth = 1 / t.k; ctx.stroke();
        } else if (isHov) {
          ctx.lineWidth = 2 / t.k; ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.stroke();
        }

        // Label for selected or high-risk hovered
        if (isSel || (isHov && isHigh)) {
          ctx.globalAlpha = 1;
          ctx.font = `${Math.max(10, 11 / t.k)}px 'IBM Plex Mono', monospace`;
          ctx.fillStyle = '#e6edf3';
          ctx.textAlign = 'center';
          const label = n.name.split(' ')[0];
          ctx.fillText(label, n.x, n.y - n.r - 4 / t.k);
        }
        ctx.globalAlpha = 1;
      }

      ctx.restore();
      rafRef.current = requestAnimationFrame(frame);
    }
    rafRef.current = requestAnimationFrame(frame);

    return () => {
      ro.disconnect();
      canvas.removeEventListener('click', handleClick);
      canvas.removeEventListener('mousemove', handleMove);
      cancelAnimationFrame(rafRef.current);
    };
  }, [accounts, transactions, filterMode]);

  // Derived
  const accountsById = useMemo(() => {
    const m = new Map(); accounts.forEach(a => m.set(a.id, a)); return m;
  }, [accounts]);

  const totalVolume = useMemo(() => transactions.reduce((s, t) => s + (t.amount || 0), 0), [transactions]);
  const highRiskCount = useMemo(() => accounts.filter(a => a.risk_score > HIGH_RISK_THRESHOLD).length, [accounts]);
  const avgRisk = useMemo(() => accounts.length ? accounts.reduce((s, a) => s + a.risk_score, 0) / accounts.length : 0, [accounts]);

  const selectedAccount = selectedId ? accountsById.get(selectedId) : null;

  const selectedTxns = useMemo(() => {
    if (!selectedId) return [];
    return transactions.filter(t => t.from === selectedId || t.to === selectedId)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 30);
  }, [selectedId, transactions]);

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return accounts.filter(a =>
      a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [searchQuery, accounts]);

  const topRiskAccounts = useMemo(() =>
    [...accounts].sort((a, b) => b.risk_score - a.risk_score).slice(0, 10),
    [accounts]);

  const ledgerTxns = useMemo(() => {
    const q = ledgerSearch.trim().toLowerCase();
    let rows = transactions.map(t => {
      const fromAcc = accountsById.get(t.from);
      const toAcc = accountsById.get(t.to);
      const maxRisk = Math.max(fromAcc?.risk_score ?? 0, toAcc?.risk_score ?? 0);
      return { ...t, fromAcc, toAcc, maxRisk };
    });

    if (ledgerRiskFilter === 'high') rows = rows.filter(t => t.maxRisk > HIGH_RISK_THRESHOLD);

    if (q) {
      rows = rows.filter(t =>
        t.id.toLowerCase().includes(q) ||
        t.from.toLowerCase().includes(q) ||
        t.to.toLowerCase().includes(q) ||
        (t.fromAcc?.name || '').toLowerCase().includes(q) ||
        (t.toAcc?.name || '').toLowerCase().includes(q)
      );
    }

    const { key, dir } = ledgerSort;
    const mult = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (key === 'timestamp') return mult * (new Date(a.timestamp) - new Date(b.timestamp));
      if (key === 'amount') return mult * (a.amount - b.amount);
      if (key === 'risk') return mult * (a.maxRisk - b.maxRisk);
      return 0;
    });
    return rows;
  }, [transactions, accountsById, ledgerSearch, ledgerRiskFilter, ledgerSort]);

  const toggleLedgerSort = (key) => {
    setLedgerSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'desc' });
  };

  return (
    <div style={{
      height: '100vh', width: '100%', display: 'flex', flexDirection: 'column',
      background: '#060a12', color: '#e6edf3',
      fontFamily: "'IBM Plex Mono', monospace", overflow: 'hidden'
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .font-display { font-family: 'Archivo', sans-serif; }
        @keyframes ping { 75%,100% { transform: scale(2); opacity: 0; } }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes scanline { 0%,100% { opacity: 0.03; } 50% { opacity: 0.07; } }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1f2937; border-radius: 4px; }
        .alert-item { animation: slideIn 0.3s ease; }
        .tab-btn { background: none; border: none; cursor: pointer; padding: 6px 14px; font-family: inherit; font-size: 11px; letter-spacing: 0.1em; transition: all 0.15s; }
        .node-row:hover { background: rgba(255,255,255,0.04); }
        .search-result:hover { background: rgba(240,180,41,0.08); }
      `}</style>

      {/* HEADER */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 20px', borderBottom: '1px solid #1c2330',
        background: '#0c1119', flexShrink: 0, gap: 12
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Radar size={24} style={{ color: '#f0b429' }} />
          <div>
            <div style={{ fontSize: 9, letterSpacing: '0.25em', color: '#f0b429', textTransform: 'uppercase' }}>
              Financial Crime Investigation
            </div>
            <div className="font-display" style={{ fontSize: 18, lineHeight: 1.2, fontWeight: 800 }}>
              Transaction Network
            </div>
          </div>
          <div style={{ width: 1, height: 36, background: '#1c2330', margin: '0 4px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <PulsingDot color="#2dd36f" />
            <span style={{ fontSize: 10, color: '#64748b', letterSpacing: '0.1em' }}>LIVE</span>
          </div>
        </div>

        {/* Search */}
        <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search accounts..."
            style={{
              width: '100%', background: '#0f1520', border: '1px solid #1c2330',
              borderRadius: 6, padding: '7px 10px 7px 30px', color: '#e6edf3',
              fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box'
            }}
          />
          {searchResults.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
              background: '#0c1119', border: '1px solid #1c2330', borderRadius: 6,
              zIndex: 100, animation: 'fadeIn 0.15s ease'
            }}>
              {searchResults.map(a => (
                <div key={a.id} className="search-result" onClick={() => { setSelectedId(a.id); setSearchQuery(''); }}
                  style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#e6edf3' }}>{a.name}</div>
                    <div style={{ fontSize: 10, color: '#475569' }}>{a.id}</div>
                  </div>
                  <RiskBadge score={a.risk_score} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Stats */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <StatCard icon={<Users size={13} />} label="Accounts" value={accounts.length} />
          <StatCard icon={<ShieldAlert size={13} />} label="High Risk" value={highRiskCount} accent="#ef4444" />
          <StatCard icon={<DollarSign size={13} />} label="Volume" value={`$${fmtCompact(totalVolume)}`} accent="#2dd36f" />
          <StatCard icon={<TrendingUp size={13} />} label="Avg Risk" value={`${Math.round(avgRisk)}`} accent="#eab308" />

          {/* Alert bell */}
          <button onClick={() => { setShowAlerts(!showAlerts); setAlertCount(0); }}
            style={{ position: 'relative', background: showAlerts ? '#1c2330' : 'none', border: '1px solid #1c2330', borderRadius: 6, padding: '6px 8px', cursor: 'pointer', color: '#94a3b8' }}>
            <Bell size={15} style={{ color: alertCount > 0 ? '#f0b429' : '#64748b' }} />
            {alertCount > 0 && (
              <span style={{
                position: 'absolute', top: -4, right: -4, background: '#ef4444', color: '#fff',
                borderRadius: '50%', width: 16, height: 16, fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700
              }}>{alertCount > 9 ? '9+' : alertCount}</span>
            )}
          </button>

          {/* Filter toggle */}
          <button onClick={() => setFilterMode(filterMode === 'all' ? 'high' : 'all')}
            style={{
              background: filterMode === 'high' ? 'rgba(239,68,68,0.15)' : 'none',
              border: `1px solid ${filterMode === 'high' ? '#ef444466' : '#1c2330'}`,
              borderRadius: 6, padding: '6px 10px', cursor: 'pointer',
              color: filterMode === 'high' ? '#ef4444' : '#64748b', fontSize: 10,
              fontFamily: 'inherit', letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: 5
            }}>
            <Filter size={12} />
            {filterMode === 'high' ? 'HIGH RISK' : 'ALL'}
          </button>

          <button onClick={load} style={{ background: 'none', border: '1px solid #1c2330', borderRadius: 6, padding: '6px 8px', cursor: 'pointer' }}>
            <RefreshCw size={13} style={{ color: '#64748b' }} />
          </button>
        </div>
      </header>

      {/* ALERT PANEL */}
      {showAlerts && (
        <div style={{
          position: 'absolute', top: 62, right: 16, width: 340, maxHeight: 420,
          background: '#0c1119', border: '1px solid #1c2330', borderRadius: 8,
          zIndex: 200, overflow: 'hidden', animation: 'fadeIn 0.2s ease', boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
        }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid #1c2330', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Bell size={13} style={{ color: '#f0b429' }} />
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#f0b429' }}>Live Alerts</span>
            </div>
            <button onClick={() => setShowAlerts(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569' }}><X size={13} /></button>
          </div>
          <div style={{ overflowY: 'auto', maxHeight: 360 }}>
            {alerts.length === 0 && (
              <div style={{ padding: '20px 14px', fontSize: 12, color: '#475569', textAlign: 'center' }}>Monitoring for suspicious activity...</div>
            )}
            {alerts.map(alert => (
              <div key={alert.id} className="alert-item" onClick={() => { setSelectedId(alert.account.id); setShowAlerts(false); }}
                style={{ padding: '10px 14px', borderBottom: '1px solid #1c2330', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <AlertTriangle size={13} style={{ color: '#ef4444', marginTop: 1, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: '#e6edf3', lineHeight: 1.4 }}>{alert.message}</div>
                  <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>{alert.time}</div>
                </div>
                <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 700 }}>{Math.round(alert.account.risk_score)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TABS + MAIN */}
      <div style={{ display: 'flex', borderBottom: '1px solid #1c2330', background: '#0c1119', flexShrink: 0 }}>
        {['graph', 'leaderboard', 'ledger'].map(tab => (
          <button key={tab} className="tab-btn" onClick={() => setActiveTab(tab)}
            style={{
              color: activeTab === tab ? '#f0b429' : '#475569',
              borderBottom: activeTab === tab ? '2px solid #f0b429' : '2px solid transparent',
              textTransform: 'uppercase', letterSpacing: '0.12em'
            }}>
            {tab === 'graph' ? '⬡ Network Graph' : tab === 'leaderboard' ? '⚠ Risk Leaderboard' : '☰ Transaction Ledger'}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>

        {/* GRAPH VIEW */}
        {activeTab === 'graph' && (
          <div ref={containerRef} style={{ flex: 1, position: 'relative' }}>
            <canvas ref={canvasRef} style={{ display: 'block' }} />

            {/* Legend */}
            {!loading && !error && (
              <div style={{
                position: 'absolute', bottom: 20, left: 20, padding: '10px 14px',
                background: 'rgba(6,10,18,0.9)', border: '1px solid #1c2330',
                borderRadius: 8, backdropFilter: 'blur(8px)'
              }}>
                <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.2em', color: '#475569', marginBottom: 8 }}>Risk Score</div>
                <div style={{ height: 6, width: 160, borderRadius: 3, background: 'linear-gradient(90deg, #2dd36f, #eab308, #ef4444)', marginBottom: 4 }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#475569' }}>
                  <span>0 · low</span><span>50</span><span>100 · high</span>
                </div>
                <div style={{ fontSize: 9, color: '#334155', marginTop: 6 }}>size = risk · center = highest concern</div>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: '#475569' }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#ef4444', boxShadow: '0 0 6px #ef4444' }} />
                    Pulsing = critical risk
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: '#475569' }}>
                    <span style={{ display: 'inline-block', width: 20, height: 2, background: '#ef444455' }} />
                    Red edge = fraud link
                  </div>
                </div>
              </div>
            )}

            {/* Hover tooltip */}
            {hoveredNode && !loading && (
              <div style={{
                position: 'absolute', top: 16, left: 16, padding: '8px 12px',
                background: 'rgba(6,10,18,0.95)', border: '1px solid #1c2330',
                borderRadius: 6, pointerEvents: 'none', maxWidth: 220, animation: 'fadeIn 0.1s ease'
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3', marginBottom: 4 }}>{hoveredNode.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: riskColor(hoveredNode.risk_score), display: 'inline-block' }} />
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>Risk {Math.round(hoveredNode.risk_score)}</span>
                  <RiskBadge score={hoveredNode.risk_score} />
                </div>
                {hoveredNode.reasons?.length > 0 && (
                  <div style={{ marginTop: 6, fontSize: 10, color: '#64748b', borderTop: '1px solid #1c2330', paddingTop: 5 }}>
                    {hoveredNode.reasons[0]}
                  </div>
                )}
                <div style={{ marginTop: 4, fontSize: 9, color: '#334155' }}>Click to investigate →</div>
              </div>
            )}

            {/* Loading/Error */}
            {(loading || error) && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ textAlign: 'center', maxWidth: 360, padding: '0 24px' }}>
                  {loading && !error && (
                    <>
                      <Loader2 size={28} style={{ color: '#f0b429', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
                      <div style={{ fontSize: 13, color: '#94a3b8' }}>Initialising investigation system...</div>
                    </>
                  )}
                  {error && (
                    <>
                      <AlertTriangle size={28} style={{ color: '#ef4444', margin: '0 auto 12px' }} />
                      <div style={{ fontSize: 14, marginBottom: 6, color: '#e6edf3' }}>Connection failed</div>
                      <div style={{ fontSize: 11, color: '#475569', marginBottom: 16 }}>{error}</div>
                      <button onClick={load} style={{
                        padding: '8px 16px', fontSize: 11, fontFamily: 'inherit', borderRadius: 6,
                        border: '1px solid #f0b429', background: 'none', color: '#f0b429', cursor: 'pointer', letterSpacing: '0.1em'
                      }}>RETRY CONNECTION</button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* LEADERBOARD VIEW */}
        {activeTab === 'leaderboard' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
            <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShieldAlert size={16} style={{ color: '#ef4444' }} />
              <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#94a3b8' }}>
                Top Risk Accounts
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {topRiskAccounts.map((acc, i) => (
                <div key={acc.id} className="node-row" onClick={() => { setSelectedId(acc.id); setActiveTab('graph'); }}
                  style={{
                    padding: '12px 14px', background: '#0c1119', border: '1px solid #1c2330',
                    borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
                    borderLeft: `3px solid ${riskColor(acc.risk_score)}`
                  }}>
                  <div style={{ fontSize: 11, color: '#334155', fontWeight: 700, minWidth: 20 }}>#{i + 1}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: '#e6edf3', marginBottom: 2 }}>{acc.name}</div>
                    <div style={{ fontSize: 9, color: '#475569' }}>{acc.id}</div>
                    {acc.reasons?.[0] && (
                      <div style={{ fontSize: 10, color: '#64748b', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <AlertTriangle size={9} style={{ color: '#f0b429' }} />
                        {acc.reasons[0]}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: riskColor(acc.risk_score), lineHeight: 1 }}>
                      {Math.round(acc.risk_score)}
                    </div>
                    <div style={{ marginTop: 4 }}><RiskBadge score={acc.risk_score} /></div>
                  </div>
                  {/* Mini bar */}
                  <div style={{ width: 60, height: 4, background: '#1c2330', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${acc.risk_score}%`, height: '100%', background: riskColor(acc.risk_score), borderRadius: 2 }} />
                  </div>
                  <ChevronRight size={13} style={{ color: '#334155' }} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* LEDGER VIEW */}
        {activeTab === 'ledger' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column' }}>
            {/* Controls */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 360 }}>
                <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
                <input
                  value={ledgerSearch}
                  onChange={e => setLedgerSearch(e.target.value)}
                  placeholder="Search by account, name, or txn ID..."
                  style={{
                    width: '100%', background: '#0c1119', border: '1px solid #1c2330',
                    borderRadius: 6, padding: '8px 10px 8px 30px', color: '#e6edf3',
                    fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box'
                  }}
                />
              </div>

              <button onClick={() => setLedgerRiskFilter(ledgerRiskFilter === 'all' ? 'high' : 'all')}
                style={{
                  background: ledgerRiskFilter === 'high' ? 'rgba(239,68,68,0.15)' : 'none',
                  border: `1px solid ${ledgerRiskFilter === 'high' ? '#ef444466' : '#1c2330'}`,
                  borderRadius: 6, padding: '7px 12px', cursor: 'pointer',
                  color: ledgerRiskFilter === 'high' ? '#ef4444' : '#64748b', fontSize: 10,
                  fontFamily: 'inherit', letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: 5
                }}>
                <Filter size={12} />
                {ledgerRiskFilter === 'high' ? 'FLAGGED PARTIES ONLY' : 'ALL TRANSACTIONS'}
              </button>

              <div style={{ fontSize: 10, color: '#475569', letterSpacing: '0.1em', marginLeft: 'auto' }}>
                {ledgerTxns.length} of {transactions.length} TRANSACTIONS
              </div>
            </div>

            {/* Table header */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr 0.7fr 0.9fr 1fr',
              gap: 8, padding: '8px 12px', fontSize: 9, letterSpacing: '0.15em',
              textTransform: 'uppercase', color: '#475569', borderBottom: '1px solid #1c2330'
            }}>
              <div>Transaction</div>
              <div>From</div>
              <div>To</div>
              <SortableHeader label="Amount" active={ledgerSort.key === 'amount'} dir={ledgerSort.dir} onClick={() => toggleLedgerSort('amount')} />
              <SortableHeader label="Risk" active={ledgerSort.key === 'risk'} dir={ledgerSort.dir} onClick={() => toggleLedgerSort('risk')} />
              <SortableHeader label="Timestamp" active={ledgerSort.key === 'timestamp'} dir={ledgerSort.dir} onClick={() => toggleLedgerSort('timestamp')} />
            </div>

            {/* Rows */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {ledgerTxns.length === 0 && (
                <div style={{ padding: '40px 0', textAlign: 'center', fontSize: 12, color: '#334155' }}>
                  No transactions match your filters.
                </div>
              )}
              {ledgerTxns.slice(0, 300).map(t => (
                <div key={t.id}
                  style={{
                    display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr 0.7fr 0.9fr 1fr',
                    gap: 8, padding: '10px 12px', fontSize: 11.5, alignItems: 'center',
                    borderBottom: '1px solid #11161f'
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.025)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                  <div style={{ color: '#64748b', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.id}</div>
                  <div onClick={() => setSelectedId(t.from)} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <ArrowUpRight size={11} style={{ color: '#ef4444', flexShrink: 0 }} />
                    <span style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.fromAcc ? t.fromAcc.name : t.from}
                    </span>
                  </div>
                  <div onClick={() => setSelectedId(t.to)} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <ArrowDownLeft size={11} style={{ color: '#2dd36f', flexShrink: 0 }} />
                    <span style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.toAcc ? t.toAcc.name : t.to}
                    </span>
                  </div>
                  <div style={{ color: '#e6edf3', fontWeight: 600 }}>{fmtMoney(t.amount)}</div>
                  <div>
                    {t.maxRisk > 0 ? <RiskBadge score={t.maxRisk} /> : <span style={{ color: '#334155', fontSize: 10 }}>—</span>}
                  </div>
                  <div style={{ color: '#475569', fontSize: 10.5 }}>{fmtDate(t.timestamp)}</div>
                </div>
              ))}
              {ledgerTxns.length > 300 && (
                <div style={{ padding: '14px 0', textAlign: 'center', fontSize: 10, color: '#334155', letterSpacing: '0.1em' }}>
                  SHOWING FIRST 300 OF {ledgerTxns.length} — REFINE SEARCH TO NARROW
                </div>
              )}
            </div>
          </div>
        )}

        {/* SIDE PANEL */}
        {selectedAccount && (
          <div style={{
            width: 380, maxWidth: '90vw', borderLeft: '1px solid #1c2330',
            background: '#0c1119', overflowY: 'auto', flexShrink: 0, animation: 'slideIn 0.2s ease'
          }}>
            {/* Panel header */}
            <div style={{ padding: '14px 18px', borderBottom: '1px solid #1c2330', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.2em', color: '#475569' }}>{selectedAccount.id}</div>
                <div className="font-display" style={{ fontSize: 17, marginTop: 2, fontWeight: 700 }}>{selectedAccount.name}</div>
                <div style={{ marginTop: 6 }}><RiskBadge score={selectedAccount.risk_score} /></div>
              </div>
              <button onClick={() => setSelectedId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
                <X size={15} style={{ color: '#475569' }} />
              </button>
            </div>

            {/* Risk score visual */}
            <div style={{ padding: '14px 18px', borderBottom: '1px solid #1c2330' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.2em', color: '#475569' }}>Risk Score</span>
                <span className="font-display" style={{ fontSize: 32, color: riskColor(selectedAccount.risk_score), fontWeight: 900, lineHeight: 1 }}>
                  {Math.round(selectedAccount.risk_score)}
                </span>
              </div>
              <div style={{ height: 6, background: '#1c2330', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${selectedAccount.risk_score}%`, height: '100%', background: riskColor(selectedAccount.risk_score), borderRadius: 3, transition: 'width 0.6s ease' }} />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <div style={{ flex: 1, background: '#0f1520', borderRadius: 6, padding: '8px 10px', border: '1px solid #1c2330' }}>
                  <div style={{ fontSize: 9, color: '#475569', marginBottom: 2 }}>TRANSACTIONS</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3' }}>{selectedTxns.length}</div>
                </div>
                <div style={{ flex: 1, background: '#0f1520', borderRadius: 6, padding: '8px 10px', border: '1px solid #1c2330' }}>
                  <div style={{ fontSize: 9, color: '#475569', marginBottom: 2 }}>TOTAL VOL.</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>
                    {fmtCompact(selectedTxns.reduce((s, t) => s + t.amount, 0))}
                  </div>
                </div>
              </div>
            </div>

            {/* Flags */}
            <div style={{ padding: '14px 18px', borderBottom: '1px solid #1c2330' }}>
              <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.2em', color: '#475569', marginBottom: 10 }}>Detection Flags</div>
              {selectedAccount.reasons?.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {selectedAccount.reasons.map((r, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 6, padding: '8px 10px' }}>
                      <Zap size={12} style={{ color: '#f0b429', flexShrink: 0, marginTop: 1 }} />
                      <span style={{ fontSize: 11, color: '#cbd5e1', lineHeight: 1.4 }}>{r}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 11, color: '#334155', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Eye size={12} style={{ color: '#475569' }} /> No specific flags — ML anomaly detected
                </div>
              )}
            </div>

            {/* Transactions */}
            <div style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.2em', color: '#475569', marginBottom: 10 }}>
                Recent Transactions ({selectedTxns.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {selectedTxns.map(t => {
                  const outgoing = t.from === selectedAccount.id;
                  const cpId = outgoing ? t.to : t.from;
                  const cp = accountsById.get(cpId);
                  return (
                    <div key={t.id} onClick={() => setSelectedId(cpId)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderRadius: 6, cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                      <div style={{
                        width: 26, height: 26, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: outgoing ? 'rgba(239,68,68,0.12)' : 'rgba(45,211,111,0.12)'
                      }}>
                        {outgoing ? <ArrowUpRight size={13} style={{ color: '#ef4444' }} /> : <ArrowDownLeft size={13} style={{ color: '#2dd36f' }} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: '#e6edf3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cp ? cp.name : cpId}
                        </div>
                        <div style={{ fontSize: 10, color: '#475569' }}>{fmtDate(t.timestamp)}</div>
                      </div>
                      {cp && <RiskBadge score={cp.risk_score} />}
                      <div style={{ fontSize: 12, fontWeight: 600, color: outgoing ? '#ef4444' : '#2dd36f', flexShrink: 0 }}>
                        {outgoing ? '-' : '+'}{fmtMoney(t.amount)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SortableHeader({ label, active, dir, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', color: active ? '#f0b429' : '#475569' }}>
      {label}
      {active
        ? (dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)
        : <ArrowUpDown size={10} style={{ opacity: 0.4 }} />}
    </div>
  );
}

function StatCard({ icon, label, value, accent = '#94a3b8' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid #1c2330', background: '#0f1520' }}>
      <div style={{ color: accent }}>{icon}</div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.15em', color: '#475569', marginTop: 2 }}>{label}</div>
      </div>
    </div>
  );
}
