# IF Memory — Plan sửa 3 vấn đề (v3.3.0)

Tài liệu này là plan tổng thể **trước khi code**. Mọi thay đổi sau đó phải bám đúng danh sách hành vi ở đây.

---

## 0. Bản đồ code hiện tại (đã đọc 100%)

| File | Vai trò |
|---|---|
| `index.js` | Đăng ký event SillyTavern (APP_READY, CHAT_CHANGED, GENERATION_ENDED → autoStock, MESSAGE_EDITED/SWIPED/DELETED → invalidateStockFrom) |
| `src/memories.js` | Toàn bộ logic: rolling summary, archive, chunk stock, checkpoint, gọi API, silent merge |
| `src/settings.js` | Settings + toàn bộ UI (render active summary, archive, stock, popup review/regen) |
| `src/messages.js` | Nút ⏹ trên từng message |
| `src/commands.js` | Slash commands |
| `templates/settings_panel.html`, `style.css`, `locales/*.json` | UI / i18n |

Dữ liệu lưu trong `chatMetadata` của **từng chat**:
- `fillTheTime` → active rolling summary `{summary, endMsgId, updatedAt}`
- `fillTheTimeArchive` → mảng archive `{summary, endMsgId, archivedAt}`
- `fillTheTimeStock` → mảng chunk đã stock `{summary, fromMsgId, toMsgId, createdAt}`
- `fillTheTimePendingChapter` → checkpoint chunk dở dang
- `fillTheTimePendingSilentMerge` → cờ merge nền

---

## 1. Vấn đề 1 — Merge và Chunk dùng chung 1 profile

### Nguyên nhân gốc (xác định chính xác)

`src/memories.js → generateFromText()`:

```js
const profileId = resolveConnectionProfileId(commandArgs?.profile, settings.profile);
```

Hàm này được dùng cho **cả 2 loại request**:
- pass chunk: `generateFromText(text, i, false)` (`includePrevious = false`)
- pass merge cuối: `generateFromText(combined, 0, true, previous)`

Nó **không bao giờ** đọc `settings.stock_profile`. `stock_profile` chỉ có tác dụng gián tiếp ở 2 chỗ:
`autoStockChunks()` và `regenerateStockedChunk()` set `commandArgs = { profile: settings.stock_profile }` trước khi gọi.

⇒ Hệ quả: chunk chạy trong luồng **Create Chapter / merge / silent merge / regenerate** (tức là lúc `summarizeHistory()` băm chunk) **luôn dùng profile merge**. Chỉ có stock nền mới dùng profile thứ 2. Đúng như bạn mô tả.

Bug phụ đi kèm: `commandArgs` là biến global mutable, `autoStockChunks()` set nó nhưng **không khôi phục** trong `finally` ⇒ profile stock có thể rò rỉ sang thao tác kế tiếp.

### Cách sửa

1. Tách 2 hàm resolve rõ ràng trong `memories.js`:
   - `resolveMergeProfileId(explicit)` → `explicit → settings.profile → profile đang chọn của ST`
   - `resolveChunkProfileId(explicit)` → `explicit → settings.stock_profile → settings.profile → profile đang chọn của ST`
2. `generateFromText()` chọn theo `isChunkPass` (đã có sẵn biến này, `= !includePrevious`).
3. `commandArgs.chunkProfile` là kênh override riêng cho chunk; `autoStockChunks`/`regenerateStockedChunk` chuyển sang set `chunkProfile` thay vì `profile`, và **restore `commandArgs`** trong `finally`.
4. Vì `maxTokens`, `reasoning_effort`, `include_reasoning`, `buildOverridePayload` đều suy ra từ `profileId` ⇒ tự động đúng theo từng pass (không cần sửa thêm).
5. Đổi nhãn UI cho khớp mental model: **Merge Profile** / **Chunk Profile** (giữ nguyên key lưu trữ `profile` và `stock_profile` để không phá config cũ).
6. Hiển thị tên profile đang dùng trên thanh progress (`Chunk 3/8 · GPT-5-mini`, `Merging… · Claude`) để **kiểm chứng được bằng mắt** rằng 2 pass dùng 2 profile khác nhau.

### Edge cases bắt buộc xử lý
- `stock_profile` trỏ tới profile đã bị xoá → `isValidConnectionProfileId` false → rơi về merge profile (không được crash).
- Cả 2 profile để trống → dùng profile hiện hành của ST (hành vi cũ).
- Slash command `/fillthetime-end profile=X` → X thắng cả 2 pass (override thủ công có ưu tiên cao nhất).
- Silent background merge vẫn phải kiểm tra có profile hợp lệ trước khi chạy.

---

## 2. Vấn đề 2 — Merge mới vẫn "dính" nội dung cũ / archive

### Có **3 đường rò rỉ** khác nhau, phải bịt cả 3

**(A) Chunk stock cũ bị tái sử dụng âm thầm — nhiều khả năng là thủ phạm chính trong case của bạn.**

Từ commit `a8b9937`, chunk đã merge **được giữ lại** (`acceptRollingSummary` không xoá stock). `restockChunks()` cũng chỉ xoá chunk *chưa* merge:

```js
stockedChunks = stockedChunks.filter(entry => entry.toMsgId <= activeEnd); // giữ lại chunk đã merge
```

Khi bạn xoá active summary (Clear / Restore → *Create empty*) thì `activeEnd` tụt về `-1`, toàn bộ chunk cũ 0–250 **từ "merged" chuyển thành "pending"** và `buildStockSegments()` sẽ nhét lại chúng vào lần merge kế tiếp. Kết quả: merge "mới" lại chứa nguyên nội dung tới tin 250 — trông y hệt bản archive cũ.

**(B) Đường Regenerate active summary đọc archive theo thiết kế.**

`generateActiveSummaryReplacement()`:

```js
const base = archiveEntries.filter(e => e.endMsgId < active.endMsgId).sort(...).at(-1) || null;
const start = base ? base.endMsgId + 1 : 0;
... summarizeHistory(segments, active.endMsgId, { previousSummary: base?.summary || '' })
```

⇒ Bản archive cũ được nạp thẳng làm `{{previousSummary}}`. Không có công tắc nào tắt.

**(C) Checkpoint chunk cũ bị resume nhầm.**

`summarizeHistory()` resume checkpoint khi trùng `(checkpointType, startMsgId, targetMessageId, chunkCount)`. Nếu bạn xoá chunk rồi chạy lại đúng range đó, các `chunkSummaries` **cũ** trong checkpoint được dùng lại thay vì sinh mới.

### Cách sửa (đủ 3 đường + cho bạn quyền kiểm soát)

1. **Fresh merge (per-run)** — checkbox cạnh *Create Chapter*: `Fresh merge: bỏ qua summary trước + archive`.
   → `generateRollingSummary(id, { ignorePrevious: true })` ⇒ `{{previousSummary}}` = rỗng.
2. **Reuse stocked chunks (per-run)** — checkbox `Dùng lại chunk đã stock` (mặc định bật). Tắt ⇒ `useStock: false`, đọc thẳng message gốc. (Option `useStock` đã có trong code nhưng **chưa có UI nào expose**.)
3. **Archive isolation (per-chat, có nút bấm)** — `chatMetadata.fillTheTimeArchiveHidden`:
   - ẩn hoàn toàn danh sách archive trong panel (chỉ còn 1 dòng trạng thái + nút *Hiện lại*),
   - `generateActiveSummaryReplacement` **không** lấy archive làm base,
   - `restorePreviousFromArchive` bị chặn (không thể vô tình khôi phục bản 250 cũ).
4. **Delete all archive** — nút xoá vĩnh viễn toàn bộ archive của chat hiện tại (có confirm).
5. **Setting toàn cục** `use_archive_as_regen_base` (mặc định `true` = giữ hành vi cũ) trong *Summary Behavior*, để tắt hẳn việc regenerate dựa vào archive.
6. **Dọn stock khi xoá summary**: `clearRollingSummary()` mặc định xoá luôn các chunk đã merge vào summary vừa bị xoá (`toMsgId <= oldEnd`); dialog cho chọn *xoá toàn bộ chunk* và *xoá luôn archive*.
7. **Checkpoint an toàn**: thêm `stockKey` (vân tay của danh sách segment) vào checkpoint; resume chỉ khi khớp. `clearStockedChunks()` cũng xoá checkpoint đang treo.
8. **Minh bạch**: trước khi merge, toast liệt kê chính xác range chunk sẽ tái sử dụng (`Dùng lại 3 chunk: 0–65, 66–130, 131–190`), và stock viewer thêm nút *Xoá tất cả* / *Xoá chunk đã merge*.

### Edge cases bắt buộc xử lý
- Archive rỗng / archive có entry `endMsgId >= chat.length` (do xoá message) → lọc bỏ, không dùng làm base.
- Isolate archive rồi mà bấm *Restore latest* → phải báo lỗi rõ ràng, không làm gì.
- Isolate khi chưa có archive → nút vẫn hoạt động, không crash.
- Xoá archive khi đang generate → không được làm hỏng `draftBases`/signature check (signature chỉ tính trên active summary, an toàn).
- `ignorePrevious` **không** đổi range merge (vẫn từ `oldEnd + 1`), tránh mất dữ liệu ngầm; muốn build lại từ 0 thì xoá active summary trước. Phải nói rõ trong hint/tooltip.
- Mọi cờ mới phải tồn tại theo **từng chat** (archive isolation) hoặc **global settings** (2 checkbox merge) và sống sót qua reload / CHAT_CHANGED.

---

## 3. Vấn đề 3 — 2 box "End Message ID" và "Stages" lệch nhau

### Nguyên nhân

`templates/settings_panel.html`:

```html
<div class="flex-container flex1 flexFlowColumn">
  <label ...><small>End Message ID (blank = latest)</small></label>
  <input class="text_pole widthNatural" ...>
</div>
<div class="flex-container flex1 flexFlowColumn">
  <label ...><small>Stages (1 = single, 0 = auto by tokens)</small></label>
  <input class="text_pole widthNatural" ...>
</div>
```

2 label dài ngắn khác nhau ⇒ một cái xuống 2 dòng, một cái 1 dòng ⇒ input bị đẩy lệch chiều dọc. `widthNatural` lại cho input rộng theo nội dung ⇒ lệch cả chiều ngang. Phần *Summarization Connection* đã được xử lý ở commit `b01b489` bằng `.rmr-field` (label `flex:1; align-items:flex-end`, input `width:100%`) nhưng **hàng Rolling Summary chưa được áp dụng**.

### Cách sửa

- Tách CSS dùng chung `.rmr-field-row` / `.rmr-field` (label chiếm hết phần trên, input luôn dính đáy, `width:100%`), áp cho **cả 3 hàng**: Rolling Summary, Summarization Connection, Inject (Depth/Role).
- Bỏ `widthNatural` ở 2 input Rolling Summary.
- Giữ `@media(max-width:700px)` → xếp dọc trên mobile.
- Không phụ thuộc độ dài title/label nữa ⇒ dịch sang tiếng Việt/Pháp dài ngắn tuỳ ý vẫn thẳng hàng.

---

## 4. Tổng hợp thay đổi theo file

| File | Thay đổi |
|---|---|
| `src/memories.js` | `resolveMergeProfileId` / `resolveChunkProfileId` / `getProfileName`; profile theo pass trong `generateFromText`; `commandArgs.chunkProfile` + restore trong `finally`; archive isolation (`isArchiveIsolated`, `setArchiveIsolated`, `clearArchiveEntries`); `clearMergedStockedChunks`; `clearRollingSummary(options)`; `ignorePrevious` + `useStock` cho `generateRollingSummary` / `generateActiveSummaryReplacement`; `stockKey` cho checkpoint; toast liệt kê chunk tái sử dụng; progress kèm tên profile |
| `src/settings.js` | defaults mới (`merge_use_stock`, `merge_ignore_previous`, `use_archive_as_regen_base`); bind UI mới; `renderArchiveList` trạng thái isolated; dialog Clear/Restore có lựa chọn; stock viewer thêm nút xoá hàng loạt; progress hiển thị profile |
| `templates/settings_panel.html` | `.rmr-field-row/.rmr-field` cho 3 hàng; 2 checkbox merge; thanh hành động Archive; đổi nhãn Merge/Chunk Profile |
| `style.css` | CSS field row dùng chung + style thanh archive |
| `locales/vi-vn.json`, `fr-fr.json` | key mới |
| `src/commands.js` | `/fillthetime-end` thêm `stock=`, `fresh=`; thêm `/fillthetime-archive-hide`, `/fillthetime-archive-clear`, `/fillthetime-stock-clear` |
| `README.md`, `manifest.json` | mô tả tính năng mới + bump `3.3.0` |
| `tools/verify.mjs` | harness kiểm tra tự động (syntax, JSON, key i18n, id UI, invariant code) |

## 5. Định nghĩa "xong"

1. `node --check` sạch cho mọi file `.js`, mọi `locales/*.json` parse được.
2. `node tools/verify.mjs` pass 100% (bao gồm check id HTML ↔ selector trong JS, key i18n, và các invariant chống tái phát bug).
3. Không đổi tên/khoá bất kỳ export công khai đang dùng: `getRollingSummary`, `getArchiveEntries`, `getStockedChunks`, `endChapter`, `endChapterSilent`, `autoStockChunks`, `invalidateStockFrom`, `restockChunks`, `clearStockedChunks`, `deleteStockedChunk`, `regenerateStockedChunk`, `loadRollingSummaryData`, `updateSummaryInjection`, `initFillTheTimeMacros`, `checkStaleSilentMerge`, `getPendingCheckpoint`, `resumePendingCheckpoint`, `discardPendingCheckpoint`, `getChunkTokenLimit`, `getStockContextLimit`, `getWorldInfoText`, `deleteArchiveEntry`, `updateRollingSummaryText`, `restorePreviousFromArchive`, `clearRollingSummary`, `generateRollingSummary`, `acceptRollingSummary`, `generateActiveSummaryReplacement`, `acceptActiveSummaryReplacement`, `regenerateActiveSummary`, `autoSplitSummarize`, `isStocking`, `isSilentMergeRunning`, `isValidConnectionProfileId`, `resolveConnectionProfileId`, `getReasoningEffort`, `getIncludeReasoning`, `getMaxTokensForProfile`, `buildOverridePayload`.
4. Config cũ (`stock_profile`, preset, archive cũ) load lên không mất dữ liệu.
