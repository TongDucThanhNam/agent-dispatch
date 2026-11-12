# AGY worker — setup sau khi clone sang máy khác

Mục tiêu: `delegate-to-agy` dùng AGY như worker nhỏ, không mang theo bộ prompt/UI/tool dư của agent tổng quát. Đây là checklist cho Windows; không cần chép thư mục home từ máy cũ.

## 1. Cài prerequisites và đăng nhập

- Git, Node.js, Bun >= 1.4.
- [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli), có `excludeDefaultComponents` (CLI >= 1.2.1; đã kiểm tra với 1.5.6).
- `rg`, `ast-grep`, Git Bash nếu task/repository cần các công cụ đó.
- Codex hoặc Claude Code, tùy agent gọi worker.

Mở `agy`, đăng nhập bằng tài khoản của **máy mới**, dùng `/model` chọn model muốn dùng rồi thoát. Không copy token, credentials hay toàn bộ settings của máy cũ.

Windows mặc định tìm AGY tại `%USERPROFILE%/AppData/Local/agy/bin/agy.exe`. Nếu cài chỗ khác, dùng advanced run config `agyExe` trỏ tới executable đúng.

## 2. Clone repo và setup

Sau khi clone repo này và vào thư mục `agent-dispatch`, chạy:

```powershell
bun install
bun link
bun run setup:agy
bun run build:web
agent-dispatch skills install --worker agy --include-missing
```

`bun link` đưa `agent-dispatch` lên PATH. Lệnh skills cài thin skill `delegate-to-agy` cho Codex/Claude; implementation vẫn nằm trong repo này.

`setup:agy` lấy profile versioned tại:

```text
assets/agents/agy-lean/agent.md
```

và cài vào home của user hiện tại:

```text
~/.gemini/config/agents/lean/agent.md
```

Không có đường dẫn username của máy cũ trong profile. Không sửa PowerShell profile, settings AGY, model hay permission toàn cục.

## 3. Xác minh

```powershell
agy agent
agent-dispatch models --worker agy
agent-dispatch guide agy
agent-dispatch doctor
```

- `agy agent` phải liệt kê `lean`.
- `models --worker agy` phải đọc được model đã chọn.
- `guide agy` phải nói fresh run chọn `lean`.
- `doctor` phải thấy executable AGY và Node. Các worker khác chưa cài có thể báo thiếu; không bắt buộc cài tất cả worker.

Smoke test tùy chọn, có dùng quota:

```powershell
agy --agent lean -p "Reply with exactly OK. Do not use tools." --output-format json --print-timeout 45s
```

Kết quả cần là `SUCCESS`, response `OK`. Trên máy gốc, Gemini 4 Argon High dùng 1.006 input token cho bài thử này, so với 12.774 ở agent mặc định. Đây không phải cam kết token cố định cho model/version khác.

## 4. Dùng với delegate-to-agy

Gọi skill `delegate-to-agy` trong Codex/Claude như bình thường. Fresh run của `agent-dispatch --worker agy` tự truyền `--agent lean`, lưu lựa chọn trong run config và giữ khi resume. Run cũ không bị tự chuyển profile.

**Không cần wrapper PowerShell:** dispatcher spawn thẳng executable AGY. Khi dùng AGY thủ công, chọn rõ `agy --agent lean`; chỉ chạy `agy` trên máy mới vẫn là agent mặc định.

Worker chỉ có `run_command` và `manage_task`; đọc/ghi/sửa file qua shell. `excludeDefaultComponents: true` bỏ các khối UI/artifacts/style mặc định. Prompt worker giữ ràng buộc an toàn ngắn và làm theo scope, test, report path/format của brief. Không tự nạp skill/plugin/MCP/rule/hook project; worker được yêu cầu đọc instruction repository khi làm việc.

Model/effort được dispatcher đọc từ lựa chọn hiện tại và pin theo run. Dispatcher vẫn dùng `--dangerously-skip-permissions` cho công việc unattended đã được giao; setup không thay đổi thiết lập permission toàn cục.

## 5. Update, backup và opt out

Sau `git pull`, chạy lại:

```powershell
bun run setup:agy --dry-run
bun run setup:agy
```

- Giống bản trong repo: `unchanged`, không ghi lại file.
- Chưa có profile: cài mới.
- Có profile khác: dừng, không tự ghi đè. Nếu muốn thay bằng bản trong repo:

```powershell
bun run setup:agy --force
```

File cũ được backup cạnh target dưới tên `agent.md.bak-<unique-id>`; output in đường dẫn backup. File backup không có đuôi `.md`, không được discover như một agent khác.

Muốn dùng agent khác, đặt `agyAgent` trong advanced JSON run config; đặt `null` để dùng default AGY. Khi gọi `--config`, không trộn với các launch option khác. Muốn hoàn tác profile, khôi phục backup đã ghi trong output setup.

Nếu CLI báo không thấy agent `lean`, kiểm tra lại `bun run setup:agy` và `agy agent`; không bỏ `--agent` để âm thầm quay về harness nặng.

## Thứ được lưu trong Git

- Profile: `assets/agents/agy-lean/agent.md`.
- Installer: `scripts/setup-agy.ts`, lệnh `bun run setup:agy`.
- Dispatcher default và test trong `src/core/config.ts`, `test/agy-adapter.test.ts`.
- Hướng dẫn này và guide ngắn `assets/guide/agy.md`.

Không lưu credentials, lịch sử chat, dữ liệu run, PowerShell profile hoặc snapshot database cá nhân.

Tham khảo: [CLI changelog v1.2.1 — excludeDefaultComponents](https://antigravity.google/docs/changelog).
