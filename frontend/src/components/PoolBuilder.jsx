import { useState, useEffect, useMemo } from 'react'
import { generateQuestions, submitFeedback, optimizePrompts } from '../api/client.js'

const DIFFICULTIES = ['Easy', 'Medium', 'Hard']
const BLOOM_RANGE  = { Easy: 'K1–K2', Medium: 'K3–K4', Hard: 'K5–K6' }
const BLOOM_FALLBACK = { Easy: 'K2', Medium: 'K3', Hard: 'K5' }

const DIFF_PILL = {
  Easy:   'bg-emerald-100 text-emerald-700 border-emerald-200',
  Medium: 'bg-amber-100   text-amber-700   border-amber-200',
  Hard:   'bg-red-100     text-red-700     border-red-200',
}
const DIFF_BAR = { Easy: 'bg-emerald-400', Medium: 'bg-amber-400', Hard: 'bg-red-400' }

const STATUS_PILL = {
  approved: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  rejected: 'bg-red-100 text-red-600 border-red-200',
  pending:  'bg-gray-100 text-gray-500 border-gray-200',
}

// ── Bloom distribution helpers ────────────────────────────────────────────────
const CO_BLOOM_FOCUS = { 1: 0.0, 2: 0.25, 3: 0.5, 4: 0.75, 5: 1.0 }
const DIFF_K_LEVELS  = { Easy: ['K1','K2'], Medium: ['K3','K4'], Hard: ['K5','K6'] }

function computeBloomTargets(co, difficulty, count) {
  const m = (co || '').match(/CO(\d+)/i)
  const coNum = m ? parseInt(m[1], 10) : 3
  const focus = CO_BLOOM_FOCUS[coNum] ?? 0.5
  const [lowerK, higherK] = DIFF_K_LEVELS[difficulty] ?? ['K3', 'K4']
  let higherCount = Math.round(count * focus)
  if (count >= 3) higherCount = Math.max(1, Math.min(count - 1, higherCount))
  const lowerCount = count - higherCount
  return [...Array(lowerCount).fill(lowerK), ...Array(higherCount).fill(higherK)]
}

function bloomSummary(targets) {
  if (!targets.length) return ''
  const counts = {}
  targets.forEach(k => { counts[k] = (counts[k] || 0) + 1 })
  return Object.entries(counts).map(([k, n]) => n > 1 ? `${k}×${n}` : k).join(' · ')
}

function defaultDiff() {
  return { count: 5, loading: false, error: '', info: '' }
}

function defaultTypeSettings() {
  return { Easy: defaultDiff(), Medium: defaultDiff(), Hard: defaultDiff() }
}

export default function PoolBuilder({
  selection, selectedTopics, selectedQTypes, co,
  pool, setPool, apiKeyReady, moduleTopics = [], questionMarks = {},
}) {
  // Per question-type settings: { [qType]: { Easy: {...}, Medium: {...}, Hard: {...} } }
  const [typeSettings, setTypeSettings] = useState(() => {
    const s = {}
    selectedQTypes.forEach(t => { s[t] = defaultTypeSettings() })
    return s
  })

  const [optimizing,   setOptimizing]   = useState(false)
  const [optResult,    setOptResult]     = useState('')
  const [filterStatus, setFilterStatus] = useState('all')

  // Sync typeSettings when question types are added/removed
  useEffect(() => {
    setTypeSettings(prev => {
      const next = {}
      selectedQTypes.forEach(t => { next[t] = prev[t] || defaultTypeSettings() })
      return next
    })
  }, [selectedQTypes.join(',')]) // eslint-disable-line

  function patchType(qType, diff, p) {
    setTypeSettings(prev => ({
      ...prev,
      [qType]: { ...prev[qType], [diff]: { ...prev[qType]?.[diff], ...p } }
    }))
  }

  // Topics that will actually be used for generation
  const effectiveTopics = useMemo(() => {
    const topicsWithMaterial = selectedTopics.length > 0
      ? selectedTopics.filter(id => moduleTopics.find(t => t.id === id)?.has_material)
      : moduleTopics.filter(t => t.has_material).map(t => t.id)
    return topicsWithMaterial
  }, [selectedTopics, moduleTopics])

  const effectiveTopicDisplays = useMemo(() =>
    effectiveTopics.map(id => moduleTopics.find(t => t.id === id)?.display || id),
    [effectiveTopics, moduleTopics]
  )

  // ── Pool stats ──────────────────────────────────────────────────────────────
  const poolTypeStats = useMemo(() => {
    const s = {}
    pool.forEach(q => {
      const t = q._type || '_'
      if (!s[t]) s[t] = {}
      s[t][q._difficulty] = (s[t][q._difficulty] || 0) + 1
    })
    return s
  }, [pool])

  const statusStats = useMemo(() => {
    const s = { approved: 0, rejected: 0, pending: 0 }
    pool.forEach(q => { s[q._status || 'pending'] = (s[q._status || 'pending'] || 0) + 1 })
    return s
  }, [pool])

  const visiblePool = useMemo(() => {
    if (filterStatus === 'all') return pool
    return pool.filter(q => (q._status || 'pending') === filterStatus)
  }, [pool, filterStatus])

  // ── Generation ─────────────────────────────────────────────────────────────
  async function generateForTypeDiff(qType, diff) {
    const s = typeSettings[qType]?.[diff]
    if (!s || s.count === 0 || s.loading) return

    if (effectiveTopics.length === 0) {
      patchType(qType, diff, { error: 'No topics with reading material. Add .md files or select topics that have material.' })
      return
    }

    patchType(qType, diff, { loading: true, error: '', info: '' })

    let totalFiltered = 0
    for (const topicId of effectiveTopics) {
      try {
        const bloomTargets = computeBloomTargets(co, diff, s.count)
        const data = await generateQuestions({
          course:             selection.course,
          module:             selection.module,
          topic:              topicId,
          question_type:      qType,
          count:              s.count,
          difficulty:         diff,
          marks:              questionMarks[qType] || 2,
          bloom:              '',
          course_outcome:     co,
          model:              'anthropic/claude-sonnet-4-5',
          existing_questions: pool.map(q => q.question),
          bloom_targets:      bloomTargets,
        })
        const tagged = data.questions.map(q => ({
          ...q,
          _type:       qType,
          _difficulty: diff,
          _bloom:      q.bloom || BLOOM_FALLBACK[diff],
          _marks:      questionMarks[qType] || null,
          _meta:       data.meta,
          _status:     'pending',
          _feedback:   '',
        }))
        setPool(prev => [...prev, ...tagged])
        totalFiltered += data.filtered_count || 0
      } catch (e) {
        patchType(qType, diff, { loading: false, error: e.message })
        return
      }
    }

    patchType(qType, diff, {
      loading: false,
      info: totalFiltered > 0 ? `${totalFiltered} duplicate${totalFiltered !== 1 ? 's' : ''} skipped` : '',
    })
  }

  async function generateAllForType(qType) {
    for (const diff of DIFFICULTIES) {
      const s = typeSettings[qType]?.[diff]
      if (s?.count > 0) await generateForTypeDiff(qType, diff)
    }
  }

  // ── Pool mutations ──────────────────────────────────────────────────────────
  function removeFromPool(i) { setPool(prev => prev.filter((_, j) => j !== i)) }
  function updateInPool(i, upd) { setPool(prev => prev.map((q, j) => j === i ? { ...q, ...upd } : q)) }
  function approveQuestion(i) { updateInPool(i, { _status: 'approved', _feedback: '' }) }
  function rejectQuestion(i, fb) { updateInPool(i, { _status: 'rejected', _feedback: fb }) }

  // ── Optimizer ──────────────────────────────────────────────────────────────
  async function runOptimize() {
    const reviewed = pool.filter(q => q._status && q._status !== 'pending')
    if (!reviewed.length) { setOptResult('No reviewed questions yet.'); return }
    setOptimizing(true); setOptResult('')
    try {
      const items = reviewed.map(q => ({
        question:       q.question,
        solution:       q.solution,
        explanation:    q.explanation,
        bloom:          q._bloom || q.bloom || '',
        difficulty:     q._difficulty || '',
        question_type:  q._type || '',
        course_outcome: q._meta?.course_outcome || co,
        status:         q._status,
        feedback:       q._feedback || '',
      }))
      await submitFeedback(items)
      const result = await optimizePrompts()
      setOptResult(result.message || 'Prompts updated.')
    } catch (e) {
      setOptResult(`Error: ${e.message}`)
    } finally {
      setOptimizing(false)
    }
  }

  const reviewedCount = pool.filter(q => q._status && q._status !== 'pending').length
  const topicLabel = effectiveTopicDisplays.length === 0
    ? 'No topics with material'
    : effectiveTopicDisplays.length === 1
      ? effectiveTopicDisplays[0]
      : `${effectiveTopicDisplays.length} topics`

  return (
    <div className="max-w-3xl mx-auto px-6 py-5 space-y-4">

      {/* ── API key warning ──────────────────────────────────────────────────── */}
      {!apiKeyReady && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-xl px-4 py-3">
          API key not configured — open <strong>D:\GA\.env</strong> and restart the backend.
        </div>
      )}

      {/* ── Info banner ──────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
        <svg className="w-4 h-4 text-blue-400 shrink-0 mt-px" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-xs text-blue-700 leading-relaxed">
          <strong>Generating for:</strong>{' '}
          {effectiveTopicDisplays.length === 0
            ? <span className="text-amber-700">No topics with material selected.</span>
            : effectiveTopicDisplays.length <= 3
              ? effectiveTopicDisplays.join(', ')
              : `${effectiveTopicDisplays.slice(0, 2).join(', ')} + ${effectiveTopicDisplays.length - 2} more`
          }
          {effectiveTopics.length > 1 && (
            <span className="ml-2 text-blue-500">
              — count per row is <em>per topic</em> (total = count × {effectiveTopics.length} topics)
            </span>
          )}
        </p>
      </div>

      {/* ── One card per question type ───────────────────────────────────────── */}
      {selectedQTypes.map(qType => {
        const typeS = typeSettings[qType] || {}
        const typeAnyLoading = DIFFICULTIES.some(d => typeS[d]?.loading)

        return (
          <div key={qType} className="bg-white rounded-xl border border-gray-200 overflow-hidden">

            {/* Card header */}
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-gray-800">{qType}</p>
                  {questionMarks[qType] && (
                    <span className="text-[10px] font-bold bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-full px-2 py-px">
                      {questionMarks[qType]} marks
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-px">
                  {topicLabel}
                  {co && <> · <span className="text-blue-500 font-medium">{co}</span></>}
                </p>
              </div>
              <button onClick={() => generateAllForType(qType)}
                disabled={typeAnyLoading || !apiKeyReady || effectiveTopics.length === 0}
                className="flex items-center gap-1.5 text-xs font-semibold bg-blue-700 hover:bg-blue-800 disabled:bg-gray-100 disabled:text-gray-400 text-white px-4 py-1.5 rounded-lg transition-colors whitespace-nowrap">
                {typeAnyLoading
                  ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Generating…</>
                  : 'Generate All'
                }
              </button>
            </div>

            {/* Column headers */}
            <div className="grid grid-cols-[80px_96px_1fr_120px] items-center gap-3 px-4 py-2 bg-gray-50 border-b border-gray-100">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Difficulty</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Bloom Targets</span>
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Count · Progress</span>
              <span />
            </div>

            {/* Difficulty rows */}
            <div className="divide-y divide-gray-50">
              {DIFFICULTIES.map(diff => {
                const s      = typeS[diff] || defaultDiff()
                const inPool = poolTypeStats[qType]?.[diff] || 0
                const target = s.count * Math.max(1, effectiveTopics.length)
                const pct    = target > 0 ? Math.min(100, (inPool / target) * 100) : 0
                const done   = s.count > 0 && effectiveTopics.length > 0 && inPool >= target

                return (
                  <div key={diff} className={`px-4 py-3.5 transition-colors ${s.loading ? 'bg-blue-50/30' : ''}`}>
                    <div className="grid grid-cols-[80px_96px_1fr_120px] items-center gap-3">
                      <span className={`text-[10px] font-bold border rounded-full px-2 py-0.5 text-center ${DIFF_PILL[diff]}`}>
                        {diff}
                      </span>
                      <span className="text-[10px] font-semibold text-gray-500 bg-gray-100 rounded px-1.5 py-0.5 text-center whitespace-nowrap">
                        {s.count > 0 ? bloomSummary(computeBloomTargets(co, diff, s.count)) : BLOOM_RANGE[diff]}
                      </span>
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => patchType(qType, diff, { count: Math.max(0, s.count - 1) })}
                            disabled={s.loading}
                            className="w-6 h-6 rounded border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-40 flex items-center justify-center font-medium">−</button>
                          <span className="w-6 text-center text-sm font-semibold tabular-nums">{s.count}</span>
                          <button onClick={() => patchType(qType, diff, { count: Math.min(20, s.count + 1) })}
                            disabled={s.loading}
                            className="w-6 h-6 rounded border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-40 flex items-center justify-center font-medium">+</button>
                          {effectiveTopics.length > 1 && (
                            <span className="text-[10px] text-gray-400 ml-0.5">×{effectiveTopics.length}</span>
                          )}
                        </div>
                        {s.count > 0 && effectiveTopics.length > 0 && (
                          <div className="flex-1 flex items-center gap-2 min-w-0">
                            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full transition-all duration-500 ${done ? 'bg-emerald-400' : DIFF_BAR[diff]}`}
                                style={{ width: `${pct}%` }} />
                            </div>
                            <span className={`text-[10px] tabular-nums font-semibold shrink-0 ${done ? 'text-emerald-600' : 'text-gray-400'}`}>
                              {inPool}/{target}
                            </span>
                          </div>
                        )}
                      </div>
                      <button onClick={() => generateForTypeDiff(qType, diff)}
                        disabled={s.loading || !apiKeyReady || s.count === 0 || effectiveTopics.length === 0}
                        className="flex items-center justify-center gap-1 text-xs font-medium border border-gray-200 hover:border-blue-300 hover:text-blue-700 hover:bg-blue-50 disabled:opacity-40 text-gray-600 px-2 py-1.5 rounded-lg transition-colors whitespace-nowrap">
                        {s.loading
                          ? <><span className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />Generating</>
                          : `Generate ${diff}`
                        }
                      </button>
                    </div>
                    {s.error && <p className="text-xs text-red-600 mt-2 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{s.error}</p>}
                    {!s.error && s.info && <p className="text-xs text-amber-700 mt-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">{s.info}</p>}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {/* ── Question pool ─────────────────────────────────────────────────────── */}
      {pool.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                <p className="text-sm font-semibold text-gray-800">
                  Question Pool
                  <span className="ml-2 text-xs font-normal text-gray-400">{pool.length} total</span>
                </p>
                {statusStats.approved > 0 && (
                  <span className="text-[10px] font-bold bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-full px-2 py-px">
                    ✓ {statusStats.approved} approved
                  </span>
                )}
                {statusStats.rejected > 0 && (
                  <span className="text-[10px] font-bold bg-red-100 text-red-600 border border-red-200 rounded-full px-2 py-px">
                    ✗ {statusStats.rejected} rejected
                  </span>
                )}
                {statusStats.pending > 0 && (
                  <span className="text-[10px] font-bold bg-gray-100 text-gray-500 border border-gray-200 rounded-full px-2 py-px">
                    {statusStats.pending} pending
                  </span>
                )}
              </div>
              <div className="flex gap-1.5 flex-wrap justify-end items-center">
                {reviewedCount > 0 && (
                  <button onClick={runOptimize} disabled={optimizing}
                    className="flex items-center gap-1 text-[10px] font-bold bg-violet-100 hover:bg-violet-200 text-violet-700 border border-violet-200 rounded-full px-2.5 py-1 transition-colors disabled:opacity-50">
                    {optimizing
                      ? <><span className="w-2.5 h-2.5 border border-violet-400 border-t-transparent rounded-full animate-spin" />Optimizing</>
                      : `⚡ Optimize (${reviewedCount})`
                    }
                  </button>
                )}
              </div>
            </div>
            {optResult && (
              <p className="text-[10px] text-violet-700 bg-violet-50 border border-violet-100 rounded-lg px-3 py-1.5 mt-2">{optResult}</p>
            )}
            <div className="flex gap-1 mt-2">
              {['all','pending','approved','rejected'].map(s => (
                <button key={s} onClick={() => setFilterStatus(s)}
                  className={`text-[10px] font-semibold px-2.5 py-1 rounded-full transition-colors ${
                    filterStatus === s ? 'bg-gray-800 text-white' : 'text-gray-500 hover:bg-gray-100'
                  }`}>
                  {s === 'all' ? `All (${pool.length})` : `${s.charAt(0).toUpperCase()+s.slice(1)} (${statusStats[s] || 0})`}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-gray-50">
            {visiblePool.map(q => {
              const realIdx = pool.indexOf(q)
              return (
                <PoolQuestion
                  key={realIdx}
                  index={realIdx + 1}
                  question={q}
                  onRemove={() => removeFromPool(realIdx)}
                  onUpdate={upd => updateInPool(realIdx, upd)}
                  onApprove={() => approveQuestion(realIdx)}
                  onReject={fb => rejectQuestion(realIdx, fb)}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Individual pool question ──────────────────────────────────────────────────
function PoolQuestion({ index, question, onRemove, onUpdate, onApprove, onReject }) {
  const [editing,   setEditing]   = useState(false)
  const [expanded,  setExpanded]  = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [fbText,    setFbText]    = useState('')
  const [draft,     setDraft]     = useState({
    question:    question.question,
    solution:    question.solution,
    explanation: question.explanation,
  })

  function save()   { onUpdate(draft); setEditing(false) }
  function cancel() {
    setDraft({ question: question.question, solution: question.solution, explanation: question.explanation })
    setEditing(false)
  }
  function handleReject() { onReject(fbText); setRejecting(false); setFbText('') }

  const bloomLabel = question._bloom || question.bloom || ''
  const status     = question._status || 'pending'
  const topicDisp  = question._meta?.topic_display || ''
  const qTypeDisp  = question._type || ''

  const statusBg = status === 'approved' ? 'bg-emerald-50/40'
                 : status === 'rejected' ? 'bg-red-50/30'
                 : ''

  if (editing) {
    return (
      <div className="px-4 py-4 bg-blue-50/20">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-blue-600">Editing Q{index}</span>
            <span className={`text-[10px] font-bold border rounded px-1.5 py-px ${DIFF_PILL[question._difficulty] || 'bg-gray-100 text-gray-500 border-gray-200'}`}>
              {question._difficulty}
            </span>
            {bloomLabel && <span className="text-[10px] bg-slate-100 text-slate-600 rounded px-1.5 py-px font-medium">{bloomLabel}</span>}
          </div>
          <div className="flex gap-2">
            <button onClick={save} className="text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 px-3 py-1.5 rounded-lg transition-colors">Save</button>
            <button onClick={cancel} className="text-xs text-gray-500 border border-gray-200 px-3 py-1.5 rounded-lg transition-colors">Cancel</button>
          </div>
        </div>
        <div className="space-y-3">
          {[
            { key: 'question',    label: 'Question',    rows: 4 },
            { key: 'solution',    label: 'Solution',    rows: 3 },
            { key: 'explanation', label: 'Explanation', rows: 3 },
          ].map(({ key, label, rows }) => (
            <div key={key}>
              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mb-1">{label}</label>
              <textarea value={draft[key]} onChange={e => setDraft(p => ({ ...p, [key]: e.target.value }))}
                rows={rows}
                className="w-full text-xs text-gray-800 border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 resize-y leading-relaxed" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={`px-4 py-3.5 hover:bg-slate-50/60 transition-colors group ${statusBg}`}>
      <div className="flex items-start gap-3">
        <span className="text-xs font-bold text-gray-300 w-5 shrink-0 pt-px tabular-nums">{index}.</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-2 flex-wrap">
            {topicDisp && (
              <span className="text-[9px] bg-indigo-50 text-indigo-600 border border-indigo-100 rounded px-1.5 py-px font-semibold max-w-[140px] truncate">
                {topicDisp}
              </span>
            )}
            {qTypeDisp && (
              <span className="text-[9px] bg-slate-50 text-slate-500 border border-slate-100 rounded px-1.5 py-px font-semibold max-w-[120px] truncate">
                {qTypeDisp}
              </span>
            )}
            <span className={`text-[10px] font-bold border rounded px-1.5 py-px ${DIFF_PILL[question._difficulty] || 'bg-gray-100 text-gray-500 border-gray-200'}`}>
              {question._difficulty}
            </span>
            {bloomLabel && (
              <span className="text-[10px] bg-violet-100 text-violet-700 border border-violet-200 rounded px-1.5 py-px font-semibold">
                {bloomLabel}
              </span>
            )}
            {status !== 'pending' && (
              <span className={`text-[9px] font-bold border rounded-full px-2 py-px ${STATUS_PILL[status]}`}>
                {status === 'approved' ? '✓ Approved' : '✗ Rejected'}
              </span>
            )}
          </div>

          <p className="text-xs text-gray-800 whitespace-pre-wrap leading-relaxed">{question.question}</p>

          {question.solution && (
            <div className="mt-2 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
              <p className="text-xs text-emerald-800 whitespace-pre-wrap leading-relaxed">
                <span className="font-semibold">Solution: </span>{question.solution}
              </p>
            </div>
          )}

          {question.explanation && (
            <div className="mt-1.5">
              <button onClick={() => setExpanded(v => !v)}
                className="text-[10px] font-medium text-blue-500 hover:text-blue-700 transition-colors">
                {expanded ? '▾ Hide explanation' : '▸ Show explanation'}
              </button>
              {expanded && <p className="text-xs text-gray-500 mt-1.5 leading-relaxed whitespace-pre-wrap">{question.explanation}</p>}
            </div>
          )}

          {status === 'rejected' && question._feedback && (
            <div className="mt-2 bg-red-50 border border-red-100 rounded-lg px-3 py-1.5">
              <p className="text-[10px] text-red-600"><span className="font-semibold">Rejection note:</span> {question._feedback}</p>
            </div>
          )}

          {rejecting && (
            <div className="mt-2 space-y-1.5">
              <textarea value={fbText} onChange={e => setFbText(e.target.value)}
                placeholder="Why is this question rejected? (optional)"
                rows={2}
                className="w-full text-xs text-gray-800 border border-red-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-300 resize-none" />
              <div className="flex gap-2">
                <button onClick={handleReject}
                  className="text-xs font-semibold text-white bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded-lg transition-colors">
                  Confirm Reject
                </button>
                <button onClick={() => { setRejecting(false); setFbText('') }}
                  className="text-xs text-gray-500 border border-gray-200 px-3 py-1.5 rounded-lg transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {status !== 'approved' && !rejecting && (
            <button onClick={onApprove} title="Approve"
              className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </button>
          )}
          {status !== 'rejected' && !rejecting && (
            <button onClick={() => setRejecting(true)} title="Reject"
              className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          {status !== 'pending' && !rejecting && (
            <button onClick={() => onUpdate({ _status: 'pending', _feedback: '' })} title="Undo"
              className="w-7 h-7 flex items-center justify-center text-gray-300 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors text-[10px] font-bold">
              ↺
            </button>
          )}
          {!rejecting && (
            <button onClick={() => setEditing(true)} title="Edit"
              className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
          {!rejecting && (
            <button onClick={onRemove} title="Remove"
              className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
