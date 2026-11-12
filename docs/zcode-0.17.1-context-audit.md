# ZCode 0.17.1 — phân tích context trước khi tối ưu

Audit ngày **2026-11-12**. **Chưa thay đổi runtime/config của ZCode hoặc argv của dispatcher.** Mục tiêu là xác định đúng phần dư và thử các profile offline, không ép overlay 0.16.9 chạy trên bundle mới.

Đây là báo cáo ở thời điểm trước triển khai. Sau audit, dispatcher đã thêm [worker profiles](zcode-worker-profiles.md) bằng cờ native; không sửa installed bundle hay Desktop/global config. Live verification đang được ghi riêng, không biến số đo offline ở đây thành token benchmark.

## 1. Kết luận chính

**Nên cắt tool catalog trước, không patch system prompt trước.** Với fixture native 0.17.1 đã kiểm tra, prompt lõi chỉ 2.802 ký tự; tool description + schema là 28.936 ký tự. Chỉ riêng AskUserQuestion hoặc EnterPlanMode đã dài hơn toàn bộ prompt lõi.

CLI hiện có `--disallowed-tools` / `--disallowedTools`: bỏ nguyên tool theo từng run, không thay permission policy hay saved settings. Đây là đường ưu tiên cho `delegate-to-zcode` worker. Các simulation dùng chính registration/filter và `getTools(model)` của runtime; retained provider contracts, metadata và source các tool function được so sánh không đổi.

## 2. Phương pháp và độ chắc chắn

- Bundle được đọc từ installation local; SHA-256:
  `d9afd58d694f98a5279bf548cdc7646413c125762e86730605a6071f9e0346d6`.
- Syntax navigation bằng ast-grep; TypeScript AST xác định và đọc các symbol liên quan, không áp rewrite lên file cài đặt.
- Audit chạy trong process Node riêng: tắt entrypoint CLI trong bản source **in-memory** để render registry/context builder; không sửa bundle trên disk, không chạy model inference. Audit process chặn global fetch.
- Khởi tạo native tool registry, chạy production `getTools(model)` với tool search off, rồi context builder cho terminal và fixture Desktop. Không lấy raw registration list làm danh sách gửi cho model.
- Model probe là **synthetic**: tool-call, image, native web search được bật; PDF/video/audio capability trong probe tắt. Không phải account-resolved model snapshot. Kích thước Read/schema và catalog có thể thay theo model/host.
- Baseline giả định subagent/send-message ports có mặt, skill và dynamic workflow không có. User settings đang tắt plugin/MCP/skill/memory; các port/feature tùy host được kiểm tra riêng bằng allOptional scenario.
- Các số dưới đây là **ký tự của cùng representation**, không phải tokenizer/billed tokens. Native `tokens` trong context builder cũng chỉ là weighted-character heuristic. Không dùng nó làm số token GLM chính xác.

Tái lập offline trên đúng bundle:

```powershell
node scripts/audit-zcode-context.cjs
```

Kết quả/raw exports nằm trong `.tmp/zcode-context-audit-0.17.1/` (git-ignored). Script pin hash, dừng khi bundle khác; không đổi hash để ép chạy sau update. Có thể đặt `ZCODE_INSTALL_DIR` cho vị trí cài đặt khác, `ZCODE_CONTEXT_AUDIT_OUT` cho thư mục output khác.

Summary portable: `assets/context/zcode/audit-0.17.1.summary.json`. Không đưa credentials, nội dung hội thoại, URL attachment, database hoặc bundle vào repo.

## 3. Prompt lõi còn gì?

| Section | Ký tự nội dung | Nhận xét |
| --- | ---: | --- |
| CLI prefix | 35 | Identity/branding ngắn |
| Agent identity + Harness | 1.229 | Authorized security scope, permission denial, mid-conversation rules, tool use và code references; giữ |
| Dynamic behavior | 975 | Style, pronouns, authorization cho hành động irreversible/external, báo kết quả trung thực |
| Context management | 559 | Tiếp tục sau compaction, không hỏi/re-derive vòng lặp; hữu ích cho worker dài |
| Environment, meta-user | 683 | Workspace/shell và quy tắc an toàn cho file/archive không tin cậy; giữ |
| Session context, meta-user | 435 | Fixture git status/commits và lời nhắc không kể lại account/workspace context |
| Date, meta-user | 27 | Ngày hiện tại |

System messages tổng cộng **2.802 ký tự** (gồm separator); meta-user sections **1.145 ký tự**. Chưa gồm user prompt, global/project AGENTS.md, lịch sử, hook/host additions hoặc media.

Máy gốc còn global `~/.zcode/AGENTS.md` khoảng **3.453 ký tự**: một cheatsheet navigation/ast-grep khá dài và preference luôn trả lời English. Đây là instruction riêng, không bị tắt bởi flags plugin/skill. Có thể nén sau khi giữ đủ routing, ignore files, rewrite dry-run và shell/encoding rules; không âm thầm đổi preference cho mọi session.

Fixture `zcode_desktop` thêm khoảng **1.802 ký tự system text**, chủ yếu hướng dẫn Gen UI, links và inline code comments. Đây chỉ là render của cùng builder với Desktop surface, **không phải export toàn bộ request của app Desktop** hoặc mọi host-injected tool.

Overlay cũ không nên bê nguyên sang: replacement `contextManagement` trong profile 0.16.9 dài **824 ký tự**, còn stock hiện tại chỉ **559**. Đè đoạn cũ lên có thể làm dài thêm thay vì ngắn đi.

## 4. Tool overhead: phần nào đáng cắt?

Baseline model-facing fixture có 16 tool. Mô tả + input schema của các nhóm lớn:

| Tool/nhóm | Ký tự | Hướng cho worker |
| --- | ---: | --- |
| AskUserQuestion | 4.809 | Bỏ; missing essential → báo blocker cho orchestrator |
| EnterPlanMode + ExitPlanMode | 6.801 | Bỏ ở worker đã có brief/plan; không thay quyền `--mode plan` nếu caller dùng chế độ đó |
| ReadSessionContext | 2.834 | Bỏ mặc định; caller cấp digest/reading map thay vì worker đọc transcript khác |
| Agent + SendMessage | 3.074 | Bỏ nested delegation mặc định; orchestrator sở hữu việc chia task |
| TodoRead + TodoWrite | 1.201 | Có thể bỏ; dùng acceptance checklist/report của caller |
| Bash | 2.710 | Giữ |
| TaskOutput + TaskStop | 1.961 | Giữ khả năng lấy kết quả và dừng background task |
| WebFetch + WebSearch | 1.586 | Opt-in cho task cần web |

Số nhóm chưa gồm JSON wrapper/name overhead nên không cộng trực tiếp thành tổng catalog. Các schema retained được so sánh đúng representation và model probe, không chỉnh field/constraint/risk budget.

### Những thứ đã tự biến mất trong branch hiện tại

- Có Bash thì runtime chọn embedded-search branch và bỏ Glob/Grep; không cần patch riêng để bỏ chúng lần nữa.
- ToolSearch/DeferredToolCall có trong registry thô nhưng **không có trong provider-facing fixture khi `toolsearch-mode=off`**.
- Skill/workflow/automation/off-peak/js tool không có trong baseline nếu các port/features tương ứng không bật. allOptional fixture có 36 tool và khoảng 75.299 ký tự schema/description; đó là khả năng mở rộng, không phải inventory đã chứng minh active ở app hiện tại.
- Explore system prompt thuộc context của subagent khi được chạy; không cộng cả template đó như một block cố định trong primary prompt.

## 5. Các phương án đã thử offline

| Profile | Tool giữ | Schema + descriptions | Fixed representation* | Giảm fixed so baseline |
| --- | --- | ---: | ---: | ---: |
| Baseline fixture | 16 | 28.936 | 32.883 | — |
| Worker + web | 8 | 9.529 | 13.476 | 59,0% |
| Worker file/code | 6 | 7.827 | 11.774 | 64,2% |
| Shell-only worker | 3 | 4.853 | 8.800 | 73,2% |

*Fixed representation = projected tool JSON + system messages + meta-user section content. Không phải wire request hoặc token count; chưa gồm AGENTS/history/actual task/media. Cộng nguyên global AGENTS hiện tại thì baseline khoảng 36.336 ký tự, worker file/code khoảng 15.227 (giảm khoảng 58,1%).

**Khuyến nghị mặc định: 6 tool** `Read, Write, Edit, Bash, TaskOutput, TaskStop`. Giữ thao tác file có cấu trúc, tiện cho image/file inspection mà không bắt mọi edit đi qua quoting của shell. Profile 3 tool gọn hơn nhưng tăng phụ thuộc shell scripts; không cần chọn nó chỉ để giống AGY.

Task research cần web thì dùng profile 8 tool. Không tự bật web, nested agent hoặc toàn bộ plugin chỉ vì worker thiếu một fact mà caller có thể cung cấp.

Simulation dùng denylist native, không chỉ bảo model “đừng dùng tool”. Nó giữ protocol-control tools khỏi denylist để không vô tình phá report/handshake trong các host branch khác; các tool protocol không đăng ký trong main fixture này.

## 6. Dữ liệu phiên cũ: framework không phải toàn bộ vấn đề

Đọc **metadata/kích thước**, không copy nội dung hội thoại, từ một session local 0.17.1 gần đây:

- 14 main-turn model-usage records; `input_tokens` ghi nhận từ **15.986 → 132.696** qua hội thoại.
- Có **video/mp4 attachment**. Vì vậy không thể quy toàn bộ tăng trưởng cho framework/tool schema.
- Có 7 tool usage: Read 1, WebSearch 4, WebFetch 2. Read output được telemetry ghi khoảng **50.665 byte**; tổng tool-part output khoảng **63.219 ký tự**.
- Stored reasoning text khoảng **143.594 ký tự**, text parts khoảng **50.681 ký tự**. Nội dung lưu trên disk không chứng minh toàn bộ reasoning được gửi nguyên lại ở mọi request; phải kiểm tra provider replay policy trước khi cân nhắc cắt.
- Các request cuối có cache-read lớn. Cache có thể giảm chi phí/latency nhưng không tương đương giảm active context window.

Sau phần fixed overhead, hướng tối ưu tiếp là scope output/file reads, giao digest/reading map, không chuyển toàn video/transcript nếu task chỉ cần vài mốc, và dùng session mới cho task không liên quan. Không tự cắt media/evidence cần thiết hoặc strip reasoning mà chưa kiểm tra tính đúng.

## 7. Đề xuất thứ tự triển khai tiếp theo

1. Thêm profile worker **theo từng launch** trong adapter ZCode, dùng `--disallowed-tools`, pin `--toolsearch-mode off`, `--workflow-mode disabled`; giữ nguyên model/effort/permission mode và resume ownership.
2. Mặc định file/code 6 tool, web opt-in theo task; không đổi global Desktop profile.
3. Smoke-test bằng worker thật: đọc/sửa file, chạy kiểm tra và ghi đúng report. Nếu cần so token, dùng fresh run cùng model, cùng input; không dùng byte/char estimate làm billed token.
4. Chỉ sau đó cân nhắc nén instruction riêng. Prompt stock hiện khá ngắn; chưa có lý do patch whole bundle hoặc thay system prompt qua API nội bộ.
5. Desktop cần audit đúng surface riêng. Không tái cài command override từng gây lỗi storage startup.

Phân tích này **chưa áp dụng** các bước trên vào worker runtime. Kết quả offline và denylist đã đủ để triển khai bước 1 mà không cần phục hồi overlay cũ.

Nguồn: native 0.17.1 `--help` và source local đã pin hash; [ZCode subagents](https://zcode.z.ai/en/docs/subagents), [usage/context stats](https://zcode.z.ai/en/docs/usage-stats), [model context window rules](https://zcode.z.ai/en/docs/configuration).
