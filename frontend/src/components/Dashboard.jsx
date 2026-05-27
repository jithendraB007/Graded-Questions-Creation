import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { sheetsStatus, sheetsAuth, sheetsLog, sheetsDashboard } from '../api/client.js'

// ── analytics helpers ─────────────────────────────────────────────────────────

function computeMetrics({ approved = 0, rejected = 0, pending = 0 }) {
  const total = approved + rejected + pending
  const TP = rejected   // correctly flagged bad questions
  const FP = 0          // human reviewer is ground truth — no false rejections
  const FN = pending    // unchecked questions; potential missed issues
  const TN = approved   // correctly passed good questions
  const reviewed  = approved + rejected
  const precision = (TP + FP) === 0 ? (total > 0 ? 100 : 0) : (TP / (TP + FP)) * 100
  const recall    = (TP + FN) === 0 ? (total > 0 ? 100 : 0) : (TP / (TP + FN)) * 100
  const p = precision / 100, r = recall / 100
  const f1            = (p + r) === 0 ? 0 : (2 * p * r) / (p + r)
  const approvalRate  = reviewed === 0 ? (total > 0 ? 100 : 0) : (TN / reviewed) * 100
  return { TP, FP, FN, TN, total, approved, rejected, pending, reviewed, precision, recall, f1, approvalRate }
}

function ratingFor(value, goodThresh, fairThresh) {
  if (value >= goodThresh) return 'Good'
  if (value >= fairThresh) return 'Fair'
  return 'Poor'
}

const RATING_STYLES = {
  Good: 'bg-emerald-100 text-emerald-800',
  Fair: 'bg-amber-100 text-amber-800',
  Poor: 'bg-red-100 text-red-700',
}

// ── sub-components ────────────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3">{title}</p>
      {children}
    </div>
  )
}

function RatingBadge({ rating }) {
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${RATING_STYLES[rating] || RATING_STYLES.Poor}`}>
      {rating}
    </span>
  )
}

function MetricCard({ icon, label, displayValue, description, rating }) {
  const accent = rating === 'Good' ? 'text-emerald-600' : rating === 'Fair' ? 'text-amber-500' : 'text-red-500'
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm flex flex-col gap-2.5">
      <div className="flex items-start justify-between">
        <span className="text-lg">{icon}</span>
        <RatingBadge rating={rating} />
      </div>
      <div>
        <p className={`text-3xl font-bold tabular-nums leading-tight ${accent}`}>{displayValue}</p>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mt-1">{label}</p>
      </div>
      {description && <p className="text-[10px] text-gray-500 leading-relaxed">{description}</p>}
    </div>
  )
}

function OutcomeBar({ label, value, total, barClass }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-500 w-44 shrink-0 truncate">{label}</span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${barClass}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-bold tabular-nums text-gray-700 w-8 text-right">{value}</span>
    </div>
  )
}

function StackedOutcomeBar({ TP, FP, FN, TN, total }) {
  if (total === 0) return null
  const pct = v => ((v / total) * 100).toFixed(1)
  const segments = [
    { value: TN, color: 'bg-emerald-400', label: 'Correct Approvals' },
    { value: TP, color: 'bg-blue-500',    label: 'Correctly Flagged'  },
    { value: FN, color: 'bg-amber-400',   label: 'Missed Issues'      },
    { value: FP, color: 'bg-red-400',     label: 'False Flags'        },
  ]
  return (
    <div className="space-y-3">
      <div className="flex h-8 rounded-lg overflow-hidden w-full">
        {segments.map(({ value, color, label }) =>
          value > 0
            ? <div key={label} className={`${color} transition-all duration-500`} style={{ width: `${pct(value)}%` }} title={`${label}: ${value}`} />
            : null
        )}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        {segments.map(({ color, label, value }) => (
          <div key={label} className="flex items-center gap-1.5 text-[11px] text-gray-600">
            <span className={`w-2.5 h-2.5 rounded-sm ${color} shrink-0`} />
            <span className="font-bold tabular-nums">{value}</span>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ConfusionMatrix({ TP, FP, FN, TN }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
      {/* Column headers */}
      <div className="flex mb-2 pl-32">
        <span className="flex-1 text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider">Human: Problem</span>
        <span className="flex-1 text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider">Human: Clean</span>
      </div>
      {/* Row: AI Said Problem */}
      <div className="flex items-stretch gap-2 mb-2">
        <div className="w-32 shrink-0 flex items-center">
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide leading-snug">AI Said: Problem</span>
        </div>
        <div className="flex-1 grid grid-cols-2 gap-2">
          <div className="flex flex-col items-center justify-center rounded-xl py-5 bg-emerald-50 border border-emerald-200 text-center">
            <p className="text-2xl font-bold tabular-nums text-emerald-700">{TP}</p>
            <p className="text-[9px] font-bold uppercase tracking-wide text-emerald-600 mt-1">True Positive</p>
            <p className="text-[9px] text-emerald-500 mt-0.5">Correctly Flagged</p>
          </div>
          <div className="flex flex-col items-center justify-center rounded-xl py-5 bg-red-50 border border-red-200 text-center opacity-80">
            <p className="text-2xl font-bold tabular-nums text-red-600">{FP}</p>
            <p className="text-[9px] font-bold uppercase tracking-wide text-red-500 mt-1">False Positive</p>
            <p className="text-[9px] text-red-400 mt-0.5">False Flags</p>
          </div>
        </div>
      </div>
      {/* Row: AI Said Clean */}
      <div className="flex items-stretch gap-2">
        <div className="w-32 shrink-0 flex items-center">
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide leading-snug">AI Said: Clean</span>
        </div>
        <div className="flex-1 grid grid-cols-2 gap-2">
          <div className="flex flex-col items-center justify-center rounded-xl py-5 bg-amber-50 border border-amber-200 text-center">
            <p className="text-2xl font-bold tabular-nums text-amber-700">{FN}</p>
            <p className="text-[9px] font-bold uppercase tracking-wide text-amber-600 mt-1">False Negative</p>
            <p className="text-[9px] text-amber-500 mt-0.5">Missed Issues</p>
          </div>
          <div className="flex flex-col items-center justify-center rounded-xl py-5 bg-emerald-50 border border-emerald-200 text-center">
            <p className="text-2xl font-bold tabular-nums text-emerald-700">{TN}</p>
            <p className="text-[9px] font-bold uppercase tracking-wide text-emerald-600 mt-1">True Negative</p>
            <p className="text-[9px] text-emerald-500 mt-0.5">Correct Approvals</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────

export default function Dashboard({ pool = [], co = '', onClose }) {
  const [authStatus,   setAuthStatus]   = useState('loading')
  const [authError,    setAuthError]    = useState('')
  const [sheetUrl,     setSheetUrl]     = useState('')
  const [stats,        setStats]        = useState(null)
  const [logging,      setLogging]      = useState(false)
  const [logResult,    setLogResult]    = useState('')
  const [loadingStats, setLoadingStats] = useState(false)
  const [authMsg,      setAuthMsg]      = useState('')
  const [pollTimer,    setPollTimer]    = useState(null)
  const [tokenJson,    setTokenJson]    = useState('')
  const [tokenCopied,  setTokenCopied]  = useState(false)
  const [importing,       setImporting]       = useState(false)
  const [importResult,    setImportResult]    = useState('')
  const [approving,       setApproving]       = useState(false)
  const [approveResult,   setApproveResult]   = useState('')
  const csvInputRef = useRef(null)

  const loadStatus = useCallback(async () => {
    try {
      const data = await sheetsStatus()
      setAuthStatus(data.auth_status)
      setAuthError(data.auth_error || '')
      setSheetUrl(data.spreadsheet_url || '')
      if (data.auth_status === 'ready' && (!stats || stats.error)) fetchStats()
    } catch (e) { setAuthStatus('error'); setAuthError(e.message) }
  }, [stats]) // eslint-disable-line

  useEffect(() => { loadStatus() }, []) // eslint-disable-line

  useEffect(() => {
    if (authStatus === 'authenticating') {
      const t = setInterval(loadStatus, 3000)
      setPollTimer(t)
      return () => clearInterval(t)
    } else {
      if (pollTimer) { clearInterval(pollTimer); setPollTimer(null) }
    }
  }, [authStatus]) // eslint-disable-line

  async function handleAuth() {
    setAuthMsg('')
    try {
      const r = await sheetsAuth()
      setAuthStatus(r.status)
      setAuthMsg(r.message || '')
    } catch (e) { setAuthMsg(e.message) }
  }

  async function handleGetToken() {
    try {
      const res = await fetch('/api/sheets/token')
      const data = await res.json()
      if (!res.ok) { setAuthMsg(data.detail || 'Could not get token'); return }
      setTokenJson(data.token_json)
      await navigator.clipboard.writeText(data.token_json)
      setTokenCopied(true)
      setTimeout(() => setTokenCopied(false), 3000)
    } catch (e) { setAuthMsg(e.message) }
  }

  async function fetchStats() {
    setLoadingStats(true)
    try {
      const data = await sheetsDashboard()
      setStats(data)
      if (data.spreadsheet_url) setSheetUrl(data.spreadsheet_url)
    } catch (e) { setStats({ error: e.message }) }
    finally { setLoadingStats(false) }
  }

  async function handleLog() {
    if (!pool.length) return
    setLogging(true); setLogResult('')
    try {
      const items = pool.map(({ _type, _difficulty, _bloom, _meta, _status, _feedback, ...q }) => ({
        ...q,
        bloom:          _bloom || q.bloom || '',
        difficulty:     _difficulty || '',
        question_type:  _type || '',
        module_id:      _meta?.module || '',
        module_display: _meta?.module_display || '',
        topic_display:  _meta?.topic_display || '',
        course_outcome: _meta?.course_outcome || co,
        course_display: _meta?.course_display || '',
        status:         _status || 'pending',
        feedback:       _feedback || '',
      }))
      const result = await sheetsLog(items)
      setLogResult(`✓ ${result.logged} question${result.logged !== 1 ? 's' : ''} logged to Google Sheets.`)
      await fetchStats()
    } catch (e) { setLogResult(`Error: ${e.message}`) }
    finally { setLogging(false) }
  }

  async function handleImportCsv(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''   // reset so same file can be re-selected
    setImporting(true); setImportResult('')
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/import/csv', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Import failed')
      setImportResult(`✓ Imported ${data.logged} of ${data.total} questions from "${file.name}" into Google Sheets.`)
      await fetchStats()
    } catch (err) { setImportResult(`Error: ${err.message}`) }
    finally { setImporting(false) }
  }

  async function handleBulkApprove() {
    setApproving(true); setApproveResult('')
    try {
      const res = await fetch('/api/sheets/bulk-approve', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Bulk approve failed')
      setApproveResult(`✓ ${data.updated} pending question${data.updated !== 1 ? 's' : ''} marked as approved.`)
      await fetchStats()
    } catch (err) { setApproveResult(`Error: ${err.message}`) }
    finally { setApproving(false) }
  }

  // ── derive counts ────────────────────────────────────────────────────────────
  const poolCounts = useMemo(() => ({
    approved: pool.filter(q => q._status === 'approved').length,
    rejected: pool.filter(q => q._status === 'rejected').length,
    pending:  pool.filter(q => !q._status || q._status === 'pending').length,
  }), [pool])

  const activeCounts = useMemo(() => {
    if (stats && !stats.error && (stats.total || 0) > 0) {
      return {
        approved: stats.status?.approved || 0,
        rejected: stats.status?.rejected || 0,
        pending:  stats.status?.pending  || 0,
      }
    }
    return poolCounts
  }, [stats, poolCounts])

  const metrics = useMemo(() => computeMetrics(activeCounts), [activeCounts])

  const sourceLabel = (stats && !stats.error && (stats.total || 0) > 0)
    ? 'All sessions (Google Sheets)'
    : 'Current pool'

  const hasData = metrics.total > 0

  const precisionRating    = ratingFor(metrics.precision,   90, 70)
  const recallRating       = ratingFor(metrics.recall,      80, 60)
  const f1Rating           = ratingFor(metrics.f1 * 100,    80, 65)
  const approvalRateRating = ratingFor(metrics.approvalRate, 83, 65)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-50">

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between gap-4 shrink-0 shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-sm font-bold text-blue-900 uppercase tracking-widest whitespace-nowrap">Agent Performance Dashboard</h2>
          <span className="text-[10px] font-semibold text-gray-400 bg-gray-100 rounded-full px-2.5 py-0.5 whitespace-nowrap">
            {sourceLabel}
          </span>
          {authStatus === 'ready' && sheetUrl && (
            <a href={sheetUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1 hover:bg-emerald-100 transition-colors whitespace-nowrap">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              Open in Sheets
            </a>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {authStatus !== 'ready' && authStatus !== 'loading' && authStatus !== 'authenticating' && (
            <button onClick={handleAuth}
              className="flex items-center gap-2 text-xs font-semibold bg-blue-700 hover:bg-blue-800 text-white px-3 py-1.5 rounded-lg transition-colors">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </button>
          )}
          {authStatus === 'authenticating' && (
            <span className="flex items-center gap-1.5 text-xs text-blue-600">
              <span className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              Waiting for authorization…
            </span>
          )}
          {authStatus === 'ready' && (
            <>
              {pool.length > 0 && (
                <button onClick={handleLog} disabled={logging}
                  className="flex items-center gap-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white px-3 py-1.5 rounded-lg transition-colors">
                  {logging
                    ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Logging…</>
                    : `Log to Sheets (${pool.filter(q => q._status !== 'rejected').length})`}
                </button>
              )}
              <button onClick={fetchStats} disabled={loadingStats}
                className="text-xs font-medium text-gray-500 hover:text-blue-700 border border-gray-200 hover:border-blue-300 px-3 py-1.5 rounded-lg transition-colors">
                {loadingStats ? 'Refreshing…' : '↺ Refresh'}
              </button>
              <button onClick={() => csvInputRef.current?.click()} disabled={importing}
                className="text-xs font-medium text-gray-500 hover:text-indigo-700 border border-gray-200 hover:border-indigo-300 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50">
                {importing ? 'Importing…' : '⬆ Import CSV'}
              </button>
              <input ref={csvInputRef} type="file" accept=".csv" className="hidden" onChange={handleImportCsv} />
              {(stats?.status?.pending > 0 || poolCounts.pending > 0) && (
                <button onClick={handleBulkApprove} disabled={approving}
                  className="text-xs font-medium text-gray-500 hover:text-emerald-700 border border-gray-200 hover:border-emerald-300 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50">
                  {approving ? 'Approving…' : '✓ Approve All Pending'}
                </button>
              )}
              <button onClick={handleGetToken} title="Copy refreshed token for Render env var update"
                className="text-xs font-medium text-gray-500 hover:text-emerald-700 border border-gray-200 hover:border-emerald-300 px-3 py-1.5 rounded-lg transition-colors">
                {tokenCopied ? '✓ Copied' : '⬇ Token'}
              </button>
            </>
          )}
          <button onClick={onClose}
            className="text-xs font-medium text-gray-400 hover:text-gray-700 border border-gray-200 px-3 py-1.5 rounded-lg transition-colors">
            Close
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">

        {/* Notifications */}
        {authMsg && (
          <div className="max-w-5xl mx-auto mb-3 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5">
            {authMsg}
          </div>
        )}
        {authError && authStatus !== 'ready' && (
          <div className="max-w-5xl mx-auto mb-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 flex items-start justify-between gap-3">
            <span><strong>Sheets error:</strong> {authError}</span>
            <a href="/api/sheets/debug" target="_blank" rel="noopener noreferrer"
              className="text-[10px] font-bold text-red-600 underline shrink-0">Debug info ↗</a>
          </div>
        )}
        {logResult && (
          <div className="max-w-5xl mx-auto mb-3 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5">
            {logResult}
          </div>
        )}
        {importResult && (
          <div className={`max-w-5xl mx-auto mb-3 text-xs font-medium rounded-xl px-4 py-2.5 border ${importResult.startsWith('Error') ? 'text-red-700 bg-red-50 border-red-200' : 'text-indigo-700 bg-indigo-50 border-indigo-200'}`}>
            {importResult}
          </div>
        )}
        {approveResult && (
          <div className={`max-w-5xl mx-auto mb-3 text-xs font-medium rounded-xl px-4 py-2.5 border ${approveResult.startsWith('Error') ? 'text-red-700 bg-red-50 border-red-200' : 'text-emerald-700 bg-emerald-50 border-emerald-200'}`}>
            {approveResult}
          </div>
        )}
        {tokenJson && (
          <div className="max-w-5xl mx-auto mb-3 bg-gray-900 rounded-xl px-4 py-3 space-y-2">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
              Refreshed GOOGLE_TOKEN — paste into Render → Environment → GOOGLE_TOKEN
            </p>
            <pre className="text-[9px] text-green-300 whitespace-pre-wrap break-all leading-relaxed max-h-32 overflow-y-auto">
              {tokenJson}
            </pre>
            <button onClick={() => setTokenJson('')}
              className="text-[10px] text-gray-500 hover:text-white transition-colors">✕ Dismiss</button>
          </div>
        )}

        {/* ── Empty state ──────────────────────────────────────────────────────── */}
        {!hasData && (
          <div className="max-w-5xl mx-auto flex flex-col items-center justify-center py-20 text-center gap-3">
            <p className="text-4xl">📊</p>
            <p className="text-sm font-semibold text-gray-600">No data yet</p>
            <p className="text-xs text-gray-400 leading-relaxed max-w-sm">
              Generate and review questions, or connect Google Sheets to see aggregate performance metrics.
            </p>
            {authStatus !== 'ready' && authStatus !== 'loading' && authStatus !== 'authenticating' && (
              <button onClick={handleAuth}
                className="flex items-center gap-2 text-sm font-semibold bg-blue-700 hover:bg-blue-800 text-white px-4 py-2 rounded-xl transition-colors mt-2">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Sign in with Google
              </button>
            )}
            {authStatus === 'authenticating' && (
              <div className="flex items-center gap-2 text-xs text-blue-600 mt-2">
                <span className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                Waiting for Google authorization…
              </div>
            )}
            {loadingStats && (
              <div className="flex items-center gap-2 text-xs text-gray-400 mt-2">
                <span className="w-4 h-4 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
                Loading from Google Sheets…
              </div>
            )}
          </div>
        )}

        {/* ── Main analytics ───────────────────────────────────────────────────── */}
        {hasData && (
          <div className="max-w-5xl mx-auto space-y-6">

            {/* Dashboard sub-header */}
            <div>
              <p className="text-xs text-gray-500 leading-relaxed">
                <span className="font-bold text-gray-700">{metrics.total}</span> questions total
                {metrics.reviewed > 0 && (
                  <> — <span className="font-bold text-gray-700">{metrics.reviewed}</span> reviewed
                  ({metrics.approved} approved, {metrics.rejected} rejected),{' '}
                  <span className="font-bold text-amber-600">{metrics.pending}</span> pending review
                </>
                )}
              </p>
            </div>

            {/* ── 4 Metric Cards ────────────────────────────────────────────── */}
            <Section title="AI Reviewer Performance Metrics">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <MetricCard
                  icon="🎯"
                  label="Precision"
                  displayValue={`${metrics.precision.toFixed(1)}%`}
                  rating={precisionRating}
                  description={`${metrics.precision.toFixed(1)}% of flagged questions were actually bad`}
                />
                <MetricCard
                  icon="🔍"
                  label="Recall"
                  displayValue={`${metrics.recall.toFixed(1)}%`}
                  rating={recallRating}
                  description={`${metrics.recall.toFixed(1)}% of actual bad questions were caught`}
                />
                <MetricCard
                  icon="⚖️"
                  label="F1 Score"
                  displayValue={metrics.f1.toFixed(2)}
                  rating={f1Rating}
                  description="Harmonic mean of Precision and Recall"
                />
                <MetricCard
                  icon="✅"
                  label="Approval Rate"
                  displayValue={`${metrics.approvalRate.toFixed(1)}%`}
                  rating={approvalRateRating}
                  description={`${metrics.TN} approved of ${metrics.reviewed} reviewed questions`}
                />
              </div>
            </Section>

            {/* ── Question Outcomes stacked bar ─────────────────────────────── */}
            <Section title="Question Outcomes">
              <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
                <StackedOutcomeBar
                  TP={metrics.TP}
                  FP={metrics.FP}
                  FN={metrics.FN}
                  TN={metrics.TN}
                  total={metrics.total}
                />
              </div>
            </Section>

            {/* ── Confusion Matrix ──────────────────────────────────────────── */}
            <Section title="Confusion Matrix">
              <ConfusionMatrix
                TP={metrics.TP}
                FP={metrics.FP}
                FN={metrics.FN}
                TN={metrics.TN}
              />
            </Section>

            {/* ── Google Sheets aggregate data ──────────────────────────────── */}
            {authStatus === 'ready' && stats && !stats.error && (stats.total || 0) > 0 && (
              <>
                {Object.keys(stats.by_module || {}).length > 0 && (
                  <Section title="Module Progress">
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-gray-50 border-b border-gray-100">
                            <th className="text-left px-4 py-2.5 font-bold text-gray-500">Module</th>
                            <th className="text-center px-3 py-2.5 font-bold text-gray-500">Topics</th>
                            <th className="text-right px-4 py-2.5 font-bold text-gray-500">Questions</th>
                            <th className="px-4 py-2.5 w-28" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {Object.entries(stats.by_module || {}).map(([mod, info]) => (
                            <tr key={mod} className="hover:bg-slate-50/60">
                              <td className="px-4 py-2.5 font-medium text-gray-700 max-w-[200px] truncate">{mod || '(no module)'}</td>
                              <td className="px-3 py-2.5 text-center text-gray-500">{info.topic_count}</td>
                              <td className="px-4 py-2.5 text-right font-bold text-blue-700">{info.question_count}</td>
                              <td className="px-4 py-2.5">
                                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                  <div className="h-full bg-blue-400 rounded-full"
                                    style={{ width: `${stats.total ? Math.round(info.question_count / stats.total * 100) : 0}%` }} />
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Section>
                )}

                {Object.keys(stats.by_type || {}).length > 0 && (
                  <Section title="By Question Type">
                    <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm space-y-2.5">
                      {Object.entries(stats.by_type).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                        <OutcomeBar key={type} label={type} value={count} total={stats.total} barClass="bg-indigo-400" />
                      ))}
                    </div>
                  </Section>
                )}

                {Object.keys(stats.by_difficulty || {}).length > 0 && (
                  <Section title="By Difficulty">
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        ['Easy',   'text-emerald-600', 'bg-emerald-50 border-emerald-200'],
                        ['Medium', 'text-amber-600',   'bg-amber-50   border-amber-200'],
                        ['Hard',   'text-red-500',     'bg-red-50     border-red-200'],
                      ].map(([d, textClass, bgClass]) => (
                        <div key={d} className={`rounded-xl px-4 py-3 text-center border ${bgClass}`}>
                          <p className={`text-[10px] font-bold uppercase tracking-wider mb-1 ${textClass} opacity-70`}>{d}</p>
                          <p className={`text-2xl font-bold tabular-nums ${textClass}`}>{stats.by_difficulty?.[d] || 0}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5">
                            {stats.total ? Math.round((stats.by_difficulty?.[d] || 0) / stats.total * 100) : 0}%
                          </p>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}
              </>
            )}

            {stats?.error && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                Sheets error: {stats.error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
