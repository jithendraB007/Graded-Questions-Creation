"""
sheets.py — Google Sheets integration for GA Question Generator dashboard.

Sheet layout
============
"Questions Log"  : one row per generated question (time-ordered, appended)
"Feedback Log"   : only rejected questions + feedback notes
"Dashboard"      : aggregate stats, rewritten on every log call
"""

import io
import json
import os
import threading
import traceback
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",        # full Drive access — needed to upload to existing folders
]

DRIVE_FOLDER_ID = "14u-d7H6Zq1KH3LuOoo6k6uDySTm92Aer"

ROOT        = Path(__file__).parent.parent.parent   # d:\GA
CREDS_DIR   = ROOT / "credentials"
SECRET_FILE = CREDS_DIR / "client_secret.json"
TOKEN_FILE  = CREDS_DIR / "token.json"
CONFIG_FILE = CREDS_DIR / "sheets_config.json"

LOG_HEADERS = [
    "Timestamp", "Course", "Module No.", "Module Name", "Topic",
    "Question Type", "Difficulty", "Bloom Level", "Course Outcome",
    "Question", "Solution", "Status", "Feedback",
]
FB_HEADERS = [
    "Timestamp", "Course", "Module Name", "Topic",
    "Question Type", "Difficulty", "Bloom Level",
    "Question", "Solution", "Status", "Feedback Note",
]


def _on_render() -> bool:
    """True when running on Render.com (browser OAuth not possible)."""
    return bool(os.environ.get("RENDER") or os.environ.get("GOOGLE_TOKEN"))


class SheetsClient:

    def __init__(self):
        self._service     = None
        self._auth_status = "unauthenticated"
        self._auth_error  = ""
        self._lock        = threading.Lock()
        # Auto-load from GOOGLE_TOKEN env var at startup (Render / production)
        if os.environ.get("GOOGLE_TOKEN") and not TOKEN_FILE.exists():
            try:
                creds = self._load_creds()
                if creds:
                    self._auth_status = "ready"
                else:
                    self._auth_status = "error"
                    self._auth_error  = "GOOGLE_TOKEN is set but could not be loaded — check the JSON format in Render env vars."
            except Exception as e:
                self._auth_status = "error"
                self._auth_error  = f"GOOGLE_TOKEN load failed: {e}"

    # ── Auth ──────────────────────────────────────────────────────────────────

    def _load_creds(self):
        # Prefer file (local dev); fall back to GOOGLE_TOKEN env var (Render/production)
        if TOKEN_FILE.exists():
            token_str = TOKEN_FILE.read_text(encoding="utf-8")
        else:
            token_str = os.environ.get("GOOGLE_TOKEN", "")
        if not token_str:
            return None
        try:
            creds = Credentials.from_authorized_user_info(json.loads(token_str), SCOPES)
            # Auto-delete/ignore token if it was created with a narrower scope set
            if creds.scopes and not all(s in creds.scopes for s in SCOPES):
                TOKEN_FILE.unlink(missing_ok=True)
                self._auth_status = "unauthenticated"
                return None
            if creds.valid:
                return creds
            if creds.expired and creds.refresh_token:
                creds.refresh(Request())
                try:
                    TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
                except Exception:
                    pass  # read-only filesystem on Render — refreshed creds still work in memory
                return creds
        except Exception as e:
            self._auth_error = f"Token refresh failed: {e}"
        return None

    @property
    def auth_status(self):
        if self._auth_status == "authenticating":
            return "authenticating"
        # Always try to load creds — allows recovery after a previous error
        creds = self._load_creds()
        if creds:
            return "ready"
        return self._auth_status if self._auth_status == "error" else "unauthenticated"

    def start_auth(self):
        with self._lock:
            if self._auth_status == "authenticating":
                return {"status": "authenticating", "message": "Auth already in progress."}
            if self.auth_status == "ready":
                return {"status": "ready", "message": "Already authenticated."}
            # On Render/production the browser OAuth flow is not possible
            if _on_render():
                return {
                    "status": "error",
                    "message": (
                        "Running on Render — browser sign-in is not supported on the server. "
                        "Set GOOGLE_TOKEN and GOOGLE_CLIENT_SECRET in Render → Environment."
                    ),
                }
            has_secret = SECRET_FILE.exists() or os.environ.get("GOOGLE_CLIENT_SECRET")
            if not has_secret:
                return {"status": "error", "message": "client_secret.json not found in credentials/."}
            if TOKEN_FILE.exists():
                TOKEN_FILE.unlink()
            self._auth_status = "authenticating"
            self._auth_error  = ""

        threading.Thread(target=self._run_flow, daemon=True).start()
        return {"status": "authenticating", "message": "Browser opened for Google sign-in…"}

    def _run_flow(self):
        try:
            secret_env = os.environ.get("GOOGLE_CLIENT_SECRET", "")
            if secret_env:
                flow = InstalledAppFlow.from_client_config(json.loads(secret_env), SCOPES)
            else:
                flow = InstalledAppFlow.from_client_secrets_file(str(SECRET_FILE), SCOPES)
            creds = flow.run_local_server(port=0, open_browser=True)
            CREDS_DIR.mkdir(parents=True, exist_ok=True)
            try:
                TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
            except Exception:
                pass
            self._service     = None
            self._auth_status = "ready"
        except Exception as e:
            self._auth_status = "error"
            self._auth_error  = f"OAuth failed: {e}\n{traceback.format_exc()}"

    # ── Service ───────────────────────────────────────────────────────────────

    def _svc(self):
        creds = self._load_creds()
        if not creds:
            raise RuntimeError("Not authenticated. Complete Google sign-in first.")
        # Rebuild service whenever the access token changes (handles token refresh on Render
        # where _load_creds() creates a new Credentials object from the env var each time).
        current_token = getattr(creds, "token", None)
        if not self._service or getattr(self, "_cached_token", None) != current_token:
            self._service     = build("sheets", "v4", credentials=creds)
            self._cached_token = current_token
        return self._service

    # ── Config ────────────────────────────────────────────────────────────────

    def _cfg(self):
        if CONFIG_FILE.exists():
            try:
                return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            except Exception:
                pass
        # Fall back to env var (Render/production — config file not on server)
        sid = os.environ.get("GOOGLE_SPREADSHEET_ID", "")
        if sid:
            return {
                "spreadsheet_id":  sid,
                "spreadsheet_url": f"https://docs.google.com/spreadsheets/d/{sid}/edit",
            }
        return {}

    def _save_cfg(self, d):
        try:
            CREDS_DIR.mkdir(parents=True, exist_ok=True)
            CONFIG_FILE.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass  # read-only filesystem on Render — ID already comes from env var

    def get_spreadsheet_info(self):
        cfg = self._cfg()
        return {
            "spreadsheet_id":  cfg.get("spreadsheet_id", ""),
            "spreadsheet_url": cfg.get("spreadsheet_url", ""),
        }

    # ── Spreadsheet bootstrap ─────────────────────────────────────────────────

    def _ensure_sheet(self):
        """Return spreadsheet_id, creating and bootstrapping if needed."""
        cfg = self._cfg()
        sid = cfg.get("spreadsheet_id", "")
        if sid:
            return sid

        svc  = self._svc()
        body = {
            "properties": {"title": "GA Question Generator — Dashboard"},
            "sheets": [
                {"properties": {"title": "Questions Log",  "index": 0}},
                {"properties": {"title": "Feedback Log",   "index": 1}},
                {"properties": {"title": "Dashboard",      "index": 2}},
            ],
        }
        result = svc.spreadsheets().create(body=body, fields="spreadsheetId").execute()
        sid    = result["spreadsheetId"]
        url    = f"https://docs.google.com/spreadsheets/d/{sid}/edit"
        self._save_cfg({"spreadsheet_id": sid, "spreadsheet_url": url})

        # Write headers
        batch = [
            {"range": "Questions Log!A1",
             "values": [LOG_HEADERS]},
            {"range": "Feedback Log!A1",
             "values": [FB_HEADERS]},
        ]
        svc.spreadsheets().values().batchUpdate(
            spreadsheetId=sid,
            body={"valueInputOption": "RAW", "data": batch},
        ).execute()

        # Bold + colour the header rows
        meta     = svc.spreadsheets().get(spreadsheetId=sid).execute()
        id_map   = {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta["sheets"]}
        requests = []
        for name, ncols in [("Questions Log", len(LOG_HEADERS)),
                             ("Feedback Log",  len(FB_HEADERS)),
                             ("Dashboard",     6)]:
            sid2 = id_map.get(name)
            if sid2 is None:
                continue
            requests.append({"repeatCell": {
                "range": {"sheetId": sid2, "startRowIndex": 0, "endRowIndex": 1,
                           "startColumnIndex": 0, "endColumnIndex": ncols},
                "cell": {"userEnteredFormat": {
                    "backgroundColor": {"red": 0.122, "green": 0.306, "blue": 0.475},
                    "textFormat": {"bold": True,
                                   "foregroundColor": {"red": 1, "green": 1, "blue": 1}},
                }},
                "fields": "userEnteredFormat(backgroundColor,textFormat)",
            }})
            requests.append({"updateSheetProperties": {
                "properties": {"sheetId": sid2, "gridProperties": {"frozenRowCount": 1}},
                "fields": "gridProperties.frozenRowCount",
            }})
        if requests:
            svc.spreadsheets().batchUpdate(
                spreadsheetId=sid, body={"requests": requests}
            ).execute()

        return sid

    # ── Log questions ─────────────────────────────────────────────────────────

    def log_questions(self, questions: list[dict]) -> dict:
        if not questions:
            return {"logged": 0, "feedback_logged": 0, "spreadsheet_url": self._cfg().get("spreadsheet_url", "")}

        sid = self._ensure_sheet()
        svc = self._svc()
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

        log_rows = []
        fb_rows  = []
        for q in questions:
            status = q.get("status", "pending")
            row = [
                now,
                q.get("course_display", q.get("course", "")),
                (q.get("module_id", "") or "").split("_")[-1],
                q.get("module_display", ""),
                q.get("topic_display", ""),
                q.get("question_type", ""),
                q.get("difficulty", ""),
                q.get("bloom", ""),
                q.get("course_outcome", ""),
                q.get("question", ""),
                q.get("solution", ""),
                status,
                q.get("feedback", ""),
            ]
            log_rows.append(row)

            # Also write rejected/reviewed items to Feedback Log
            if status in ("rejected", "approved") and q.get("feedback", "").strip():
                fb_rows.append([
                    now,
                    q.get("course_display", q.get("course", "")),
                    q.get("module_display", ""),
                    q.get("topic_display", ""),
                    q.get("question_type", ""),
                    q.get("difficulty", ""),
                    q.get("bloom", ""),
                    q.get("question", ""),
                    q.get("solution", ""),
                    status,
                    q.get("feedback", ""),
                ])

        # Append to Questions Log
        svc.spreadsheets().values().append(
            spreadsheetId=sid,
            range="Questions Log!A1",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={"values": log_rows},
        ).execute()

        # Append to Feedback Log (only if there are feedback rows)
        if fb_rows:
            svc.spreadsheets().values().append(
                spreadsheetId=sid,
                range="Feedback Log!A1",
                valueInputOption="RAW",
                insertDataOption="INSERT_ROWS",
                body={"values": fb_rows},
            ).execute()

        self._refresh_dashboard(svc, sid)
        cfg = self._cfg()
        return {
            "logged":          len(log_rows),
            "feedback_logged": len(fb_rows),
            "spreadsheet_url": cfg.get("spreadsheet_url", ""),
        }

    # ── Dashboard sheet ───────────────────────────────────────────────────────

    def _refresh_dashboard(self, svc, sid):
        result  = svc.spreadsheets().values().get(
            spreadsheetId=sid, range="Questions Log!A2:M"
        ).execute()
        rows    = result.get("values", [])

        def parse(r):
            r = r + [""] * (len(LOG_HEADERS) - len(r))
            return {LOG_HEADERS[i]: r[i] for i in range(len(LOG_HEADERS))}

        recs     = [parse(r) for r in rows if any(c.strip() for c in r)]
        total    = len(recs)
        status_c = Counter(r.get("Status", "pending") for r in recs)
        diff_c   = Counter(r.get("Difficulty",     "") for r in recs)
        bloom_c  = Counter(r.get("Bloom Level",    "") for r in recs)
        type_c   = Counter(r.get("Question Type",  "") for r in recs)
        course_c = Counter(r.get("Course",         "") for r in recs)

        mod_data: dict[str, dict] = defaultdict(lambda: {"topics": set(), "count": 0})
        for r in recs:
            mod = r.get("Module Name", "")
            mod_data[mod]["topics"].add(r.get("Topic", ""))
            mod_data[mod]["count"] += 1

        apv_pct  = round(status_c.get("approved", 0) / total * 100) if total else 0
        now      = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

        dash = [
            ["GA Question Generator — Dashboard", "", "", "", "", ""],
            [f"Last updated: {now}", "", "", "", "", ""],
            [""],
            ["── SUMMARY ──────────────────────────"],
            ["Total Questions", total, "", "Approved",  status_c.get("approved", 0),  f"{apv_pct}%"],
            ["",                "",    "", "Pending",   status_c.get("pending",  0),  ""],
            ["",                "",    "", "Rejected",  status_c.get("rejected", 0),  ""],
            [""],
            ["── BY DIFFICULTY ──────"],
        ]
        for d in ["Easy", "Medium", "Hard"]:
            dash.append([d, diff_c.get(d, 0), "", "", "", ""])

        dash += [[""], ["── BY BLOOM LEVEL ──────"]]
        for k in ["K1", "K2", "K3", "K4", "K5", "K6"]:
            dash.append([k, bloom_c.get(k, 0), "", "", "", ""])

        dash += [[""], ["── BY QUESTION TYPE ──────", "", "", "── BY COURSE ──────"]]
        type_list   = list(type_c.most_common())
        course_list = list(course_c.most_common())
        for i in range(max(len(type_list), len(course_list))):
            t  = type_list[i]   if i < len(type_list)   else ("", "")
            cr = course_list[i] if i < len(course_list) else ("", "")
            dash.append([t[0], t[1] or "", "", cr[0], cr[1] or "", ""])

        dash += [[""], ["── MODULE BREAKDOWN ──────────────────────────────────────"],
                 ["Module Name", "Topics", "Questions", "% of Total", "", ""]]
        for mod, info in sorted(mod_data.items()):
            pct = round(info["count"] / total * 100) if total else 0
            dash.append([mod, len(info["topics"]), info["count"], f"{pct}%", "", ""])

        svc.spreadsheets().values().clear(spreadsheetId=sid, range="Dashboard!A:F").execute()
        svc.spreadsheets().values().update(
            spreadsheetId=sid,
            range="Dashboard!A1",
            valueInputOption="RAW",
            body={"values": dash},
        ).execute()

    # ── Stats for frontend ────────────────────────────────────────────────────

    def get_stats(self):
        cfg = self._cfg()
        sid = cfg.get("spreadsheet_id", "")
        if not sid:
            return {"total": 0, "message": "No spreadsheet yet."}

        svc    = self._svc()
        result = svc.spreadsheets().values().get(
            spreadsheetId=sid, range="Questions Log!A2:M"
        ).execute()
        rows   = result.get("values", [])

        def parse(r):
            r = r + [""] * (len(LOG_HEADERS) - len(r))
            return {LOG_HEADERS[i]: r[i] for i in range(len(LOG_HEADERS))}

        recs     = [parse(r) for r in rows if any(c.strip() for c in r)]
        total    = len(recs)
        status_c = Counter(r.get("Status",         "pending") for r in recs)
        diff_c   = Counter(r.get("Difficulty",     "")        for r in recs)
        bloom_c  = Counter(r.get("Bloom Level",    "")        for r in recs)
        type_c   = Counter(r.get("Question Type",  "")        for r in recs)
        course_c = Counter(r.get("Course",         "")        for r in recs)
        co_c     = Counter(r.get("Course Outcome", "")        for r in recs)

        # Time-series: group by date
        date_c: Counter = Counter()
        for r in recs:
            ts = r.get("Timestamp", "")
            if ts:
                date_c[ts[:10]] += 1   # YYYY-MM-DD

        mod_data: dict[str, dict] = defaultdict(lambda: {"topics": set(), "count": 0})
        for r in recs:
            mod = r.get("Module Name", "")
            mod_data[mod]["topics"].add(r.get("Topic", ""))
            mod_data[mod]["count"] += 1

        return {
            "total":       total,
            "status":      dict(status_c),
            "by_difficulty": {k: diff_c.get(k, 0) for k in ["Easy", "Medium", "Hard"]},
            "by_bloom":      {k: bloom_c.get(k, 0) for k in ["K1","K2","K3","K4","K5","K6"]},
            "by_type":       dict(type_c.most_common()),
            "by_course":     dict(course_c.most_common()),
            "by_co":         dict(co_c.most_common()),
            "by_date":       dict(sorted(date_c.items())),
            "by_module":     {
                mod: {"topic_count": len(v["topics"]), "question_count": v["count"]}
                for mod, v in sorted(mod_data.items())
            },
            "spreadsheet_url": cfg.get("spreadsheet_url", ""),
            "spreadsheet_id":  cfg.get("spreadsheet_id",  ""),
        }


    def bulk_approve(self) -> dict:
        """Mark every 'pending' row in Questions Log as 'approved'."""
        sid = self._ensure_sheet()
        svc = self._svc()

        result = svc.spreadsheets().values().get(
            spreadsheetId=sid, range="Questions Log!A2:M"
        ).execute()
        rows = result.get("values", [])

        # Status column = index 11 (column L)
        updates = []
        for i, row in enumerate(rows):
            status = row[11] if len(row) > 11 else ""
            if status in ("pending", ""):
                sheet_row = i + 2   # +1 for header, +1 for 1-indexing
                updates.append({"range": f"Questions Log!L{sheet_row}", "values": [["approved"]]})

        if updates:
            svc.spreadsheets().values().batchUpdate(
                spreadsheetId=sid,
                body={"valueInputOption": "RAW", "data": updates},
            ).execute()
            self._refresh_dashboard(svc, sid)

        return {"updated": len(updates)}

    # ── Google Drive upload ───────────────────────────────────────────────────

    def upload_excel_to_drive(self, file_bytes: bytes, filename: str) -> tuple[str, str]:
        """Upload an Excel file to the project Drive folder.
        Returns (web_view_link, error_message). On success error is ''.
        """
        creds = self._load_creds()
        if not creds:
            return "", "Not authenticated. Sign in via the Dashboard first."
        try:
            drive_svc = build("drive", "v3", credentials=creds)
            metadata  = {"name": filename, "parents": [DRIVE_FOLDER_ID]}
            media     = MediaIoBaseUpload(
                io.BytesIO(file_bytes),
                mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                resumable=False,
            )
            result = drive_svc.files().create(
                body=metadata,
                media_body=media,
                fields="id,webViewLink",
                supportsAllDrives=True,     # required for Shared Drive folders
            ).execute()
            return result.get("webViewLink", ""), ""
        except Exception as e:
            err = str(e)
            self._auth_error = f"Drive upload failed: {err}"
            return "", err


sheets_client = SheetsClient()
