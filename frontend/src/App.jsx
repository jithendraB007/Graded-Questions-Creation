import { useState, useEffect } from 'react'
import PoolBuilder from './components/PoolBuilder.jsx'
import SamplesPanel from './components/SamplesPanel.jsx'
import SyllabusPanel from './components/SyllabusPanel.jsx'
import Dashboard from './components/Dashboard.jsx'
import QuestionBank from './components/QuestionBank.jsx'
import { fetchStructure, fetchHealth, downloadExcel, fetchSyllabus } from './api/client.js'

// Marks per question type — used as badge in UI and passed to generation prompt
export const QUESTION_MARKS = {
  // Grammar & Vocabulary — 2 marks
  'Fill in the Blanks':        2,
  'Cloze':                     2,
  'Error Correction':          2,
  'Sentence Arrangement':      2,
  'Jumbled Sentences':         2,
  'Jumbled Words':             2,
  'Sentence Conversion':       2,
  'Sentence Correction / MCQ': 2,
  // Reading
  'Higher-order Comprehension':          2,
  'Literal & Inferential Comprehension': 5,
  'Choice-based Comprehension':          7,
  // Writing
  'Short Functional Writing': 3,
  'Essay Writing':            5,
  'Story Writing':            5,
  'Process Writing':          7,
  'Email Writing':            8,
  'Notice Writing':           8,
  'Report Writing':           8,
  'Paragraph Writing':        14,
}

const ALL_TYPES = [
  // Grammar & Vocabulary
  'Fill in the Blanks',
  'Cloze',
  'Error Correction',
  'Sentence Arrangement',
  'Jumbled Sentences',
  'Jumbled Words',
  'Sentence Conversion',
  'Sentence Correction / MCQ',
  // Reading
  'Higher-order Comprehension',
  'Literal & Inferential Comprehension',
  'Choice-based Comprehension',
  // Writing
  'Short Functional Writing',
  'Essay Writing',
  'Story Writing',
  'Process Writing',
  'Email Writing',
  'Notice Writing',
  'Report Writing',
  'Paragraph Writing',
]

function coFromModule(moduleId, syllabus) {
  const num = moduleId?.split('_').pop()
  if (!num || isNaN(num)) return ''
  const unitNum = parseInt(num, 10)
  if (syllabus?.units) {
    const unit = syllabus.units.find(u => u.unit_number === unitNum)
    if (unit?.co) return unit.co
    const defined = Object.keys(syllabus.co_definitions || {})
    if (defined.length > 0) return defined[defined.length - 1]
  }
  return `CO${num}`
}

function coDescription(co, syllabus) {
  return syllabus?.co_definitions?.[co] || ''
}

function syllabusUnitFor(moduleId, syllabus) {
  if (!syllabus?.units) return null
  const num = parseInt(moduleId?.split('_').pop(), 10)
  return syllabus.units.find(u => u.unit_number === num) || null
}

export default function App() {
  const [structure,    setStructure]    = useState([])
  const [loading,      setLoading]      = useState(true)
  const [backendOk,    setBackendOk]    = useState(null)
  const [apiKeyReady,  setApiKeyReady]  = useState(false)

  // Cascading selection
  const [courseId,  setCourseId]  = useState('')
  const [moduleId,  setModuleId]  = useState('')
  const [topicIds,  setTopicIds]  = useState(new Set())   // multi-select
  const [qTypes,    setQTypes]    = useState(new Set())   // multi-select

  const [syllabus,     setSyllabus]     = useState(null)
  const [pool,          setPool]          = useState([])
  const [downloading,   setDownloading]   = useState(false)
  const [dlError,       setDlError]       = useState('')
  const [driveUrl,      setDriveUrl]      = useState('')
  const [driveErr,      setDriveErr]      = useState('')
  const [showSamples,      setShowSamples]      = useState(false)
  const [showSyllabus,     setShowSyllabus]     = useState(false)
  const [showDashboard,    setShowDashboard]    = useState(false)
  const [showQuestionBank, setShowQuestionBank] = useState(false)

  async function loadData() {
    setLoading(true)
    try {
      const health = await fetchHealth()
      setBackendOk(true)
      setApiKeyReady(health.api_key_configured)
      const data = await fetchStructure()
      setStructure(data.courses || [])
    } catch {
      setBackendOk(false)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  useEffect(() => {
    if (!courseId) { setSyllabus(null); return }
    fetchSyllabus(courseId).then(setSyllabus).catch(() => setSyllabus(null))
  }, [courseId])

  function pickCourse(id) {
    setCourseId(id); setModuleId(''); setTopicIds(new Set()); setQTypes(new Set()); setPool([])
  }
  function pickModule(id) {
    setModuleId(id); setTopicIds(new Set()); setQTypes(new Set()); setPool([])
  }
  function toggleTopic(id) {
    setTopicIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleQType(t) {
    setQTypes(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n })
  }

  const course = structure.find(c => c.id === courseId)
  const module = course?.modules.find(m => m.id === moduleId)
  const co     = coFromModule(moduleId, syllabus)
  const coDesc = coDescription(co, syllabus)
  const syllabusUnit = syllabusUnitFor(moduleId, syllabus)

  const moduleReady = Boolean(courseId && moduleId)
  const canGenerate = moduleReady && qTypes.size > 0

  async function handleDownload() {
    if (!pool.length) return
    setDlError(''); setDriveUrl(''); setDriveErr(''); setDownloading(true)
    const baseMeta = pool[pool.length - 1]?._meta || {}
    try {
      const downloadQuestions = pool
        .map(({ _type, _difficulty, _bloom, _meta, _status, _feedback, ...q }) => ({
          ...q,
          bloom:          _bloom || q.bloom || '',
          difficulty:     _difficulty || '',
          module_id:      _meta?.module || '',
          module_display: _meta?.module_display || '',
          topic_display:  _meta?.topic_display || '',
          course_outcome: _meta?.course_outcome || co,
          status:         _status || 'pending',
          feedback:       _feedback || '',
        }))
      const result = await downloadExcel(downloadQuestions, { ...baseMeta, course_outcome: co })
      if (result?.driveUrl) setDriveUrl(result.driveUrl)
      if (result?.driveErr) setDriveErr(result.driveErr)
    } catch (e) { setDlError(e.message) }
    finally { setDownloading(false) }
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50 font-sans text-gray-800 overflow-hidden">

      {/* ── App header ──────────────────────────────────────────────────────── */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between gap-4 shrink-0 shadow-sm">
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-blue-900 uppercase tracking-widest">GA Question Generator</h1>
          {co && course && (
            <p className="text-xs text-gray-400 mt-px truncate">
              {course.display}
              {module && <> <span className="mx-1">·</span> {module.display}</>}
              <span className="mx-1">·</span>
              <span className="font-semibold text-blue-500">{co}</span>
              {coDesc
                ? <span className="ml-1 text-gray-300">— {coDesc.slice(0, 70)}{coDesc.length > 70 ? '…' : ''}</span>
                : syllabusUnit && <span className="ml-1 text-gray-300">— {syllabusUnit.unit_name}</span>
              }
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!apiKeyReady && backendOk && (
            <span className="hidden sm:block text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              API key not set in .env
            </span>
          )}
          <button onClick={() => setShowDashboard(true)}
            className="text-xs font-semibold text-gray-500 hover:text-emerald-700 border border-gray-200 hover:border-emerald-300 bg-white px-3 py-1.5 rounded-lg transition-colors">
            📊 Dashboard
          </button>
          <button onClick={() => setShowQuestionBank(true)}
            className="text-xs font-semibold text-gray-500 hover:text-indigo-700 border border-gray-200 hover:border-indigo-300 bg-white px-3 py-1.5 rounded-lg transition-colors">
            🗄️ Question Bank
          </button>
          <button onClick={() => setShowSyllabus(true)}
            className="text-xs font-semibold text-gray-500 hover:text-violet-700 border border-gray-200 hover:border-violet-300 bg-white px-3 py-1.5 rounded-lg transition-colors">
            {syllabus ? '✓ Syllabus' : 'Upload Syllabus'}
          </button>
          <button onClick={() => setShowSamples(true)}
            className="text-xs font-semibold text-gray-500 hover:text-blue-700 border border-gray-200 hover:border-blue-300 bg-white px-3 py-1.5 rounded-lg transition-colors">
            Sample Questions
          </button>
          {dlError  && <p className="text-xs text-red-500 max-w-xs truncate">{dlError}</p>}
          {driveErr && <p className="text-xs text-amber-600 max-w-xs truncate" title={driveErr}>Drive: {driveErr.slice(0, 60)}</p>}
          {driveUrl && (
            <a href={driveUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1 hover:bg-emerald-100 transition-colors shrink-0">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              Saved to Drive
            </a>
          )}
          {pool.length > 0 && (() => {
            const dlCount = pool.filter(q => q._status !== 'rejected').length
            return (
              <>
                <span className="text-xs text-gray-400 font-medium tabular-nums hidden sm:block">
                  {pool.length} Q in pool
                </span>
                <button onClick={() => setPool([])}
                  className="text-xs text-gray-400 hover:text-red-500 border border-gray-200 hover:border-red-200 px-3 py-1.5 rounded-lg transition-colors">
                  Clear
                </button>
                <button onClick={handleDownload} disabled={downloading || dlCount === 0}
                  className="flex items-center gap-1.5 text-xs font-semibold bg-blue-700 hover:bg-blue-800 disabled:bg-blue-300 text-white px-4 py-1.5 rounded-lg transition-colors">
                  {downloading && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                  {downloading ? 'Downloading…' : `Download Excel (${dlCount})`}
                </button>
              </>
            )
          })()}
        </div>
      </header>

      {/* ── Selection bar ───────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-100 px-6 py-4 shrink-0 space-y-3">
        {loading ? (
          <p className="text-xs text-gray-400">Loading courses…</p>
        ) : !backendOk ? (
          <div className="flex flex-wrap items-center gap-4">
            <p className="text-xs font-semibold text-red-500">Backend not running.</p>
            <code className="text-[10px] bg-gray-100 rounded px-3 py-1.5 text-gray-600">
              backend\venv\Scripts\python.exe -m uvicorn backend.api_server:app --reload --port 8000
            </code>
            <button onClick={loadData} className="text-xs text-blue-600 hover:underline">↺ Retry</button>
          </div>
        ) : (
          <>
            {/* Row 1: Course + Module + CO badge */}
            <div className="flex flex-wrap items-end gap-3">
              <Dropdown label="Course" value={courseId} onChange={e => pickCourse(e.target.value)}>
                <option value="">Select course…</option>
                {structure.map(c => <option key={c.id} value={c.id}>{c.display}</option>)}
              </Dropdown>

              <span className="text-gray-200 pb-2 hidden sm:block">›</span>

              <Dropdown label="Module / Unit" value={moduleId} onChange={e => pickModule(e.target.value)} disabled={!courseId}>
                <option value="">Select module…</option>
                {course?.modules.map(m => <option key={m.id} value={m.id}>{m.display}</option>)}
              </Dropdown>

              {co && moduleId && (
                <div className="flex flex-col gap-0.5 pb-0.5">
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                    {syllabus ? 'Course Outcome' : 'Auto CO'}
                  </span>
                  <div className="px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg">
                    <span className="text-sm font-bold text-blue-700">{co}</span>
                    {syllabusUnit && (
                      <p className="text-[9px] text-blue-500 leading-tight mt-0.5">{syllabusUnit.unit_name}</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Row 2: Topic chips */}
            {moduleId && (module?.topics || []).length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider shrink-0 mr-1">Topics</span>
                {module.topics.map(t => (
                  <button key={t.id} onClick={() => toggleTopic(t.id)}
                    className={`text-xs font-medium px-3 py-1 rounded-full border transition-colors ${
                      topicIds.has(t.id)
                        ? 'bg-blue-700 text-white border-blue-700 shadow-sm'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300 hover:text-blue-700'
                    }`}>
                    {!t.has_material && <span className="mr-1 opacity-70">⚠</span>}
                    {t.display}
                  </button>
                ))}
                {module.topics.length > 1 && (
                  <>
                    <button onClick={() => setTopicIds(new Set(module.topics.map(t => t.id)))}
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium">All</button>
                    {topicIds.size > 0 && (
                      <button onClick={() => setTopicIds(new Set())}
                        className="text-xs text-gray-400 hover:text-red-500">Clear</button>
                    )}
                  </>
                )}
                {topicIds.size === 0 && (
                  <span className="text-[10px] text-gray-400 italic">
                    (none selected — all topics with material will be used)
                  </span>
                )}
              </div>
            )}

            {/* Row 3: Question type chips */}
            {moduleId && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider shrink-0 mr-1">Question Types</span>
                {ALL_TYPES.map(t => (
                  <button key={t} onClick={() => toggleQType(t)}
                    className={`text-xs font-medium px-3 py-1 rounded-full border transition-colors ${
                      qTypes.has(t)
                        ? 'bg-indigo-700 text-white border-indigo-700 shadow-sm'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300 hover:text-indigo-700'
                    }`}>
                    {t}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Main panel ──────────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">
        {!moduleReady ? (
          <EmptyState step={!courseId ? 1 : 2} />
        ) : !canGenerate ? (
          <EmptyState step={3} />
        ) : (
          <PoolBuilder
            key={`${courseId}/${moduleId}`}
            selection={{ course: courseId, module: moduleId }}
            selectedTopics={[...topicIds]}
            selectedQTypes={[...qTypes]}
            co={co}
            pool={pool}
            setPool={setPool}
            apiKeyReady={apiKeyReady}
            moduleTopics={module?.topics || []}
            questionMarks={QUESTION_MARKS}
          />
        )}
      </main>

      {/* ── Dashboard panel ─────────────────────────────────────────────────── */}
      {showDashboard && (
        <Dashboard pool={pool} co={co} onClose={() => setShowDashboard(false)} />
      )}

      {/* ── Question Bank panel ─────────────────────────────────────────────── */}
      {showQuestionBank && <QuestionBank onClose={() => setShowQuestionBank(false)} />}

      {/* ── Samples modal ───────────────────────────────────────────────────── */}
      {showSamples && <SamplesPanel onClose={() => setShowSamples(false)} />}

      {/* ── Syllabus modal ──────────────────────────────────────────────────── */}
      {showSyllabus && (
        <SyllabusPanel
          courses={structure}
          onClose={() => setShowSyllabus(false)}
          onUploaded={(cId, data) => { if (cId === courseId) setSyllabus(data) }}
        />
      )}
    </div>
  )
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function Dropdown({ label, value, onChange, disabled = false, children }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{label}</label>
      <select value={value} onChange={onChange} disabled={disabled}
        className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-50 disabled:text-gray-300 min-w-[160px] max-w-[260px]">
        {children}
      </select>
    </div>
  )
}

function EmptyState({ step }) {
  const msgs = [
    'Select a course to get started.',
    'Select a module / unit.',
    'Select one or more question types to start generating.',
  ]
  return (
    <div className="flex items-center justify-center h-full min-h-[60vh] text-center px-4">
      <div>
        <p className="text-4xl mb-3">📚</p>
        <p className="text-gray-400 text-sm">{msgs[step - 1]}</p>
      </div>
    </div>
  )
}
