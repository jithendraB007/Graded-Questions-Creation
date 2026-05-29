import { useState, useEffect, useCallback } from 'react'
import { fetchQuestionBank, deleteFromQuestionBank } from '../api/client.js'

const DIFFICULTIES = ['Easy', 'Medium', 'Hard']

export default function QuestionBank({ onClose }) {
  const [data,         setData]         = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [filterType,   setFilterType]   = useState('')
  const [filterDiff,   setFilterDiff]   = useState('')
  const [search,       setSearch]       = useState('')
  const [searchInput,  setSearchInput]  = useState('')
  const [expanded,     setExpanded]     = useState(null)
  const [deleting,     setDeleting]     = useState(null)
  const [deleteError,  setDeleteError]  = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await fetchQuestionBank({
        questionType: filterType || undefined,
        difficulty:   filterDiff || undefined,
        search:       search     || undefined,
      })
      setData(res)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filterType, filterDiff, search])

  useEffect(() => { load() }, [load])

  function handleSearch(e) {
    e.preventDefault()
    setSearch(searchInput.trim())
  }

  async function handleDelete(questionId) {
    if (!confirm('Remove this question from the database?')) return
    setDeleting(questionId); setDeleteError('')
    try {
      await deleteFromQuestionBank(questionId)
      setData(prev => ({
        ...prev,
        questions: prev.questions.filter(q => q.question_id !== questionId),
        total: prev.total - 1,
      }))
    } catch (e) {
      setDeleteError(e.message)
    } finally {
      setDeleting(null)
    }
  }

  const questions  = data?.questions || []
  const total      = data?.total     || 0
  const byType     = data?.by_type   || {}
  const byDiff     = data?.by_difficulty || {}
  const dbAvail    = data?.db_available
  const allTypes   = Object.keys(byType)

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-stretch justify-end">
      <div className="w-full max-w-4xl bg-white flex flex-col shadow-2xl">

        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between shrink-0 bg-white">
          <div>
            <h2 className="text-base font-bold text-gray-900">Question Bank</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {loading ? 'Loading…' : `${total.toLocaleString()} questions stored in database`}
            </p>
          </div>
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-xl font-light leading-none p-1">✕</button>
        </div>

        {dbAvail === false && !loading && (
          <div className="mx-6 mt-4 p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
            Database not connected. Make sure the Docker container <code className="font-mono text-xs bg-amber-100 px-1 rounded">graded-questions-generation</code> is running.
          </div>
        )}

        {/* Stats row */}
        {!loading && total > 0 && (
          <div className="px-6 py-3 border-b border-gray-100 flex flex-wrap gap-4 shrink-0 bg-gray-50">
            <div className="flex flex-wrap gap-2">
              {Object.entries(byType).map(([type, count]) => (
                <span key={type}
                  className="text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full px-2.5 py-0.5">
                  {type} <span className="font-bold">{count}</span>
                </span>
              ))}
            </div>
            <div className="flex gap-2 ml-auto">
              {Object.entries(byDiff).map(([diff, count]) => (
                <span key={diff}
                  className={`text-[11px] font-medium rounded-full px-2.5 py-0.5 border ${
                    diff === 'Easy'   ? 'bg-green-50  text-green-700  border-green-200'  :
                    diff === 'Medium' ? 'bg-amber-50  text-amber-700  border-amber-200'  :
                                        'bg-red-50    text-red-700    border-red-200'
                  }`}>
                  {diff} <span className="font-bold">{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="px-6 py-3 border-b border-gray-100 flex flex-wrap gap-3 items-center shrink-0 bg-white">
          {/* Search */}
          <form onSubmit={handleSearch} className="flex gap-2 flex-1 min-w-[200px]">
            <input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search questions…"
              className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <button type="submit"
              className="text-xs font-semibold bg-blue-700 hover:bg-blue-800 text-white px-3 py-1.5 rounded-lg transition-colors">
              Search
            </button>
            {(search || searchInput) && (
              <button type="button" onClick={() => { setSearch(''); setSearchInput('') }}
                className="text-xs text-gray-400 hover:text-red-500 px-2">✕</button>
            )}
          </form>

          {/* Type filter */}
          <select value={filterType} onChange={e => setFilterType(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 min-w-[160px]">
            <option value="">All types</option>
            {allTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>

          {/* Difficulty filter */}
          <select value={filterDiff} onChange={e => setFilterDiff(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400">
            <option value="">All difficulties</option>
            {DIFFICULTIES.map(d => <option key={d} value={d}>{d}</option>)}
          </select>

          <button onClick={load}
            className="text-xs text-gray-400 hover:text-blue-600 border border-gray-200 rounded-lg px-3 py-1.5 transition-colors">
            ↺ Refresh
          </button>
        </div>

        {/* Question list */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {loading && (
            <div className="flex items-center justify-center h-40">
              <span className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {!loading && error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">{error}</div>
          )}

          {!loading && !error && questions.length === 0 && (
            <div className="flex flex-col items-center justify-center h-40 text-gray-400">
              <p className="text-3xl mb-2">🗄️</p>
              <p className="text-sm">
                {total === 0 && !filterType && !filterDiff && !search
                  ? 'No questions yet. Generate some questions to populate the bank.'
                  : 'No questions match your filters.'}
              </p>
            </div>
          )}

          {deleteError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600">{deleteError}</div>
          )}

          {questions.map((q, i) => {
            const isOpen = expanded === q.question_id
            const date = q.created_at ? new Date(q.created_at).toLocaleDateString() : ''
            return (
              <div key={q.question_id}
                className="border border-gray-200 rounded-xl bg-white hover:border-blue-200 transition-colors">

                {/* Card header */}
                <div className="px-4 py-3 flex items-start gap-3 cursor-pointer"
                  onClick={() => setExpanded(isOpen ? null : q.question_id)}>

                  <span className="text-xs text-gray-400 font-mono mt-0.5 shrink-0 w-6 text-right">
                    {i + 1}
                  </span>

                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      <span className="text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full px-2 py-0.5">
                        {q.question_type}
                      </span>
                      {q.difficulty && (
                        <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 border ${
                          q.difficulty === 'Easy'   ? 'bg-green-50 text-green-700 border-green-200'  :
                          q.difficulty === 'Medium' ? 'bg-amber-50 text-amber-700 border-amber-200'  :
                                                      'bg-red-50   text-red-700   border-red-200'
                        }`}>
                          {q.difficulty}
                        </span>
                      )}
                      {q.domain && (
                        <span className="text-[10px] text-gray-400 border border-gray-100 rounded-full px-2 py-0.5">
                          {q.domain}
                        </span>
                      )}
                      {date && (
                        <span className="text-[10px] text-gray-300 ml-auto">{date}</span>
                      )}
                    </div>
                    <p className="text-sm text-gray-700 leading-snug line-clamp-2">
                      {q.question_text}
                    </p>
                  </div>

                  <span className="text-gray-300 text-xs shrink-0 mt-1">{isOpen ? '▲' : '▼'}</span>
                </div>

                {/* Expanded content */}
                {isOpen && (
                  <div className="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3">
                    <div>
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Full Question</p>
                      <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed bg-gray-50 rounded-lg p-3">
                        {q.question_text}
                      </pre>
                    </div>
                    {q.correct_answer && (
                      <div>
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Solution</p>
                        <pre className="text-sm text-emerald-700 whitespace-pre-wrap font-sans leading-relaxed bg-emerald-50 rounded-lg p-3">
                          {q.correct_answer}
                        </pre>
                      </div>
                    )}
                    {q.explanation && (
                      <div>
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Explanation</p>
                        <pre className="text-sm text-gray-600 whitespace-pre-wrap font-sans leading-relaxed bg-gray-50 rounded-lg p-3">
                          {q.explanation}
                        </pre>
                      </div>
                    )}
                    <div className="flex justify-end pt-1">
                      <button
                        onClick={() => handleDelete(q.question_id)}
                        disabled={deleting === q.question_id}
                        className="text-xs text-red-400 hover:text-red-600 border border-red-200 hover:border-red-400 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50">
                        {deleting === q.question_id ? 'Removing…' : '🗑 Remove from DB'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {!loading && questions.length > 0 && questions.length < total && (
            <p className="text-xs text-center text-gray-400 py-2">
              Showing {questions.length} of {total} questions. Use filters to narrow results.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
