# TASK 29: Create Integration Test — Full-Text Search

**File to create:** `/tests/query-fulltext.test.js`

**Purpose:** Verify that full-text search works correctly across all text properties with relevance ranking, fuzzy matching, and highlighting.

**Test data requirement:** The test employees must include: "Melissa Chang" (Engineering), "Diego Rodriguez" (Sales), "Akriti Patel" (Engineering), "Michael O'Brien" (Marketing), "Jean-Pierre Habimana" (Finance). Diverse names to test tokenization, special characters, and cross-field matching.

**Test cases:**

1. `test_search_by_name` — searchFullText "melissa" → Melissa Chang is first result
2. `test_search_by_multiple_terms` — searchFullText "melissa engineering" → Melissa Chang (terms across fullName AND department)
3. `test_search_by_id` — searchFullText "EMP-001" → exact match on primary key, boosted to top
4. `test_fuzzy_matching` — searchFullText "melisa" (typo) → still finds Melissa Chang
5. `test_special_characters` — searchFullText "O'Brien" → finds Michael O'Brien
6. `test_hyphenated_name` — searchFullText "Jean-Pierre" → finds Jean-Pierre Habimana
7. `test_highlights_present` — searchFullText "melissa" → response includes __highlights with <mark> tags
8. `test_with_filter` — searchFullText "melissa" WHERE isActive eq true → filtered full-text search
9. `test_empty_query` — searchFullText "" → 400 error
10. `test_relevance_order` — searchFullText "engineering" → results sorted by _score descending (department match ranks highest based on boost)
