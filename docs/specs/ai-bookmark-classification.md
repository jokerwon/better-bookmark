<!-- canonical-spec-sync -->
# AI 书签智能分类 MVP 规格

## Problem Statement

用户的浏览器书签会随着时间积累，现有文件夹结构难以维护。用户需要逐个阅读、创建文件夹和拖拽书签，整理成本高且容易放弃。

## Solution

构建 Chrome/Edge Manifest V3 浏览器扩展，通过侧边栏让用户选择一个书签根目录，使用用户配置的 OpenAI-compatible API 生成一级分类建议。插件先展示完整预览，用户可以修改分类名称、调整书签归属或取消单项，确认后才创建目录和移动书签。

插件直连用户配置的模型服务，不经过开发方服务器。所有移动均可观察、可恢复；最近一次成功整理支持撤销。MVP 只做书签分类，不做自然语言检索。

## User Stories

1. As a browser user, I want to configure my own OpenAI-compatible API, so that I can use the model provider I trust.
2. As a browser user, I want to save my API Key, Base URL, and model name locally, so that the extension can classify bookmarks without a developer-operated backend.
3. As a browser user, I want the API Key masked in the UI, so that it is not casually exposed.
4. As a browser user, I want to test the model connection with a fixed message containing no bookmark data, so that configuration is validated without leaking bookmarks.
5. As a browser user, I want a privacy acknowledgement before first classification and after Base URL or model changes, so that I understand where bookmark metadata is sent.
6. As a browser user, I want to clear credentials, consent records, and undo state without deleting browser bookmarks.
7. As a browser user, I want to use the classifier in a side panel, so that I can inspect a large preview.
8. As a browser user, I want to choose a supported root folder, so that I control the operation scope.
9. As a browser user, I want the selected root and all descendants, including direct children, included, so that a complete bookmark area can be organized.
10. As a browser user, I want folders, separators, and unsupported nodes left unchanged, so that classification cannot damage my bookmark tree.
11. As a browser user, I want only HTTP(S) bookmarks sent to the model, so that unsupported protocols remain local.
12. As a browser user, I want unsupported or unusable bookmarks listed as “无法分类”, so that I know why they were not moved.
13. As a browser user, I want only title, sanitized URL, and relative folder path sent, so that classification has context without unnecessary disclosure.
14. As a browser user, I want URL credentials, query strings, and fragments removed before transmission, so that tokens and searches are not sent.
15. As a browser user, I want bookmark fields and custom requirements treated as untrusted data, so that embedded instructions cannot override system constraints.
16. As a browser user, I want a configurable category limit defaulting to eight and bounded from three through fifteen, so that the result is maintainable.
17. As a browser user, I want the effective category limit capped by classifiable bookmark count, so that empty categories are not manufactured.
18. As a browser user, I want to enter natural-language classification requirements, so that I can express naming and grouping preferences.
19. As a browser user, I want unsupported destructive requirements ignored and explained, so that text input cannot bypass safety boundaries.
20. As a browser user, I want an empty scope to finish without an API call, so that no cost is incurred when there is nothing to classify.
21. As a browser user, I want local topic summaries followed by a global category-plan step, so that large collections still get a coherent scheme.
22. As a browser user, I want the final category plan frozen before batch assignment, so that batches use the same categories.
23. As a browser user, I want extension-owned category IDs, so that renamed labels cannot change assignment identity.
24. As a browser user, I want duplicate normalized category names rejected, so that folders are unambiguous.
25. As a browser user, I want bounded concurrency and retries for transient failures, so that long operations balance speed and rate-limit risk.
26. As a browser user, I want cancellation to discard incomplete results and prevent movement, so that partial output cannot alter bookmarks.
27. As a browser user, I want progress showing stage, batches, bookmark counts, and retry state, so that I understand a long operation.
28. As a browser user, I want every input bookmark ID to receive exactly one decision, so that no bookmark is silently lost or assigned twice.
29. As a browser user, I want assignment or explicit pending as the only valid decisions, so that uncertainty remains safe.
30. As a browser user, I want malformed responses, unknown IDs, duplicate IDs, missing IDs, and invalid category IDs rejected before movement.
31. As a browser user, I want pending decisions to remain in their original locations.
32. As a browser user, I want a complete preview grouped by target category, with collapsed groups and incremental display, so that 5,000 bookmarks remain usable.
33. As a browser user, I want title/URL filtering and counts for total, moving, unchanged, pending, unclassifiable, and target categories.
34. As a browser user, I want to rename categories, cancel individual bookmarks, batch-reassign selected bookmarks, and delete proposed categories in the preview.
35. As a browser user, I want invalid names and normalized name conflicts to block confirmation until fixed.
36. As a browser user, I want deleting a proposed category to make its bookmarks pending and leave them in place.
37. As a browser user, I want external changes to participating bookmarks to invalidate the complete preview and require full regeneration.
38. As a browser user, I want preview confirmation to be final authorization without a redundant second dialog.
39. As a browser user, I want new folders created only after confirmation, all verified before movement, and empty folders avoided.
40. As a browser user, I want existing normalized sibling folders reused without renaming or altering their existing contents.
41. As a browser user, I want new folders in frozen plan order and moved bookmarks in original traversal order appended after existing target contents.
42. As a browser user, I want failures to stop subsequent movement, attempt recovery, and report conflicts without overwriting later changes.
43. As a browser user, I want successful classification to report actual changes, folders, and undo availability.
44. As a browser user, I want the latest successful operation stored locally for undo after browser restart.
45. As a browser user, I want undo to verify all related nodes and disable the whole undo if any related node changed.
46. As a browser user, I want undo to restore original parents and sibling order by ascending original index, removing only operation-created empty folders.
47. As a browser user, I want failed or disabled undo state retained with reasons until cleared.
48. As a browser user, I want classification and recovery mutually exclusive across extension instances.
49. As a browser user, I want a Chinese MVP interface, so that the first release stays focused.
50. As a browser user, I want a 200-bookmark real-sample quality check and a 5,000-bookmark scale check, so that usefulness and capacity are both measured.

## Implementation Decisions

### Platform and permissions

- Chrome/Edge, Manifest V3, browser side panel.
- Support desktop “书签栏” and “其他书签”; do not process “移动设备书签”.
- Request only bookmarks, local storage, and side-panel permissions. Do not request `<all_urls>`.
- Use only the configured model origin. Require HTTPS; allow HTTP only for localhost or local-network development addresses.

### Data, privacy, and diagnostics

- Use the browser bookmarks API as source of truth. A classifiable bookmark has an HTTP(S) URL. Folders, separators, unsupported protocols, and unusable sanitized URLs remain unchanged.
- Store API configuration, privacy acknowledgement state, operation state, and the latest undo record in local extension storage. Do not sync API keys or undo state. Never send bookmark data through a developer-operated server.
- Never log complete model requests, complete model responses, bookmark metadata, or API keys to console or local logs. Convert API errors to user-readable messages without echoing API keys, Authorization headers, request bodies, response bodies, or other secret-bearing values. Diagnostics, if any, use redacted identifiers and aggregate status only.
- Configuration fields are API Key, Base URL, and model name. Strip trailing slash and append fixed `/chat/completions`; reject Base URLs already containing that path. A real classification requires a successful connection check. The test request contains no bookmark metadata.
- Transmit only title, sanitized HTTP(S) URL, and path relative to the selected root. Remove URL username, password, query, and hash. Chrome/Edge provide no general bookmark notes field; notes are not part of the contract or schema.
- Treat titles, URL-derived values, relative paths, and user requirements as untrusted data. They are classification input, never instructions. The model cannot request destructive operations or exceed one-level classification.

### Classification pipeline and model contract

- Pipeline: collect a stable snapshot; create local topic summaries; merge summaries into a global plan; generate extension-owned category IDs; classify batches against the frozen plan; validate all responses; construct preview.
- Effective category limit is `min(userLimit, classifiableBookmarkCount)`; user limit is 3–15, default 8. No classifiable bookmarks means no model call.
- Normalize category names by trimming, Unicode normalization, and case-insensitive comparison. Duplicate normalized names in the model plan fail classification. Existing normalized sibling matches are reused while preserving the existing display name and contents.
- Topic summaries and category names follow the dominant language of the participating bookmark titles; no language is mandated. A user requirement that specifies a naming language takes precedence. Length limits are script-aware: about 12 Chinese characters or 2–3 words (about 24 characters) for names.
- Invalid model-generated names (empty, too long, or containing path separators) appear in the preview as blocking errors and can be fixed by the user. Malformed structure, unknown/duplicate/missing IDs, or duplicate plan names fail classification. User-edited conflicts also block confirmation.
- Every requested ID appears exactly once, either `{ bookmark_id, decision: "assign", category_id }` with a valid frozen category ID, or `{ bookmark_id, decision: "pending" }` with no category ID. Invalid responses prevent a complete preview.
- Use low-randomness settings and stable plan and batch order. Use at most two concurrent requests. Retry network and rate-limit failures twice; stop on other errors. Cancellation discards provisional results and cannot move bookmarks.

### Preview, execution, recovery, and undo

- The single test seam is the end-to-end application-level classification workflow, replacing only the browser bookmarks API with an in-memory tree adapter and the OpenAI-compatible service with a deterministic model-client adapter. Internal prompt formatting and loop structure are not separate contracts.
- Preview supports collapsed groups, incremental display, title/URL filtering, cancellation, multi-item reassignment, rename, and category deletion. Deleting a category makes its items pending.
- Before confirmation and immediately before execution, compare the participating snapshot. Any existence, parent ID, title, URL, or selected-range change invalidates the complete preview and requires full regeneration.
- After final confirmation, create and verify target folders, then move bookmarks in stable original traversal order. Append new items after existing target contents. Do not create empty targets.
- Record for recovery and undo: bookmark node ID, original parent ID, target parent ID, original index, post-operation title, post-operation URL, and IDs of folders created by the operation. Store no notes and no full tree copy.
- Folder-creation failure stops before movement and removes only newly created empty folders. Move failure stops further movement and attempts recovery. Recovery may restore still-compatible items but never overwrites later changes.
- A successful operation replaces the previous undo record only when at least one bookmark moved. No-op operations preserve the previous record. Undo checks every related node; any related change disables the entire undo. Compatible undo restores parents and inserts nodes in ascending original-index order, then removes only empty operation-created folders.
- Only one classification or recovery operation may run across the extension. Browser restart does not resume model generation; incomplete movement leaves a recoverable state for explicit action.
- Completion reports actual changes, unchanged/pending/unclassifiable counts, target folders, and undo status. Do not show raw model responses or exact cost estimates.

## Testing Decisions

- Use one end-to-end application-level seam. Replace only the browser bookmarks API with an in-memory tree adapter and the model API with a deterministic model-client adapter. Exercise the same workflow used by the side panel.
- Good tests assert external behavior: tree contents after confirmation, requests sent or prevented, preview invalidation, recovery/undo availability, and items left in place. Do not test private fields, prompt text, forwarding, mock echoes, or incidental defaults.
- Cover the happy path, folder reuse, folder and bookmark ordering, pending and unchanged items, and no-empty-folder behavior.
- Cover empty and small scopes, 3–15 limits, nested folders, duplicate URLs, unsupported URLs, duplicate names, and the 5,000-bookmark path.
- Cover malformed JSON, unknown/duplicate/missing IDs, invalid category IDs, invalid decisions, and explicit pending; prove no mutation occurs.
- Cover preview rename, invalid-name blocking, conflicts, category deletion, cancellation, batch reassignment, filtering, and counts.
- Cover external title/URL/parent/existence/range changes before confirmation and execution; prove stale previews cannot move bookmarks.
- Cover folder-creation failure, move failure, recovery success/conflicts, browser restart with incomplete recovery, and preservation of existing folders.
- Cover undo success, original order restoration, whole-undo disabling on related change, retained disabled records, empty-created-folder removal, no-op snapshot preservation, and configuration changes not affecting undo.
- Cover URL sanitization, no notes transmission, untrusted-data framing, masked keys, bookmark-free connection test, origin gating, privacy acknowledgement, no-sensitive-logging behavior, and local-data clearing without bookmark deletion.
- The repository has no existing product or test suite, so there is no prior testing pattern to preserve. Establish one deterministic end-to-end harness at the agreed seam.
- Verify the real Chrome/Edge extension surface, the deterministic harness, the 200-bookmark quality sample, and the 5,000-bookmark scale check.

## Out of Scope

- Natural-language bookmark search or semantic retrieval.
- Tags, notes, content indexing, page-body/meta fetching, or crawling.
- Accounts, developer backend, server storage, cloud sync, or cross-device indexes.
- Firefox, Safari, and mobile-device bookmark processing.
- More than one folder level, drag-and-drop tree editing, automatic deletion/merge/rename of existing folders, or destructive cleanup.
- Bookmark copying or deduplication.
- Local-rule fallback when the model is unavailable.
- Provider-specific adapters beyond OpenAI-compatible requests.
- Full history, multiple undo snapshots, forced undo, or partial undo after related-node conflict.
- Exact cost calculation, raw response display, automatic background continuation, or automatic execution after restart.
- Automatic learning, multiple plans, confidence-score UX, or correctness guarantees.

## Acceptance Criteria

- Preview, per-bookmark edits, batch edits, and confirmation are usable in the Chinese side panel.
- Invalid model responses never mutate browser bookmarks.
- External changes invalidate stale previews and require full regeneration.
- Move failures are reported and never presented as success.
- The latest successful operation can be undone under the all-or-nothing related-node rule.
- A real sample of at least 200 multi-topic bookmarks achieves at least 80% acceptable classification without manual correction; pending and cancelled items do not count.
- A 5,000-bookmark collection completes through bounded batch processing.
- The extension does not operate a developer backend and does not log secrets or complete model payloads.

## Further Notes

- The repository began without product implementation, glossary, ADR, or test suite. The implementation agent should establish the smallest maintainable structure while preserving this contract.
- Browser bookmark APIs are non-transactional. Recovery is best effort and must report conflicts instead of claiming atomic rollback.
- The 80% quality target is an MVP acceptance threshold, not a guarantee for every collection.
- Architectural rationale is recorded separately in `docs/adr/`.
- The GitHub Issue is the execution tracker; this file is the canonical local specification.
