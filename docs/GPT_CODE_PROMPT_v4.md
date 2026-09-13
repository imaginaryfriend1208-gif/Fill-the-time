# IF Memory v4.0.0 — Prompt hướng dẫn code sửa lỗi (phân phối cho GPT)

> Baseline: commit `46a5376`, manifest `3.4.2`, nhánh `main`.
> Repo: `D:\Anti-File\VPS-things\GIT\Fill the time\Fill-the-time` (SillyTavern extension, chạy trong browser, **không có build step, không có package.json**).
> Mọi số dòng dưới đây đã được kiểm chứng trên baseline này. Nếu code đã đổi, tìm theo tên hàm.

---

## PHẦN 0 — Kết quả nghiên cứu (đọc trước khi code)

### Đã kiểm chứng bằng thực thi (không phải đọc)
Ba file kiểm chứng đang có sẵn: `tools/verify.mjs` (invariant tĩnh, 10 nhóm), `tools/test-prompts.mjs` (trích nguyên văn `generateFromText()` + `updateSummaryInjection()` ra chạy thật với `sendRequest` bị stub, 27 assertion). Baseline: **tất cả xanh**.

| # | Điểm người dùng nêu | Trạng thái thật trên baseline | Kết luận |
|---|---|---|---|
| 1 | Popup đè nhau | **80** lời gọi toast trong `memories.js`; **không có** `toastr.options` nào (không `preventDuplicates`, không `timeOut`). Từ v3.4.1 stock và merge chạy song song ⇒ hai luồng toast bắn cùng lúc. Toast per-chunk `Generating chunk summary N...` vẫn còn. | **BUG** — cần notifier tập trung |
| 2 | Merge dùng merge prompt, chunk dùng chunk prompt | Routing **đúng** khi `use_custom_chunk_prompts = true`. Nhưng **default là `false`** (`settings.js:84`) ⇒ chunk pass fallback về **merge prompt** với `previousSummary` rỗng. | **BUG cấu hình** — chunk phải luôn dùng chunk prompt, bỏ toggle |
| 3 | Merge và chunk song song, bấm merge ở đâu merge ở đó | v3.4.1 đã cho phép (`stock_during_merge`, `mergeFloor`, revalidate 2 pha). `endChapter` không chặn khi `stockInProgress`. Chunk lấn vào vùng merge bị **discard** (`protectedThrough`). | **Đã đúng về logic**, chưa chạy end-to-end. Giữ, bỏ toggle `stock_during_merge` |
| 4 | Xoá 1 chunk ⇒ chunk trống (giữ range để regen) | `deleteStockedChunk()` (dòng ~479) **`splice` xoá hẳn** ⇒ mất range, merge sau đọc raw message thay vào (không báo). | **BUG** — cần tombstone |
| 5 | Xoá merge ⇒ chunk về pending; merge lại dùng chunk cũ mặc định | `clearRollingSummary({ dropMergedStock = true })` (dòng ~296) **XOÁ chunk đã merge** theo mặc định. `merge_use_stock` là toggle. `restockChunks()` xoá chunk chưa merge. | **BUG do fix v3.3.0 đi ngược ý đồ** — phải revert |
| 6 | Archive mặc định ẩn, không đọc vào prompt, bỏ nút fresh merge | `archiveIsolated` per-chat default `false`; `use_archive_as_regen_base` default `true`; `merge_ignore_previous` là toggle. | **BUG cấu hình** — đảo mặc định, bỏ 3 setting |
| 7 | Merge = active summary + chunk mới | `generateFromText`: `previous = previousOverride ?? rollingSummary?.summary ?? ''`. Template macro là **`{{previousSummary}}`** (camelCase) và `{{content}}`. | **Đúng**. Thêm alias `{{previous_summary}}` |
| 8 | Merge API cho merge, chunk API cho chunk | Routing đúng (test 10/10). **Nhưng** `sendRequest()` (dòng ~406) khi profile request lỗi ⇒ **fallback âm thầm sang `generateQuietPrompt`** (API chat chính). | **BUG** — phải fail rõ, không fallback ngầm |
| 9 | Không dùng archive làm base regen | `generateActiveSummaryReplacement()` (dòng ~859): `base = usableArchiveEntries()...at(-1)` trừ khi `ignoreArchive`. Đây chính là **nguyên nhân gốc bug "đọc tới tin 250"**. | **BUG** — base luôn `null`, `start = 0` |
| 10 | `{{fillthetime}}` vs `{{previousSummary}}` | Cả hai đều đọc `rollingSummary?.summary` (dòng 277 macro; `injected.fillthetime` trong `updateSummaryInjection`; `previous` trong `generateFromText`). Cùng nguồn, hai ngữ cảnh. `{{fillthetime}}` trả `''` khi `internalGenerationDepth > 0` — **đúng, phải giữ** (chống summary-chứa-summary). | **Đúng**, nhưng 3 chỗ đọc trực tiếp ⇒ gom về 1 accessor |
| 11 | Merge bị cắt giữa chừng | `getMaxTokensForProfile()` đọc **Response Length của preset** (`openai_max_tokens`, thường 2048) rồi truyền làm `maxTokens`. Đã đối chiếu ST `custom-request.js`: `presetToGeneratePayload()` trả `createRequestData({ ...payload, ...overridePayload })` ⇒ **`max_tokens` do extension truyền THẮNG preset**. Vậy chỉ cần truyền số lớn hơn là có tác dụng. `finish_reason` **không** có trong kết quả vì `extractData` default `true` và `custom-request.js` không bao giờ surface nó (grep = 0). | **BUG** — thêm `merge_max_tokens`, đọc `finish_reason` qua `extractData:false` |

### Bug phụ phát hiện thêm (không nằm trong 11 điểm nhưng gây mất dữ liệu)
- **P1** `unhideRange()` (dòng 249) bỏ ẩn **mọi** tin trong khoảng, kể cả tin người dùng tự ẩn. Không có marker sở hữu.
- **P2** `add_chunk_summaries` chèn message qua `/comment at=${target+1}` (dòng ~946) ⇒ **dịch ID mọi chunk phía sau**. Default `false` nhưng vẫn là bom.
- **P3** `stockKey` (dòng 780) fingerprint bằng `text.length` ⇒ hai chunk khác nội dung cùng độ dài bị coi là một khi resume checkpoint.
- **P4** `invalidateStockFrom()` xoá hẳn chunk khi edit/swipe/delete message — với tombstone nên chuyển thành đánh dấu `stale`.

---

## PHẦN 1 — Quy tắc bắt buộc cho người code

1. **Không đổi tên/xoá export công khai** trong `src/memories.js` (danh sách 46 tên nằm trong `tools/verify.mjs`, nhóm `exports`). Được thêm mới.
2. **Không sửa `tools/test-prompts.mjs` để cho pass.** 27 assertion phải giữ nguyên hoặc tăng. 4 assertion hostile-content (`$&`, `` $` ``, `$'`, `$1`) fail trên `2ffd73f` và pass trên `46a5376` — là bằng chứng chống tái phát.
3. Mọi thay đổi setting phải có **migration** trong `migrate()` của `settings.js`; config cũ import lại không được mất dữ liệu; chat cũ có `fillTheTimeStock` dạng cũ phải load được.
4. Mỗi giai đoạn (G1→G7) = **một commit**, gate xanh mới sang giai đoạn kế.
5. Không tạo file `.md` mới ngoài file này. Không refactor ngoài phạm vi.
6. Toàn bộ chuỗi UI mới phải qua `getText(key, fallbackEN)` và thêm key vào `locales/vi-vn.json`, `locales/fr-fr.json`.

### Gate kiểm tra (chạy sau MỌI commit)
```bash
cd "D:\Anti-File\VPS-things\GIT\Fill the time\Fill-the-time"
for f in index.js src/*.js tools/*.mjs; do node --check "$f" || exit 1; done
for f in manifest.json locales/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || exit 1; done
node tools/verify.mjs          # phải: All checks passed
node tools/test-prompts.mjs    # phải: All prompt assertions passed (>= 27)
node tools/test-stock-state.mjs  # G1 trở đi
```
Sau khi push: `git clone` ra thư mục tạm và chạy lại gate trên bản clone — **không tin state local**.

---

## PHẦN 2 — Các giai đoạn

### G1 — Hàm thuần + test (chưa nối vào code cũ) · rủi ro rất thấp
Tạo `src/chunk-select.js` và `src/summary-state.js` chỉ chứa hàm thuần (không import ST).

```js
// src/summary-state.js
export const CHUNK_STATUS = { EMPTY: 'empty', MERGED: 'merged', PENDING: 'pending', OVERLAP: 'overlap' };
/** Trạng thái dẫn xuất — KHÔNG lưu vào metadata, luôn tính từ activeEnd + mergeFloor. */
export function deriveChunkStatus(chunk, activeEnd = -1, mergeFloor = -1) {
  if (!chunk.summary) return CHUNK_STATUS.EMPTY;
  if (chunk.toMsgId <= activeEnd) return CHUNK_STATUS.MERGED;
  if (chunk.fromMsgId <= Math.max(activeEnd, mergeFloor) && chunk.toMsgId > Math.max(activeEnd, mergeFloor)) return CHUNK_STATUS.OVERLAP;
  return CHUNK_STATUS.PENDING;
}
```
```js
// src/chunk-select.js
/**
 * Chọn chunk cho merge (oldEnd, target]. Trả về { segments, usedStock, blockedBy }.
 * - Chunk EMPTY trong range => blockedBy = chunk đó, segments = [] (CHẶN, không chạy tiếp).
 * - Chunk vượt target (toMsgId > target) => bỏ qua, phần đó dùng raw history.
 * - Không bao giờ nhận đầu vào archive.
 */
export function selectChunksForMerge(chunks, oldEnd, target) { /* thuần, không async */ }
```
Tạo `tools/test-stock-state.mjs` (import trực tiếp 2 module trên, ≥ 20 assertion). **Ba invariant bắt buộc**:
```
A. chunks có 0-65,66-130,131-190, oldEnd=250, target=300  → usedStock = 0 (chunk 0-250 KHÔNG lọt vào merge 251-300)
B. activeEnd đổi từ 250 → -1                              → mọi chunk có text derive thành 'pending', mảng KHÔNG đổi độ dài
C. selectChunksForMerge không có tham số archive; grep 'archive' trong chunk-select.js = 0
```
Thêm nhóm `stock-state` vào `verify.mjs`: file tồn tại, không import `extensions.js`/`script.js`.

### G2 — Cắt archive khỏi merge và regenerate · root cause thật
- `memories.js`: thêm `export function getActiveSummaryText() { return rollingSummary?.summary || ''; }`. Ba chỗ đọc `rollingSummary?.summary` (macro dòng 277, `injected.fillthetime`, `previous` trong `generateFromText`) đổi sang gọi hàm này.
- `generateActiveSummaryReplacement()`: **xoá** toàn bộ logic `base`/`ignoreArchive`. Cố định `const base = null; const start = 0;` và `previousSummary: ''`. Xoá toast `Regenerating without using the archive...`.
- Xoá setting `use_archive_as_regen_base`, `merge_ignore_previous`, `merge_use_stock` khỏi `defaults`, khỏi vòng `for (const key of [...])` ở `settings.js:185`, khỏi HTML (`#rmr_use_archive_as_regen_base`, `#rmr_merge_ignore_previous`, `#rmr_merge_use_stock`), khỏi `commands.js` (`stock=`, `fresh=` của `/fillthetime-end`). Thêm vào mảng `obsolete` để migration xoá.
- `generateRollingSummary()`: xoá `useStock`/`ignorePrevious`; luôn `buildStockSegments`; luôn truyền `{}` (previous = active).
- Thêm alias macro: regex trong `fillMacros` thành `/{{(content|previousSummary|previous_summary|worldInfo)}}/gi` và map `previous_summary` → cùng giá trị `previoussummary`.
- **Test**: `test-prompts.mjs` thêm assertion `{{previous_summary}}` resolve như `{{previousSummary}}`. `verify.mjs` nhóm `archive-isolation` đổi thành: `generateActiveSummaryReplacement` body **không chứa** `archiveEntries`/`usableArchiveEntries`; `buildStockSegments` không chứa `archive`.

### G3 — Tombstone + 4 trạng thái + revert xoá chunk · đụng dữ liệu đã lưu
- `normalizeStockEntry()`: cho phép `summary = ''`; thêm field tuỳ chọn `emptiedAt`. Entry cũ không có field ⇒ vẫn hợp lệ.
- `deleteStockedChunk()` → **không splice**; set `summary = ''`, `emptiedAt = now`. Thêm `export async function purgeStockedChunk(from, to)` cho xoá hẳn (nút riêng, có confirm).
- `invalidateStockFrom(id)`: chunk có `toMsgId >= id` ⇒ set `summary = ''` (tombstone) thay vì xoá.
- `buildStockSegments()`: dùng `selectChunksForMerge()` từ G1. Nếu `blockedBy` ⇒ `errorToast('Chunk X-Y is empty. Regenerate it before merging.')` và **return null** ⇒ caller huỷ merge.
- `clearRollingSummary()`: đổi chữ ký thành `clearRollingSummary({ dropArchive = false } = {})`. **Xoá** `dropMergedStock`/`dropAllStock` và mọi lời gọi `clearMergedStockedChunks` bên trong. Giữ export `clearMergedStockedChunks` (public) nhưng chỉ dùng từ nút "Delete merged" trong stock viewer.
- `restockChunks()`: giữ nguyên hành vi nhưng đổi nhãn nút thành `Rebuild pending chunks` và confirm rõ "sẽ xoá chunk chưa merge".
- Dialog Clear/Restore trong `settings.js` (`showClearOrRestoreDialog`): xoá 2 checkbox `rmr-drop-merged`, `rmr-drop-all`; giữ `rmr-drop-archive`.
- Stock viewer: hiển thị badge trạng thái 4 loại; chunk `empty` có nút **Regenerate** và **Purge**; `regenerateStockedChunk()` phải chấp nhận entry có `summary = ''`.
- **Test**: `test-stock-state.mjs` thêm: xoá chunk giữa chuỗi ⇒ độ dài mảng không đổi, status `empty`; merge qua range có empty ⇒ `blockedBy` đúng chunk đó.

### G4 — Notifier tập trung, hết popup đè · chỉ UI
Tạo `src/notify.js`:
```js
// Hai lane cố định. Mỗi lane chỉ có TỐI ĐA 1 toast tiến trình sống; toast mới thay toast cũ (toastr.clear(handle)).
// Toast kết thúc (done/error) mới được tồn tại độc lập, timeOut 6000.
export const notify = {
  progress(lane /* 'merge' | 'stock' */, text) {},   // thay thế, không cộng dồn
  done(lane, text) {}, error(lane, text) {}, clear(lane) {},
};
toastr.options = { ...toastr.options, preventDuplicates: true, timeOut: 6000, extendedTimeOut: 2000, newestOnTop: true };
```
- **Xoá** toast per-chunk `Generating chunk summary ${chunk}...` (dòng ~697) — tiến trình chunk đã có progress bar.
- `announceMergeScope` → `notify.progress('merge', ...)`. `Reusing/Using stocked` (nếu còn) → xoá.
- Mọi `rawInfo`/`rawWarn` trong `autoStockChunks`/`regenerateStockedChunk` → `notify.progress('stock', ...)` / `notify.error('stock', ...)`.
- `setProgress()` giữ nguyên (progress bar), thêm lane `stock` vào `updateChapterProgress` (hiển thị 2 dòng khi cả hai chạy).
- **Test**: `verify.mjs` nhóm `notify`: `memories.js` không còn gọi `toastr.` trực tiếp (trừ trong `notify.js`); không còn chuỗi `Generating chunk summary`.

### G5 — Bỏ toggle concurrency, snapshot rõ ràng · rủi ro cao nhất
- Xoá setting `stock_during_merge` (thêm vào `obsolete`); `autoStockChunks` bỏ nhánh `settings?.stock_during_merge === false`.
- `beginMerge(target)` phải được gọi **trước** `buildStockSegments` trong cả `generateRollingSummary`, `generateActiveSummaryReplacement`, `endChapterSilent` — kiểm tra 3 chỗ, hiện `endChapter`/`autoSplitSummarize` có, hai hàm generate gọi trực tiếp từ UI (`Re-summarize`) **chưa** có.
- Giữ nguyên `internalGenerationDepth`, `rateLimitSlot` per-profile, `protectedThrough` 2 pha.
- **Test**: `verify.mjs` nhóm `concurrency` (15 check) giữ nguyên; thêm check `beginMerge(` xuất hiện ≥ 4 lần.

### G6 — Max output + finish_reason + continuation · [11]
- Setting mới `merge_max_tokens` (default `0` = dùng preset) và `chunk_max_tokens` (default `0`). UI: 2 ô số trong *Summarization Connection*, cùng hàng `.rmr-field-row`.
- `generateFromText`: `const maxTokens = (isChunkPass ? settings.chunk_max_tokens : settings.merge_max_tokens) || await getMaxTokensForProfile(profileId);`
- `sendRequest`: gọi với `{ includePreset: true, includeInstruct: true, stream: false, extractData: false }`. Kết quả là **raw JSON của provider**. Trích:
  ```js
  const finish = json?.choices?.[0]?.finish_reason ?? json?.stop_reason ?? json?.candidates?.[0]?.finishReason ?? null;
  const truncated = ['length', 'max_tokens', 'MAX_TOKENS'].includes(String(finish));
  ```
  Nội dung: dùng `extractMessageFromData(json, 'openai')` — **kiểm tra export này tồn tại** ở `public/script.js` (custom-request.js import nó từ `'../script.js'`). Nếu không import được, fallback thứ tự: `json.choices[0].message.content` → `json.content[0].text` (Claude) → `json.candidates[0].content.parts[].text` (Gemini). Với textgen (`selectedApiMap.selected !== 'openai'`) giữ `extractData: true` như cũ (finish_reason không có, coi như không truncated).
- Continuation: nếu `truncated && !isChunkPass` ⇒ tối đa `2` lần gửi lại với message `user: "Continue exactly from where you stopped. Do not repeat."` kèm assistant message là phần đã có; nối kết quả. Sau 2 lần vẫn truncated ⇒ **không auto-accept**, mở `openReviewPopup` với cảnh báo. **Cấm** dò truncation bằng regex dấu câu.
- `sendRequest` fallback `generateQuietPrompt`: **chỉ** khi `profileId` rỗng (người dùng cố ý không chọn profile). Nếu có `profileId` mà request lỗi ⇒ `throw` với message rõ. (Sửa [8].)
- **Test**: `test-prompts.mjs` thêm stub `sendRequest` trả `{ choices:[{finish_reason:'length', message:{content:'A'}}] }` lần 1, `'stop'` lần 2 ⇒ kết quả `'A' + phần 2`, số lần gọi = 2. `verify.mjs`: `sendRequest` body chứa `extractData: false`; không chứa `generateQuietPrompt` trong nhánh có `profileId`.

### G7 — Chống mất dữ liệu · P1–P3
- P1: khi ẩn trong `acceptRollingSummary`, set `chat[index].extra ||= {}; chat[index].extra.fillTheTimeHidden = true;`. `unhideRange()` chỉ bỏ ẩn tin có marker và xoá marker. Migration: tin đang `is_system && extra.rmr_chapter` coi như có marker (best-effort, ghi rõ trong comment).
- P2: xoá hoàn toàn `add_chunk_summaries`, `pendingChunkComments`, lời gọi `/comment at=`. Thêm key vào `obsolete`. Xoá `#rmr_add_chunk_summaries` khỏi HTML/i18n.
- P3: `stockKey` dùng hash (FNV-1a 32-bit, viết inline 6 dòng) của `item.text` thay vì `.length`.
- **Test**: `verify.mjs`: không còn `/comment at=`; `unhideRange` body chứa `fillTheTimeHidden`; `stockKey` không chứa `.length`.

### Bump & docs
`manifest.json` → `4.0.0`. README: mục "Workflow" 4 bước: chat ⇒ chunk nền ⇒ merge (chunk → story) ⇒ inject story vào chat history + ẩn tin đã sum. Nêu rõ: archive chỉ để xem/xoá/khôi phục thủ công, không bao giờ vào prompt.

---

## PHẦN 3 — Quyết định đã chốt (không mở lại)

| Vấn đề | Quyết định | Lý do |
|---|---|---|
| Merge gặp chunk `empty` | **Chặn**, bắt regen | Người dùng xoá chunk *để* regen tránh mất truyện; chạy tiếp là ngược ý |
| Dò truncation | **`finish_reason`**, không regex | Summary hợp lệ có thể kết thúc bằng `)`, số, tên riêng |
| Trạng thái chunk | 4: `empty/merged/pending/overlap` | Merge tại ID nằm giữa chunk đang chạy là ca thật |
| Profile lỗi | **Fail rõ**, không fallback API chat | Fallback ngầm = bug #1 tái sinh dưới dạng khác |
| Regenerate | Từ tin 0, `previousSummary = ''` | Điểm 9 của người dùng; đây là root cause bug 250 |
| Xoá active summary | Chunk **giữ nguyên**, derive về pending | Điểm 5; revert hành vi v3.3.0 |
| Tên macro chuẩn | `{{previousSummary}}` + alias `{{previous_summary}}` | Không vỡ preset cũ |
| `{{fillthetime}}` khi internal generation | Luôn `''` | Chống summary-chứa-summary |

## PHẦN 4 — Cần người dùng quyết (ghi chú cho GPT: **hỏi, không tự làm**)
1. `inject_enabled` default hiện `false` (dùng `{{fillthetime}}` qua Prompt Manager). Workflow mục tiêu nói "inject vào chatHistory" ⇒ có đổi default thành `true` + depth 0 không? Đổi default ảnh hưởng người đang dùng Prompt Manager (bị inject 2 lần).
2. Archive: giữ nút **Restore** (khôi phục thủ công) hay chỉ Xem/Xoá?
3. Continuation tối đa 2 lần — chấp nhận chi phí gấp 3 cho merge dài?
4. Chunk theo số tin nhắn (20–40 tin/chunk) + merge nhiều tầng: **ngoài phạm vi v4.0.0**, làm ở v4.1 vì bắt restock toàn bộ.

## PHẦN 5 — Điều chưa kiểm chứng (nói thẳng)
- Chưa có lần chạy end-to-end nào trong SillyTavern thật cho v3.3.0→v3.4.2 ngoại trừ bug "250" do người dùng xác nhận. Concurrency (G5) là phần rủi ro nhất và chỉ có kiểm tra tĩnh.
- `extractMessageFromData` — vị trí export chưa xác minh trực tiếp (chỉ thấy `custom-request.js` import từ `'../script.js'`). Người code phải `grep` trong bản ST đang cài trước khi dùng.
- Hình dạng raw JSON khi `extractData:false` phụ thuộc provider; 3 nhánh trích ở G6 phủ OpenAI-compatible/Claude/Gemini, các source khác cần fallback an toàn (coi như không truncated, log debug).
- Dữ liệu: người dùng đã Clear ít nhất một lần ở v3.3.0 với `dropMergedStock=true` ⇒ chunk cũ **đã mất thật**. Tombstone chỉ cứu từ nay về sau.
