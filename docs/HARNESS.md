# Harness — phân công theo model/agent (IF Memory v3.3.0)

Harness này chia việc thành 4 slot độc lập nhất có thể, kèm **tiêu chí nghiệm thu tự động**.
Mọi slot chạy chung 1 lệnh kiểm tra: `node tools/verify.mjs` (không cần internet, không cần npm install).

> Quy ước: `M1..M4` là 4 model/agent. Nếu chạy tuần tự bằng 1 model, làm đúng thứ tự M1 → M2 → M3 → M4.

---

## M1 — Connection routing (Merge ≠ Chunk)

**File:** `src/memories.js`

**Phải implement**
- `getProfileName(id) -> string`
- `resolveMergeProfileId(explicit) -> id|null` = `explicit → settings.profile → ST selected`
- `resolveChunkProfileId(explicit) -> id|null` = `explicit → settings.stock_profile → settings.profile → ST selected`
- `generateFromText()` chọn profile theo `isChunkPass` (`= !includePrevious`).
- `commandArgs.chunkProfile` là kênh override chunk. `autoStockChunks()` và `regenerateStockedChunk()` set `chunkProfile` (không set `profile` nữa) và **khôi phục `commandArgs` cũ trong `finally`**.
- `setProgress()` mang thêm tên profile của pass đang chạy.

**Không được phá**
- `resolveConnectionProfileId(...ids)` giữ nguyên chữ ký + hành vi (đang export, `commands.js`/`settings.js` có thể dùng).
- `getMaxTokensForProfile` / `getReasoningEffort` / `getIncludeReasoning` / `buildOverridePayload` phải nhận đúng `profileId` của pass hiện tại.

**Nghiệm thu**
1. `node --check src/memories.js`
2. `node tools/verify.mjs` — nhóm `profile-routing` pass.
3. Thủ công trong ST: đặt Merge Profile = A, Chunk Profile = B → progress bar hiện `Chunk x/y · B`, rồi `Merging… · A`; log của Connection Manager cho thấy 2 endpoint khác nhau.

---

## M2 — Chống rò rỉ archive / stock cũ

**File:** `src/memories.js` (+ `src/commands.js`)

**Phải implement**
- Per-chat: `chatMetadata.fillTheTimeArchiveHidden` ⇄ `isArchiveIsolated()` / `setArchiveIsolated(v)`, load trong `loadRollingSummaryData()`, ghi trong `saveData()`.
- `clearArchiveEntries()` → xoá sạch archive chat hiện tại, trả về số entry đã xoá.
- `restorePreviousFromArchive()` chặn khi isolated.
- `generateActiveSummaryReplacement(options)`: bỏ base archive khi `options.ignorePrevious === true` hoặc isolated hoặc `settings.use_archive_as_regen_base === false`; luôn lọc entry có `endMsgId >= chat.length`.
- `generateRollingSummary(id, { ignorePrevious, useStock })`: `ignorePrevious` ⇒ `previousSummary: ''`; `useStock === false` ⇒ đọc raw message.
- `clearRollingSummary({ dropMergedStock = true, dropAllStock = false, dropArchive = false })`.
- `clearMergedStockedChunks()`; `clearStockedChunks()` xoá luôn checkpoint treo.
- Checkpoint có `stockKey`, resume chỉ khi khớp.
- Toast liệt kê range chunk được tái sử dụng.
- Slash: `/fillthetime-end` thêm `stock=`, `fresh=`; thêm `/fillthetime-archive-hide`, `/fillthetime-archive-clear`, `/fillthetime-stock-clear`.

**Nghiệm thu**
1. `node --check src/memories.js src/commands.js`
2. `node tools/verify.mjs` — nhóm `archive-isolation` + `stock-hygiene` pass.
3. Kịch bản thủ công (đúng case của user):
   - Chat 300 tin, active summary tới 250, archive có bản tới 250.
   - Clear active summary → **chunk đã merge bị xoá theo** (stock viewer trống hoặc chỉ còn chunk chưa merge).
   - Stock lại tới tin 65 → Create Chapter (End = 65, Fresh merge ON) → kết quả **chỉ** có nội dung tới 65.
   - Bấm *Ẩn archive* → danh sách archive biến mất, Regenerate không còn nội dung 250.

---

## M3 — UI / CSS / i18n

**File:** `templates/settings_panel.html`, `style.css`, `src/settings.js`, `locales/*.json`

**Phải implement**
- `.rmr-field-row` + `.rmr-field` dùng chung cho: hàng *End Message ID / Stages*, hàng *Summarization Connection*, hàng *Inject Depth / Role*. Bỏ `widthNatural` ở 2 input Rolling Summary. 2 box phải bằng nhau **bất kể độ dài label**.
- Đổi nhãn: `Merge Profile (final summary)` / `Chunk Profile (chunk digests + background stocking; blank = same as merge)`.
- 2 checkbox mới cạnh Create Chapter: `#rmr_merge_use_stock`, `#rmr_merge_ignore_previous` (persist vào settings).
- Thanh hành động Archive: `#rmr_archive_isolate` (ẩn/hiện), `#rmr_archive_clear` (xoá tất cả), `#rmr_archive_state` (dòng trạng thái).
- Checkbox `#rmr_use_archive_as_regen_base` trong *Summary Behavior*.
- Stock viewer: nút *Delete all* / *Delete merged*.
- Dialog Clear/Restore: 3 lựa chọn (xoá chunk đã merge / xoá toàn bộ chunk / xoá archive), ẩn *Restore latest* khi archive đang isolated.
- Progress text hiển thị tên profile.
- Thêm key i18n mới vào `vi-vn.json` và `fr-fr.json` (en là fallback inline trong code).

**Nghiệm thu**
1. `node tools/verify.mjs` — nhóm `ui-ids`, `i18n`, `css-alignment` pass.
2. Mở panel ở cả theme sáng/tối, width < 700px → 2 box xếp dọc, không vỡ.

---

## M4 — QA / tích hợp / release

**Phải làm**
- Chạy `node tools/verify.mjs` và `node --check` cho toàn bộ `.js`.
- Đọc chéo diff của M1–M3, đảm bảo không mất export công khai (danh sách ở `docs/PLAN.md §5`).
- Kiểm tra ngược tương thích: config xuất từ v3.2.0 import lại được; chat cũ có `fillTheTimeStock`/`fillTheTimeArchive` mở lên không lỗi.
- Bump `manifest.json` → `3.3.0`, cập nhật `README.md`.
- Commit theo từng nhóm thay đổi, không commit file rác.

**Nghiệm thu**: toàn bộ harness xanh + checklist thủ công ở M1/M2/M3 đã chạy.

---

## Lệnh chạy harness

```bash
cd "<đường dẫn>/Fill-the-time"
node tools/verify.mjs           # toàn bộ
node tools/verify.mjs --group profile-routing
```

Exit code `0` = pass, `1` = fail (in ra đúng invariant nào hỏng).
