# GA Question Generator

An AI-powered English assessment question generation system built for four courses across Foundation, Advanced, Applied, and Language Analytics levels. Questions are grounded in reading material, aligned to Bloom's Taxonomy and Course Outcomes, deduplicated using semantic embeddings, and tracked via Google Sheets and a PostgreSQL question bank.

---

## Tech Stack

### Backend
| Technology | Purpose |
|---|---|
| **Python 3.10+** | Core language |
| **FastAPI** | REST API framework |
| **Uvicorn** | ASGI server |
| **OpenAI SDK** | LLM API client (routed via OpenRouter) |
| **Claude (Anthropic)** | LLM for question generation via OpenRouter |
| **OpenRouter** | LLM routing — model-agnostic API gateway |
| **PostgreSQL 16** | Question bank database |
| **pgvector** | Vector similarity extension for PostgreSQL |
| **psycopg2** | PostgreSQL driver for Python |
| **sentence-transformers** | Semantic embeddings (all-MiniLM-L6-v2, 384-dim) |
| **scikit-learn** | Cosine similarity for session-level dedup |
| **Google Sheets API** | Question logging and dashboard |
| **Google Drive API** | Excel export to Drive |
| **gspread** | Google Sheets Python client |
| **openpyxl** | Excel (.xlsx) file generation |
| **PyYAML** | Reading eval/sample YAML files |
| **Pydantic** | Request/response validation |

### Frontend
| Technology | Purpose |
|---|---|
| **React 18** | UI framework |
| **Vite** | Build tool and dev server |
| **Tailwind CSS** | Utility-first styling |
| **Recharts** | Dashboard charts |

### Infrastructure
| Technology | Purpose |
|---|---|
| **Docker** | Local PostgreSQL + pgvector container |
| **Render** | Cloud deployment (web service + managed PostgreSQL) |
| **GitHub** | Source control and Render deploy trigger |
| **Promptfoo** | LLM evaluation framework for question quality checks |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    React Frontend                        │
│  PoolBuilder · Dashboard · QuestionBank · SamplesPanel  │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP (fetch)
                     ▼
┌─────────────────────────────────────────────────────────┐
│                 FastAPI Backend                          │
│                 api_server.py                           │
│                                                         │
│  /api/generate ──► build_prompt() ──► OpenRouter LLM   │
│                         │                               │
│                    Parse questions                      │
│                         │                               │
│              ┌──────────▼──────────┐                   │
│              │  Dedup Pipeline     │                   │
│              │  1. Jaccard (batch) │                   │
│              │  2. Exact DB check  │                   │
│              │  3. pgvector sim.   │                   │
│              │  4. Session sim.    │                   │
│              └──────────┬──────────┘                   │
│                         │                               │
│            ┌────────────▼────────────┐                 │
│            │   PostgreSQL + pgvector │                 │
│            │   (question bank + dedup│                 │
│            └────────────┬────────────┘                 │
│                         │                               │
│            ┌────────────▼────────────┐                 │
│            │   Google Sheets API     │                 │
│            │   (logging + dashboard) │                 │
│            └─────────────────────────┘                 │
└─────────────────────────────────────────────────────────┘
```

---

## Key Features

### Question Generation
- Generates questions grounded in topic reading material (Markdown files)
- Supports **20 question types** across Grammar & Vocabulary, Reading, and Writing
- Bloom's K-level (K1–K6) auto-distributed per question based on Course Outcome
- Per-difficulty generation: Easy / Medium / Hard
- Module-level batch generation (all topics in one pass)

### Anti-Duplicate Pipeline (4-Gate Deduplication)
Every generated question passes through four gates before being accepted:
1. **Exact match** — fast text hash check against database
2. **Semantic embedding** — `all-MiniLM-L6-v2` (384-dimensional vectors) stored in pgvector
3. **pgvector similarity** — cosine similarity query against all stored questions (threshold: 0.85)
4. **Session similarity** — cosine similarity against questions generated in the current session

A diversity log (connectors used, domains covered, sentence starters, answer positions) is injected into every LLM prompt to prevent pattern repetition.

### Question Bank
- Full-screen panel showing all questions stored in PostgreSQL
- Filter by question type and difficulty
- Full-text search
- Expandable cards showing question, solution, and explanation
- Delete individual questions from the database

### Review Workflow
- Approve / Reject each question with optional feedback notes
- Filter pool by All / Pending / Approved / Rejected
- DSPy-style prompt optimisation using approved questions as few-shot examples

### Google Sheets Dashboard
- Live question log with timestamp, CO, bloom level, status, and feedback
- Dashboard tab with quality metrics: Approval Rate, Rejection Rate, Review Coverage
- Charts: by difficulty, by Bloom level, by question type, questions over time

### Excel Export
- Download approved questions as `.xlsx`
- Sheet 1: Generated Questions with full metadata
- Sheet 2: Feedback log for rejected/reviewed questions
- Automatic upload to Google Drive

### Quality Evals (Promptfoo)
- Automated evaluation of question quality for 5 question types
- Positive tests (valid questions) + negative tests (intentionally flawed questions)
- LLM-as-judge rubric evaluation via OpenRouter

---

## Prerequisites

| Tool | Version | Download |
|---|---|---|
| Python | 3.10 or 3.11 | https://www.python.org/downloads/ |
| Node.js | 18 LTS or newer | https://nodejs.org/ |
| Docker Desktop | Latest | https://www.docker.com/products/docker-desktop/ |
| Git | Latest | https://git-scm.com/ |

---

## Local Setup

### Step 1 — Clone the repository
```powershell
git clone https://github.com/jithendraB007/Graded-Questions-Creation.git
cd Graded-Questions-Creation
```

### Step 2 — Create Python virtual environment
```powershell
py -3.10 -m venv backend\venv
backend\venv\Scripts\Activate.ps1
```

If you get a scripts error:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Step 3 — Install Python packages
```powershell
pip install -r requirements.txt
```

### Step 4 — Install frontend packages
```powershell
cd frontend
npm install
cd ..
```

### Step 5 — Configure environment variables

Copy `.env.example` to `.env` (or edit `.env` directly):
```
OPENROUTER_API_KEY=sk-or-v1-...your-key...

# PostgreSQL (Docker)
DB_HOST=localhost
DB_PORT=5433
DB_NAME=questions_db
DB_USER=postgres
DB_PASSWORD=gapassword

# Google Sheets
GOOGLE_SPREADSHEET_ID=your-sheet-id
GOOGLE_TOKEN={"token": "..."}
```

Get an OpenRouter API key at https://openrouter.ai

> `.env` is gitignored. Never commit it.

### Step 6 — Start the PostgreSQL + pgvector database (Docker)

```powershell
docker run -d `
  --name graded-questions-generation `
  --restart unless-stopped `
  -e POSTGRES_PASSWORD=gapassword `
  -e POSTGRES_DB=questions_db `
  -e POSTGRES_USER=postgres `
  -p 5433:5432 `
  -v graded_questions_data:/var/lib/postgresql/data `
  pgvector/pgvector:pg16
```

The schema is applied automatically on first backend startup.

### Step 7 — Run the app

**Terminal 1 — Backend:**
```powershell
backend\venv\Scripts\python.exe -m uvicorn backend.api_server:app --reload --port 8000
```

**Terminal 2 — Frontend:**
```powershell
cd frontend
npm run dev
```

Open: http://localhost:5173

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | ✅ Yes | OpenRouter API key for LLM access |
| `DB_HOST` | ✅ Yes | PostgreSQL host (localhost for local) |
| `DB_PORT` | ✅ Yes | PostgreSQL port (5433 for local Docker) |
| `DB_NAME` | ✅ Yes | Database name (`questions_db`) |
| `DB_USER` | ✅ Yes | Database user (`postgres`) |
| `DB_PASSWORD` | ✅ Yes | Database password |
| `GOOGLE_SPREADSHEET_ID` | Optional | Google Sheets ID for dashboard |
| `GOOGLE_TOKEN` | Optional | OAuth token JSON (single line) |
| `GOOGLE_CLIENT_SECRET` | Optional | OAuth client secret JSON (single line) |
| `SIMILARITY_THRESHOLD` | Optional | Dedup threshold, default `0.85` |

---

## Deployment on Render

### Step 1 — Push to GitHub
```bash
git push origin main
```

### Step 2 — Create Blueprint on Render
1. Go to https://render.com → **New** → **Blueprint**
2. Connect your GitHub repository
3. Render reads `render.yaml` and creates:
   - **Web service**: `ga-question-generator` (Python + Node build)
   - **PostgreSQL database**: `graded-questions-db` (free tier, pgvector included)

### Step 3 — Add secret environment variables
In the Render dashboard → web service → **Environment** tab, add:

| Key | Value |
|---|---|
| `OPENROUTER_API_KEY` | Your `sk-or-v1-...` key |
| `GOOGLE_SPREADSHEET_ID` | Your spreadsheet ID |
| `GOOGLE_TOKEN` | Full token JSON as a single line |
| `GOOGLE_CLIENT_SECRET` | Full client secret JSON as a single line |

DB connection variables (`DB_HOST`, `DB_PORT`, etc.) are automatically injected from the managed database — no manual entry needed.

### Step 4 — Deploy
Click **Deploy**. Render will:
1. Install Python + Node.js dependencies
2. Build the React frontend
3. Connect to the managed PostgreSQL database
4. Run the schema migration automatically on startup
5. Serve the app on a `*.onrender.com` URL

### Notes
- The database schema (`CREATE TABLE questions`, `CREATE EXTENSION vector`) runs automatically on every deploy — it is idempotent and safe to run repeatedly.
- The `sentence-transformers` model (`all-MiniLM-L6-v2`) is downloaded on first use and cached. Render's **Starter plan ($7/month)** is recommended for production use due to the 512MB RAM requirement.
- Local Docker DB and Render DB are completely separate — data does not sync between them.

---

## Using the App

### Selection Bar
| Field | Description |
|---|---|
| **Course** | Foundation / Advanced / Applied / Language Analytics |
| **Module / Unit** | Module within the selected course |
| **Topics** | Optional filter — leave empty to use all topics with material |
| **Question Types** | Multi-select — generate multiple types in one session |
| **CO badge** | Auto-derived from module number, or loaded from uploaded syllabus |

### Question Types Supported

**Grammar & Vocabulary**
Fill in the Blanks · Cloze · Error Correction · Sentence Arrangement · Jumbled Sentences · Jumbled Words · Sentence Conversion · Sentence Correction / MCQ

**Reading Comprehension**
Higher-order Comprehension · Literal & Inferential Comprehension · Choice-based Comprehension

**Writing**
Short Functional Writing · Essay Writing · Story Writing · Process Writing · Email Writing · Notice Writing · Report Writing · Paragraph Writing

### Review Workflow
1. Generate questions at any difficulty level
2. Each question shows: question text, solution, explanation, Bloom level, difficulty
3. **Approve** or **Reject** (with optional feedback note) each question
4. Filter the pool: All / Pending / Approved / Rejected
5. Click **⚡ Optimize** to submit feedback and improve future generations
6. Click **Download Excel** to export approved questions

### Question Bank (🗄️ button)
- Browse all questions ever generated and saved to the database
- Filter by type and difficulty, or search by keyword
- Expandable cards show full question, solution, and explanation
- Delete questions from the database permanently

### Dashboard (📊 button)
- **Approve All Pending** — bulk approve all pending questions
- **Import CSV** — import question CSV files into the log
- Quality metrics: Approval Rate, Rejection Rate, Review Coverage
- Charts by difficulty, Bloom level, question type, and time

---

## Folder Structure

```
D:\GA\
│
├── .env                          ← API keys and DB credentials (never commit)
├── generate_questions.py         ← CLI tool + chunked dedup pipeline
├── render.yaml                   ← Render deployment config
├── requirements.txt              ← Python dependencies
├── README.md                     ← This file
│
├── database\
│   ├── config.py                 ← PostgreSQL connection pool (psycopg2)
│   ├── schema.sql                ← Table definitions + pgvector indexes
│   ├── queries.py                ← DB read/write functions
│   └── sheets_sync.py            ← Google Sheets export layer
│
├── backend\
│   ├── api_server.py             ← FastAPI app (all API endpoints)
│   └── integrations\
│       └── sheets.py             ← Google Sheets OAuth client + logging
│
├── frontend\
│   ├── src\
│   │   ├── App.jsx               ← Main layout, selection bar, pool state
│   │   ├── components\
│   │   │   ├── PoolBuilder.jsx   ← Generation panel + review workflow
│   │   │   ├── Dashboard.jsx     ← Google Sheets dashboard with Recharts
│   │   │   ├── QuestionBank.jsx  ← PostgreSQL question bank browser
│   │   │   ├── SamplesPanel.jsx  ← Sample questions viewer + uploader
│   │   │   └── SyllabusPanel.jsx ← Syllabus upload modal
│   │   └── api\
│   │       └── client.js         ← All fetch calls to the backend
│   └── vite.config.js            ← Proxies /api → port 8000
│
├── courses\
│   ├── foundation\               ← Module → Topic → material/ + metadata.json
│   ├── advanced\
│   ├── applied\
│   └── language_analytics\
│
├── evals\                        ← Promptfoo quality evaluation configs
│   ├── cloze\
│   ├── fill_in_the_blanks\
│   ├── error_correction\
│   ├── sentence_arrangement\
│   └── jumbled_words\
│
├── credentials\                  ← Google OAuth credentials (DO NOT commit)
│   ├── client_secret.json
│   └── token.json
│
├── syllabi\                      ← Parsed syllabus JSON files
└── feedback\                     ← Reviewer feedback for DSPy optimisation
```

---

## Running Quality Checks (Promptfoo Evals)

Quality checks evaluate whether generated questions meet the defined standard using an LLM-as-judge approach.

```powershell
# Set OpenRouter key as OPENAI_API_KEY (Promptfoo uses openai: provider)
$env:OPENAI_API_KEY = (Get-Content .env | Select-String "OPENROUTER_API_KEY").ToString().Split("=")[1]

# Run eval for a specific question type
cd evals\cloze
promptfoo eval --no-cache

cd evals\fill_in_the_blanks
promptfoo eval --no-cache
```

**Current pass rates:**

| Question Type | Tests | Pass Rate |
|---|---|---|
| Fill in the Blanks | 21 | 95% |
| Jumbled Words | 20 | 95% |
| Error Correction | 10 | 90% |
| Sentence Arrangement | 10 | 90% |
| Cloze | 10 | 80% |

Each eval folder contains:
- `prompt.txt` — validator prompt (LLM judges question quality)
- `eval_tests.yaml` — positive test cases (valid questions)
- `testing_tests.yaml` — negative test cases (deliberately flawed questions)
- `promptfooconfig.yaml` — provider config (Claude Haiku via OpenRouter)

---

## Quick Reference

| Task | Command |
|---|---|
| Start backend | `backend\venv\Scripts\python.exe -m uvicorn backend.api_server:app --reload --port 8000` |
| Start frontend | `cd frontend && npm run dev` |
| Open app | http://localhost:5173 |
| Start DB container | `docker start graded-questions-generation` |
| Check DB questions | `docker exec graded-questions-generation psql -U postgres -d questions_db -c "SELECT COUNT(*) FROM questions;"` |
| Run CLI generator | `backend\venv\Scripts\python.exe generate_questions.py --material <path> --type "Fill in the Blanks" --count 10` |
| Run quality eval | `cd evals\cloze && promptfoo eval --no-cache` |

---

## Troubleshooting

### "API key not set in .env" (amber badge)
Open `.env`, set `OPENROUTER_API_KEY=sk-or-v1-...`, restart the backend.

### "Credit balance too low"
Top up at https://openrouter.ai/credits

### Backend not starting / Question Bank shows "Database not connected"
Start Docker Desktop, then:
```powershell
docker start graded-questions-generation
```

### Google Sheets — "Error 403: access_denied"
Add your Google account as a test user in Google Cloud Console → OAuth consent screen → Test users.

### Frontend blank page
```powershell
cd frontend && npm install && npm run dev
```

### Memory error on Render (sentence-transformers)
Upgrade to Render Starter plan ($7/month) for dedicated 512MB RAM. The `all-MiniLM-L6-v2` embedding model requires ~450MB at runtime.

### Questions not saving to DB
Verify Docker container is running:
```powershell
docker ps --filter name=graded-questions-generation
```
