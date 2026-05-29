"""
generate_questions.py — Generate assessment questions from reading material + few-shot samples.

Usage:
    python generate_questions.py --material <path_to_md> --type <question_type> --count <n>
                                 [--bloom L4] [--difficulty Hard] [--co "CO1: ..."]

Examples:
    python generate_questions.py ^
        --material "courses/language_analytics/module_1/topic_5/material/fill_in_the_blanks_single_and_double_and_cloze_test.md" ^
        --type "Cloze" --count 5 --bloom L4 --difficulty Hard

    python generate_questions.py ^
        --material "courses/foundation/module_2/topic_4/material/verb_forms_and_noun_+_helping_verb_agreement.md" ^
        --type "Fill in the Blanks" --count 5 --bloom L3 --difficulty Medium

    python generate_questions.py ^
        --material "courses/foundation/module_2/topic_4/material/verb_forms_and_noun_+_helping_verb_agreement.md" ^
        --type "Error Correction" --count 5 --bloom L4 --difficulty Hard
"""

import argparse
import os
import re
import sys
import uuid
from collections import Counter
from pathlib import Path

import numpy as np
import yaml
from openai import OpenAI

try:
    from sentence_transformers import SentenceTransformer
    from sklearn.metrics.pairwise import cosine_similarity
    from database.queries import (
        fetch_all_questions_from_db,
        check_similarity_in_db,
        check_exact_duplicate_in_db,
        insert_question_to_db,
    )
    from database.sheets_sync import sync_question_to_sheets
    DB_AVAILABLE = True
except Exception:
    DB_AVAILABLE = False

# Lazy singleton — loaded on first use, not at import time
_EMBEDDING_MODEL = None

def _get_embedding_model():
    global _EMBEDDING_MODEL
    if _EMBEDDING_MODEL is None:
        from sentence_transformers import SentenceTransformer
        print("Loading embedding model (first use)...")
        _EMBEDDING_MODEL = SentenceTransformer("all-MiniLM-L6-v2")
    return _EMBEDDING_MODEL

ROOT = Path(__file__).parent
EVALS_DIR = ROOT / "evals"

FOLDER_MAP = {
    # Grammar & Vocabulary
    "Cloze":                    "cloze",
    "Fill in the Blanks":       "fill_in_the_blanks",
    "Error Correction":         "error_correction",
    "Sentence Arrangement":     "sentence_arrangement",
    "Jumbled Sentences":        "jumbled_sentences",
    "Sentence Conversion":      "sentence_conversion",
    "Sentence Correction / MCQ":"sentence_correction_mcq",
    "Jumbled Words":            "jumbled_words",
    # Reading
    "Higher-order Comprehension":          "reading_higher_order",
    "Literal & Inferential Comprehension": "reading_literal_inferential",
    "Choice-based Comprehension":          "reading_choice_based",
    # Writing
    "Short Functional Writing": "writing_short_functional",
    "Essay Writing":            "writing_essay",
    "Story Writing":            "writing_story",
    "Process Writing":          "writing_process",
    "Email Writing":            "writing_email",
    "Notice Writing":           "writing_notice",
    "Report Writing":           "writing_report",
    "Paragraph Writing":        "writing_paragraph",
}

# CO → fraction of questions targeting the HIGHER K-level within the difficulty band.
# CO1 (K1-K3 focus) → prefers lower end; CO5 → prefers higher end.
CO_BLOOM_FOCUS: dict[int, float] = {1: 0.0, 2: 0.25, 3: 0.5, 4: 0.75, 5: 1.0}

# Each difficulty band has two K-levels: (lower, higher)
DIFF_K_LEVELS: dict[str, tuple[str, str]] = {
    "Easy":   ("K1", "K2"),
    "Medium": ("K3", "K4"),
    "Hard":   ("K5", "K6"),
}

_K_DESC: dict[str, str] = {
    "K1": "Remember",
    "K2": "Understand",
    "K3": "Apply",
    "K4": "Analyze",
    "K5": "Evaluate",
    "K6": "Create",
}


def compute_bloom_targets(co: str, difficulty: str, count: int) -> list[str]:
    """Return a list of K-level strings (length == count) for the given CO and difficulty.

    Rules:
    - Extract CO number from strings like "CO1", "CO3".  Default to CO3 (middle).
    - focus = CO_BLOOM_FOCUS[co_num]: fraction of questions targeting the higher K.
    - When count >= 3, enforce at least 1 of each K-level (variety).
    - When count < 3, the focus ratio governs strictly (CO1 Hard=2 → [K5,K5]).
    """
    import re as _re
    m = _re.match(r"CO(\d+)", co or "", _re.IGNORECASE)
    co_num = int(m.group(1)) if m else 3
    focus = CO_BLOOM_FOCUS.get(co_num, 0.5)

    lower_k, higher_k = DIFF_K_LEVELS.get(difficulty, ("K3", "K4"))

    higher_count = round(count * focus)
    if count >= 3:
        higher_count = max(1, min(count - 1, higher_count))
    lower_count = count - higher_count

    return [lower_k] * lower_count + [higher_k] * higher_count

TYPE_PROMPTS = {
    "Cloze": """
Each question must be a single coherent paragraph of 5–7 sentences on ONE clear topic
drawn from the reading material. The paragraph must flow logically from start to finish
(introduction → development → conclusion) and read as natural English.

Place EXACTLY 4 numbered blanks (i)–(iv) spread across DIFFERENT sentences in the paragraph
(no two blanks in the same sentence). Each blank must replace a key content word — NOT a
function word (no articles, prepositions, conjunctions, or pronouns).

Each blank offers TWO bracket options: one noun form and one verb form derived from the
SAME base word (i.e. morphological variants of a single root).
  Correct example:  (i)_________________ (analysis / analyze)
  Correct example:  (ii)________________ (production / produce)
  Incorrect example: (analysis / conduct)  ← these are NOT from the same root

Requirements for each blank:
- The correct answer must fit naturally in the sentence — the sentence must be grammatically
  correct and contextually clear with the right word inserted.
- The distractor (wrong form) must be grammatically plausible in isolation but incorrect in
  context, so students must understand whether a noun or verb is required in that position.
- Both options must come from the SAME root word — no random pairings.
- Do NOT put blanks in the title, heading, or first sentence alone.
""",

    "Fill in the Blanks": """
Each question must have EXACTLY 2 numbered blanks (i)–(ii).
Each blank must show ONE base word in brackets — the student derives the correct noun or verb form.
Example format: (i)_________________ (evaluate)
One blank must require a noun form; the other must require a main verb form.
""",

    "Error Correction": """
Each question must be a single sentence containing EXACTLY 2 incorrect words — one noun used
where a verb is needed, and one verb used where a noun is needed.
The instruction must say: "Identify the incorrect words in the sentence and replace them with
the correct forms."
Include the corrected sentence in the solution.
""",

    "Sentence Arrangement": """
Each question must present 4–6 jumbled sentence parts labelled (A), (B), (C), (D) [,(E),(F)].
The student must arrange them into a single coherent sentence.
Provide the correct order in the solution (e.g. "D–B–A–C").
""",

    "Jumbled Sentences": """
Each question must present a set of jumbled sentences (4–6 sentences) that together form a
coherent paragraph. The student must arrange them in the correct order.
Provide the correct sequence in the solution.
""",

    "Sentence Conversion": """
Each question must give ONE complete sentence and ask the student to rewrite it using a
specific grammatical structure (e.g. active → passive, direct → indirect speech).
The instruction must specify the required transformation clearly.
""",

    "Sentence Correction / MCQ": """
Each question must present an INCORRECT sentence containing exactly ONE error — either a noun
used where a main verb is required, or a verb form used where a noun is required.
Provide exactly 4 options labelled i)–iv).
Exactly ONE option must be the grammatically correct version of the sentence fixing the error.
The other three options must use other incorrect forms (different verb forms, base form, or
wrong noun variant) that do NOT fix the error.
The answer key must clearly state which option is correct and explain the grammatical reason.
No other option may also be grammatically acceptable in the same sentence position.
""",

    "Jumbled Words": """
Each question must present a set of jumbled words (5–7 words) that the student rearranges
into exactly ONE clear, meaningful English sentence.
After forming the sentence, the student must:
  1. Identify ALL nouns in the sentence (persons, places, things, or ideas — not adjectives or adverbs).
  2. Identify the main verb — the finite verb showing the primary action (not an adjective,
     adverb, or participial modifier).
The solution must list the correctly rearranged sentence, all nouns, and the main verb.
The explanation must justify each noun (naming function) and the main verb (action function)
using clear grammatical reasoning.
""",

    # ── Reading comprehension types ───────────────────────────────────────────

    "Higher-order Comprehension": """
Each question must test higher-order comprehension skills: analysis, application, inference,
or critical opinion. Questions require thinking beyond the text — there is no single
factually-lookable answer; students must reason and interpret.
The question must be answerable using the reading material as a basis.
Provide a model answer demonstrating analytical thinking (2–3 sentences).
This question type is worth 2 marks.
""",

    "Literal & Inferential Comprehension": """
Each question must test both literal comprehension (facts stated directly in the text) and
inferential comprehension (meaning implied by the text).
The question must clearly refer to or be answerable from the reading passage.
Provide a detailed model answer covering 4–5 key points expected for full marks.
This question type is worth 5 marks.
""",

    "Choice-based Comprehension": """
Each question must offer a CHOICE: the student answers ONE question from two options (a) or (b).
Both (a) and (b) must test comprehension of the reading passage from different angles.
Provide detailed model answers for BOTH options (a) and (b) — each a full paragraph.
This question type is worth 7 marks.
""",

    # ── Writing types ─────────────────────────────────────────────────────────

    "Short Functional Writing": """
Each question must ask the student to produce a short functional piece of writing:
a brief notice, a short message, an informal note, or a short description (3–5 sentences).
Provide a complete model answer demonstrating the key functional elements.
This question type is worth 3 marks.
""",

    "Essay Writing": """
Each question must ask the student to write a short essay (approximately 150–200 words) on a
topic drawn from the themes or content of the reading material.
Provide a model essay outline or a brief model essay as the solution.
This question type is worth 5 marks.
""",

    "Story Writing": """
Each question must provide a story opening (2–3 sentences) or a story outline (3–4 bullet points)
and ask the student to complete or write the story (approximately 100–150 words).
The story context must relate to reading material themes.
Provide a complete model story completion as the solution.
This question type is worth 5 marks.
""",

    "Process Writing": """
Each question must ask the student to explain a process or describe a sequence of steps clearly
(e.g. how to do something, how something works, how something is produced).
The process must be related to the reading material content.
Provide a model answer with clear, numbered sequential steps.
This question type is worth 7 marks.
""",

    "Email Writing": """
Each question must present a workplace or real-life scenario requiring the student to write
a formal or semi-formal email.
Specify clearly: who the email is to, who it is from, and the purpose.
The model answer MUST include: Subject line, Salutation, Body (2–3 paragraphs), Closing, Sender name.
This question type is worth 8 marks.
""",

    "Notice Writing": """
Each question must present a scenario requiring the student to write a formal notice.
The notice MUST include: Heading (NOTICE), Date, Target audience, Body content, Name and Designation.
Provide a complete model notice as the solution.
This question type is worth 8 marks.
""",

    "Report Writing": """
Each question must present a workplace scenario requiring the student to write a formal work report.
The report MUST include: Title, Date, To/From, Introduction, Findings/Body, Conclusion, Writer's name.
Provide a complete model report as the solution.
This question type is worth 8 marks.
""",

    "Paragraph Writing": """
Each question must present a CHOICE of two topics for paragraph writing (a) or (b).
The student writes ONE well-developed paragraph (approximately 200–250 words) on their chosen topic.
Both topics must relate to themes or content from the reading material.
Provide a complete model paragraph for BOTH options (a) and (b).
This question type is worth 14 marks — the paragraph must be substantive and well-organised.
""",
}


def load_material(path: str) -> str:
    full = ROOT / path if not Path(path).is_absolute() else Path(path)
    if not full.exists():
        sys.exit(f"Material file not found: {full}")
    text = full.read_text(encoding="utf-8")
    # Strip XML-style tags that appear in some material files
    import re
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def load_samples(question_type: str) -> list[dict]:
    folder = FOLDER_MAP.get(question_type)
    if not folder:
        return []
    eval_file = EVALS_DIR / folder / "eval_tests.yaml"
    if not eval_file.exists():
        return []
    raw = yaml.safe_load(eval_file.read_text(encoding="utf-8"))
    if not raw:
        return []
    return [item.get("vars", {}) for item in raw if isinstance(item, dict)]


def format_samples(samples: list[dict]) -> str:
    if not samples:
        return "No sample questions available for this type yet."
    lines = []
    for i, s in enumerate(samples[:5], 1):
        lines.append(f"--- SAMPLE {i} ---")
        lines.append(f"Question:\n{s.get('question', '').strip()}")
        lines.append(f"\nSolution:\n{s.get('solution', '').strip()}")
        lines.append(f"\nExplanation:\n{s.get('explanation', '').strip()}")
        lines.append("")
    return "\n".join(lines)


def build_diversity_log(questions):
    """
    Builds a summary of what already exists.
    Passed to LLM prompt every call to force diversity.
    """
    if not questions:
        return {
            "connectors_used":           [],
            "domains_used":              [],
            "sentence_starters_used":    [],
            "correct_answer_positions":  [],
            "question_count":            0
        }

    connectors = []
    domains    = []
    starters   = []
    positions  = []

    for q in questions:
        if q.get("correct_answer"):
            connectors.append(str(q["correct_answer"]).lower().strip())
        if q.get("domain"):
            domains.append(q["domain"])
        if q.get("question_text"):
            first_word = q["question_text"].strip().split()[0].lower()
            starters.append(first_word)
        if q.get("correct_answer_position"):
            positions.append(q["correct_answer_position"])

    return {
        "connectors_used":           list(Counter(connectors).most_common(10)),
        "domains_used":              list(set(domains)),
        "sentence_starters_used":    list(set(starters)),
        "correct_answer_positions":  list(Counter(positions).most_common()),
        "question_count":            len(questions)
    }


def update_diversity_log(log, new_question):
    """Updates diversity log after each accepted question."""
    if new_question.get("correct_answer"):
        connector = str(new_question["correct_answer"]).lower().strip()
        existing = dict(log["connectors_used"])
        existing[connector] = existing.get(connector, 0) + 1
        log["connectors_used"] = sorted(
            existing.items(), key=lambda x: x[1], reverse=True
        )

    if new_question.get("domain"):
        log["domains_used"] = list(
            set(log["domains_used"] + [new_question["domain"]])
        )

    if new_question.get("question_text"):
        first_word = new_question["question_text"].strip().split()[0].lower()
        log["sentence_starters_used"] = list(
            set(log["sentence_starters_used"] + [first_word])
        )

    if new_question.get("correct_answer_position"):
        positions = dict(log["correct_answer_positions"])
        pos = new_question["correct_answer_position"]
        positions[pos] = positions.get(pos, 0) + 1
        log["correct_answer_positions"] = sorted(
            positions.items(), key=lambda x: x[1], reverse=True
        )

    log["question_count"] += 1
    return log


def _parse_raw_to_dicts(raw: str, question_type: str, difficulty: str,
                        domain: str) -> list[dict]:
    """Parses LLM output blocks into question dicts for DB insertion."""
    blocks = re.split(r"={3,}\s*QUESTION\s+\d+\s*={3,}", raw, flags=re.IGNORECASE)
    results = []
    for block in blocks:
        block = block.strip()
        if not block:
            continue

        def extract(label: str) -> str:
            m = re.search(
                rf"{label}:\s*\n(.*?)(?=\n(?:Question|Solution|Explanation|Bloom):|$)",
                block, re.DOTALL | re.IGNORECASE,
            )
            return m.group(1).strip() if m else ""

        q_text = extract("Question")
        solution = extract("Solution")
        explanation = extract("Explanation")
        if not q_text:
            continue

        # Extract instructions line if present
        instructions = None
        m = re.match(r"^(Instruction[^:\n]*:[^\n]+)\n", q_text, re.IGNORECASE)
        if m:
            instructions = m.group(1).strip()

        # Extract correct_answer_position from solution (e.g. "i)", "A", "B")
        pos_match = re.search(r"\b([ABCDabcd]|[ivIV]+)\b(?:\)|\.|:)", solution)
        correct_answer_position = pos_match.group(1).upper() if pos_match else None

        results.append({
            "question_id":             str(uuid.uuid4()),
            "question_type":           question_type,
            "question_text":           q_text,
            "instructions":            instructions,
            "options":                 None,
            "correct_answer":          solution,
            "correct_answer_position": correct_answer_position,
            "explanation":             explanation,
            "difficulty":              difficulty,
            "domain":                  domain,
            "question_purpose":        None,
            "tags":                    None,
            "schema_type":             None,
        })
    return results


def generate_chunk(
    client,
    material: str,
    samples: list[dict],
    count: int,
    question_type: str,
    topic: str,
    bloom: str,
    difficulty: str,
    course_outcome: str,
    model: str,
    marks: int = 2,
    diversity_log: dict | None = None,
    bloom_targets: list[str] | None = None,
) -> list[dict]:
    """Generates one chunk of questions via LLM and returns parsed dicts."""
    prompt = build_prompt(
        material=material,
        question_type=question_type,
        count=count,
        bloom=bloom,
        difficulty=difficulty,
        course_outcome=course_outcome,
        samples=samples,
        diversity_log=diversity_log,
        bloom_targets=bloom_targets,
        marks=marks,
    )
    response = client.chat.completions.create(
        model=model,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.choices[0].message.content
    return _parse_raw_to_dicts(raw, question_type, difficulty, topic)


def generate_questions_in_chunks(
    client,
    material: str,
    samples: list[dict],
    total_required: int,
    question_type: str,
    topic: str,
    bloom: str,
    difficulty: str,
    course_outcome: str,
    model: str,
    marks: int = 2,
    chunk_size: int = 5,
    similarity_threshold: float = 0.85,
) -> list[dict]:
    """
    Generates questions in chunks of chunk_size.
    Each candidate is checked against:
      1. Exact text match in DB
      2. Semantic similarity in DB via pgvector
      3. Semantic similarity against questions accepted this session
    Diversity log is updated after each accepted question and passed
    into the LLM prompt to prevent repetition.
    """
    accepted_questions = []
    accepted_embeddings = []

    # Build diversity log from existing DB questions upfront
    existing_questions = fetch_all_questions_from_db(question_type)
    diversity_log = build_diversity_log(existing_questions)

    print(f"Loaded {len(existing_questions)} existing questions from DB.")
    print(f"Generating {total_required} new unique questions...")

    while len(accepted_questions) < total_required:
        remaining = total_required - len(accepted_questions)
        batch_size = min(chunk_size, remaining)

        print(f"\nGenerating chunk of {batch_size} "
              f"({len(accepted_questions)}/{total_required} accepted so far)...")

        batch = generate_chunk(
            client=client,
            material=material,
            samples=samples,
            count=batch_size,
            question_type=question_type,
            topic=topic,
            bloom=bloom,
            difficulty=difficulty,
            course_outcome=course_outcome,
            model=model,
            marks=marks,
            diversity_log=diversity_log,
        )

        for candidate in batch:
            question_text = candidate.get("question_text", "").strip()

            if not question_text:
                print("SKIP: empty question text")
                continue

            # Gate 1: exact duplicate check (fast, no embedding needed)
            if check_exact_duplicate_in_db(question_text, question_type):
                print(f"SKIP (exact DB duplicate): {question_text[:60]}")
                continue

            # Gate 2: compute embedding
            candidate_embedding = _get_embedding_model().encode([question_text])[0]

            # Gate 3: semantic similarity against DB via pgvector
            similar_in_db = check_similarity_in_db(
                candidate_embedding,
                question_type,
                similarity_threshold
            )
            if similar_in_db:
                top = similar_in_db[0]
                print(
                    f"SKIP (DB similar, "
                    f"sim={top['similarity']:.2f}): {question_text[:60]}"
                )
                continue

            # Gate 4: semantic similarity against session questions
            if len(accepted_embeddings) > 0:
                sims = cosine_similarity(
                    [candidate_embedding],
                    np.array(accepted_embeddings)
                )
                if sims.max() > similarity_threshold:
                    print(
                        f"SKIP (session similar, "
                        f"sim={sims.max():.2f}): {question_text[:60]}"
                    )
                    continue

            # All gates passed — accept this question
            db_id = insert_question_to_db(candidate, candidate_embedding)
            sync_question_to_sheets(candidate)

            accepted_questions.append(candidate)
            accepted_embeddings.append(candidate_embedding)
            diversity_log = update_diversity_log(diversity_log, candidate)

            print(
                f"ACCEPTED ({len(accepted_questions)}/{total_required}): "
                f"{question_text[:60]}"
            )

    print(f"\nDone. {len(accepted_questions)} unique questions generated.")
    return accepted_questions


def build_prompt(material: str, question_type: str, count: int,
                 bloom: str, difficulty: str, course_outcome: str,
                 samples: list[dict],
                 existing_questions: list[str] | None = None,
                 bloom_targets: list[str] | None = None,
                 diversity_log: dict | None = None,
                 marks: int = 2) -> str:

    type_rules = TYPE_PROMPTS.get(question_type, "")
    sample_text = format_samples(samples)

    avoid_section = ""
    if existing_questions:
        lines = "\n".join(f"  • {q[:220].strip()}" for q in existing_questions[:20])
        avoid_section = f"""
══════════════════════════════════════════════
ALREADY GENERATED — DO NOT REPEAT
══════════════════════════════════════════════
The questions below have already been created for this topic.
You MUST use completely different scenarios, sentences, names, and vocabulary.
Do NOT reuse any topic, phrase, or sentence pattern from this list:

{lines}

"""

    # Build Bloom instructions section
    if bloom_targets and len(bloom_targets) == count:
        bloom_lines = "\n".join(
            f"  Q{i+1} → {k}  ({_K_DESC.get(k, '')})"
            for i, k in enumerate(bloom_targets)
        )
        bloom_section = (
            "Per-question Bloom targets — write each question to exactly match its assigned cognitive level:\n"
            f"{bloom_lines}\n\n"
            "  K1 Remember   — recall facts, definitions, forms\n"
            "  K2 Understand — explain, paraphrase, identify\n"
            "  K3 Apply      — use rules in a new context\n"
            "  K4 Analyze    — break down, distinguish, compare\n"
            "  K5 Evaluate   — judge, critique, justify\n"
            "  K6 Create     — produce, construct, compose"
        )
    else:
        bloom_section = (
            f"Bloom's Level  : {bloom}\n\n"
            "  K1 Remember   — recall facts, definitions, forms\n"
            "  K2 Understand — explain, paraphrase, identify\n"
            "  K3 Apply      — use rules in a new context\n"
            "  K4 Analyze    — break down, distinguish, compare\n"
            "  K5 Evaluate   — judge, critique, justify\n"
            "  K6 Create     — produce, construct, compose"
        )

    diversity_section = ""
    if diversity_log and diversity_log.get("question_count", 0) > 0:
        diversity_section = f"""
══════════════════════════════════════════════
DIVERSITY REQUIREMENTS — READ CAREFULLY BEFORE GENERATING
══════════════════════════════════════════════
You have already generated {diversity_log["question_count"]} questions. You must NOT repeat patterns already overused.

Connectors already used as correct answers — avoid overused ones:
{diversity_log["connectors_used"]}

Domains already covered — use different domains:
{diversity_log["domains_used"]}

Sentence starters already used — do not start questions the same way:
{diversity_log["sentence_starters_used"]}

Correct answer position distribution so far:
{diversity_log["correct_answer_positions"]}

STRICT RULES FOR THIS BATCH:
- Do not use any connector that appears more than 2 times in connectors_used as the correct answer.
- Do not use the same domain as the last 3 questions.
- Distribute correct answer positions evenly across A, B, C, D.
- Each question must test a different logical relationship: causal, concessive, additive, inferential, or contrastive.
- No two questions in this batch may start with the same word.
- Every sentence in every question must sound naturally written by a human, not AI-generated.

"""

    return f"""You are an expert English language assessment designer specialising in {question_type} questions.

{avoid_section}{diversity_section}══════════════════════════════════════════════
READING MATERIAL (source for all questions)
══════════════════════════════════════════════
{material[:7000]}

══════════════════════════════════════════════
QUESTION TYPE RULES — {question_type.upper()}
══════════════════════════════════════════════
{type_rules.strip()}

══════════════════════════════════════════════
SAMPLE QUESTIONS (follow this format exactly)
══════════════════════════════════════════════
{sample_text}

══════════════════════════════════════════════
YOUR TASK
══════════════════════════════════════════════
Generate EXACTLY {count} new {question_type} question(s) — {marks} mark(s) each.

CRITICAL: You MUST output ALL {count} questions numbered QUESTION 1 through QUESTION {count}.
Do NOT stop early — every question block is required.

Parameters:
  - Difficulty     : {difficulty}
  - Marks          : {marks}
  - Course Outcome : {course_outcome}

{bloom_section}

Rules:
  - All scenarios must be inspired by or drawn from the reading material above.
  - Do NOT copy the sample questions — create entirely new scenarios.
  - Follow the exact format of the samples for question, solution, and explanation.
  - The explanation must justify each answer using grammatical reasoning
    (e.g. "follows the adjective", "main verb showing the action performed by").
  - Do NOT mention Bloom's Taxonomy, K-level, cognitive level, or any taxonomy label
    in the Question, Solution, or Explanation sections — only in the final "Bloom Level:" field.

Output each question using this EXACT structure (do NOT omit any field):

========================================
QUESTION [n]
========================================
Question:
<full question including instruction line>

Solution:
<answer(s)>

Explanation:
<grammatical justification>

Bloom Level: K[1-6]
"""


def main():
    parser = argparse.ArgumentParser(description="Generate assessment questions")
    parser.add_argument("--material", required=True,
                        help="Path to reading material .md (relative to project root or absolute)")
    parser.add_argument("--type", required=True,
                        help=f"Question type. Options: {', '.join(FOLDER_MAP.keys())}")
    parser.add_argument("--count", type=int, default=5, help="Number of questions (default 5)")
    parser.add_argument("--bloom", default="L4", help="Bloom's level: L1–L6 (default L4)")
    parser.add_argument("--difficulty", default="Medium",
                        help="Easy | Medium | Hard | Medium to Hard (default Medium)")
    parser.add_argument("--co", default="CO1", help="Course outcome string (default CO1)")
    parser.add_argument("--model", default="anthropic/claude-sonnet-4-5",
                        help="OpenRouter model ID (default anthropic/claude-sonnet-4-5)")
    parser.add_argument("--chunk-size", type=int, default=5,
                        help="Questions per LLM call when using chunked mode (default 5)")
    parser.add_argument("--similarity-threshold", type=float, default=0.85,
                        help="Cosine similarity threshold for dedup (default 0.85)")
    args = parser.parse_args()

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        env_file = ROOT / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("OPENROUTER_API_KEY="):
                    api_key = line.split("=", 1)[1].strip()
                    os.environ["OPENROUTER_API_KEY"] = api_key
                    break
        if not api_key:
            sys.exit("OPENROUTER_API_KEY not set. Add it to .env or export it in your shell.")

    print(f"Loading material from: {args.material}")
    material = load_material(args.material)
    print(f"Material loaded — {len(material):,} characters\n")

    samples = load_samples(args.type)
    print(f"Loaded {len(samples)} sample question(s) for '{args.type}'\n")

    client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=api_key)
    topic = Path(args.material).stem  # derive topic label from file name

    # Use chunked dedup pipeline when DB is available, else fall back to single call
    if DB_AVAILABLE:
        similarity_threshold = float(
            os.environ.get("SIMILARITY_THRESHOLD", args.similarity_threshold)
        )
        print(f"Generating {args.count} × '{args.type}' [{args.bloom} / {args.difficulty}] "
              f"with deduplication (threshold={similarity_threshold})...\n")
        questions = generate_questions_in_chunks(
            client=client,
            material=material,
            samples=samples,
            total_required=args.count,
            question_type=args.type,
            topic=topic,
            bloom=args.bloom,
            difficulty=args.difficulty,
            course_outcome=args.co,
            model=args.model,
            chunk_size=args.chunk_size,
            similarity_threshold=similarity_threshold,
        )
        print("\n" + "=" * 60)
        for i, q in enumerate(questions, 1):
            print(f"\n{'='*40}\nQUESTION {i}\n{'='*40}")
            print(f"Question:\n{q['question_text']}\n")
            print(f"Solution:\n{q['correct_answer']}\n")
            print(f"Explanation:\n{q['explanation']}")
        print("=" * 60)
        print(f"\n{len(questions)} unique questions generated and saved to DB.")
    else:
        print(f"[DB not available — running single-call mode]")
        print(f"Generating {args.count} × '{args.type}' question(s) [{args.bloom} / {args.difficulty}]...\n")
        prompt = build_prompt(
            material=material,
            question_type=args.type,
            count=args.count,
            bloom=args.bloom,
            difficulty=args.difficulty,
            course_outcome=args.co,
            samples=samples,
        )
        response = client.chat.completions.create(
            model=args.model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        output = response.choices[0].message.content
        print("=" * 60)
        print(output)
        print("=" * 60)
        print(f"\nTokens used — input: {response.usage.prompt_tokens}, "
              f"output: {response.usage.completion_tokens}")


if __name__ == "__main__":
    main()
