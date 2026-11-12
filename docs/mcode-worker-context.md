# MCode 3.1.14 — worker context, chưa bật mặc định

## Trạng thái kiểm chứng

Audit local ngày 2026-11-12, **Desktop 3.1.14**, dùng runtime Desktop qua bridge và nguồn `token_plan`. Không cài standalone CLI, đổi provider, bật auto-consumption hoặc sửa bundle.

- Bridge startup, roster/model read, native Custom Agent create/config/readback và idempotent setup: **pass**.
- `check` với `mcodeAgent: dispatch-worker`: **pass**, không gửi model request.
- Baseline `mavis` / `MiniMax-M3.1-Flash`, thinking/max: bị **quota `42212 / 2067`**, trước khi sửa fixture hay gọi tool. Không retry hoặc thử candidate bằng một model call khác.
- Terminal telemetry có `localTokens: 10377`; đây không phải billed input usage hoặc số token giảm của candidate. Inspector GET trả HTTP 500, không được bật/thay preference capture để ép nó chạy.
- **Chưa có live candidate acceptance, full model-facing tool catalog hoặc benchmark input-token A/B. Default vẫn `mavis`.**
- 47 tests trên 5 files và backend typecheck pass, gồm quota blocker, installer ownership/revision guards, idempotence/conflict/backup và các worker contracts liên quan.

Evidence không chứa token/headers/request text: [`audit-3.1.14.summary.json`](../assets/context/mcode/audit-3.1.14.summary.json).

## Cách tối ưu đã chuẩn bị

Không đè prompt của primary `mavis` hoặc `.builtin`. Một **native Custom Agent riêng** tên `dispatch-worker` có cấu hình versioned tại [`assets/agents/mcode-worker/agent.md`](../assets/agents/mcode-worker/agent.md):

- Prompt worker 589 ký tự: chỉ làm task đã giao, thay đổi tối thiểu, kiểm tra và báo kết quả/blocker; không narration, hỏi tương tác, nested delegation hay artifact/plan ngoài yêu cầu.
- Selector `tools`: `read`, `write`, `edit`, `bash`, `task_query`, `task_output`, `task_stop`.
- `mcpServers: []`, `skills: []`; không pin model/effort, context window hoặc permission mode.

Native API xác nhận các trường này được lưu, không có diagnostic. Không gọi đó là “chỉ còn 7 runtime tools”: tool catalog cuối có thể còn host/capability/PTC behavior và cần kiểm chứng trên request thật.

### Những gì vẫn có thể nằm trong context

Custom body **không phải toàn bộ system prompt**. Source 3.1.14 vẫn ghép shared base/surface prompt, runtime rules, environment/shell, global/project instructions, skill catalog và history/tool results. `skills: []` là không preload, **không phải whitelist discovery**. Custom frontmatter không hỗ trợ `features`; không thêm khóa đó rồi giả định delegation/webSearch/memory đã tắt riêng cho agent.

Máy kiểm tra đang có global memory/autoMemory, delegation, ask-user, external skills, browser/goal/evolve tắt; webSearch và PTC bật. Installer không thay các lựa chọn global này. Máy mới không tự có cùng context chỉ vì đã tạo custom agent.

Để phân biệt các lớp: native config document của `mavis` chứa system template 42.124 ký tự với nhiều nhánh; `GetAgent(include=system_prompt)` trả 16.871 ký tự cho builtin view. Custom view trả body 589 ký tự. Các số này **không cùng nghĩa với full prepared/request prompt**, nên không suy ra phần trăm token tiết kiệm từ chúng.

## Setup sau khi clone

1. Cài/đăng nhập Desktop và chọn managed Token Plan trong app. Chạy `bun install`, `bun link` ở repo.
2. Kết nối bridge. Nếu app đang mở mà chưa có bridge, đóng bình thường trước; không kill/restart cưỡng ép.

```powershell
agent-dispatch mcode setup
bun run setup:mcode-worker --dry-run
bun run setup:mcode-worker
```

Installer chỉ hỗ trợ version đã audit **3.1.14**; version khác dừng trước mutation. Nó dùng API native, không tự ghi DB hay đọc/copy credential. Config PUT mang cả expected revision và owner-instance ID, rồi đọc lại để xác nhận. Profile trùng thì no-op; profile khác cùng tên bị từ chối, trừ `--force` có backup chính xác trong thư mục temp riêng. Không tự đổi default agent.

3. Opt in bằng advanced launch config **sau khi quota đã có lại và muốn chạy acceptance**:

```json
{
  "workerKind": "mcode",
  "mcodeAgent": "dispatch-worker",
  "project": "C:/path/to/project",
  "stage": "discovery",
  "promptFile": "C:/path/to/discovery.md",
  "notify": false
}
```

```powershell
agent-dispatch check --config .tmp/mcode-worker-run.json
agent-dispatch launch --config .tmp/mcode-worker-run.json
```

Đổi các đường dẫn theo máy. `--config` là dạng độc lập, không ghép thêm `--worker`, `--brief` hay cờ launch khác. Hai stage vẫn như bình thường; execution mới phải chọn `mcodeAgent` này trong config riêng, không suy ra nó kế thừa từ discovery. Resume giữ agent/model/session đã pin.

## Rollback và bước còn thiếu

Chọn `mcodeAgent: mavis` cho **run mới**, hoặc bỏ override để dùng default hiện tại. Không chuyển agent của một session đang resume. Có thể để custom agent nằm yên; không cần khôi phục bundle/config để opt out.

Sau khi quota thay đổi: chạy matched baseline/candidate edit + shell verification + report, rồi exact-session resume và kiểm tra model-facing tool/skill/PTC inventory. Chỉ cân nhắc default mới sau acceptance. Không retry theo timer, đổi model/provider hoặc bật auto-consumption để vượt blocker.

Hash global `config.yaml`, `.builtin/mavis/agent.md` và `agents/mavis/config.yaml` không đổi sau setup/audit. Sidecar manifest/runtime lease và native metadata của **agent mới** là các trạng thái native được tạo có chủ đích; không copy chúng sang máy khác.
