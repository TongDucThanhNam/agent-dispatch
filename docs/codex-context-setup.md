# Codex — lưu cấu hình tối ưu context

Snapshot máy gốc: **Codex CLI 0.167.2**, ngày 2026-11-12. Mục tiêu là tái lập phần tối ưu đã dùng, không chuyển Codex thành AGY worker và không đổi model/effort của máy mới.

## 1. File đã lưu

```text
assets/context/codex/config.fragment.toml
assets/context/codex/model-instructions.md
assets/context/codex/AGENTS.md
```

- `model-instructions.md`: prompt làm việc gọn thay cho bộ model instructions mặc định.
- `AGENTS.md`: quy tắc navigation, shell, output, encoding và xem ảnh đã dùng trên máy gốc.
- Fragment TOML: phần setting liên quan; không chứa provider, credentials, project trust, MCP command/env hay đường dẫn username cũ.

## 2. Xác định config và backup

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($name in @('config.toml', 'model-instructions.md', 'AGENTS.md')) {
    $file = Join-Path $codexHome $name
    if (Test-Path -LiteralPath $file) {
        Copy-Item -LiteralPath $file -Destination "$file.before-context-$stamp.bak" -ErrorAction Stop
    }
}
```

Đăng nhập Codex trên máy mới bằng cách bình thường. Không copy `auth.json` từ máy cũ.

## 3. Đặt instruction files và merge config

Đọc hai file Markdown trong repo trước. Với máy mới chưa có instruction riêng, từ thư mục repo chạy:

```powershell
New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
Copy-Item -LiteralPath assets/context/codex/model-instructions.md -Destination (Join-Path $codexHome 'model-instructions.md')
Copy-Item -LiteralPath assets/context/codex/AGENTS.md -Destination (Join-Path $codexHome 'AGENTS.md')
$instructions = (Join-Path $codexHome 'model-instructions.md').Replace('\', '/')
"model_instructions_file = '$instructions'"
```

Nếu đã có `AGENTS.md`/custom prompt, **merge thay vì ghi đè instruction riêng**. Hai lệnh copy trên chỉ dành cho trường hợp đã chọn dùng bản repo sau khi backup.

Mở `$codexHome/config.toml`:

1. Thêm/sửa dòng `model_instructions_file` vừa in ở **root**, trước các `[table]`. Không copy đường dẫn example `NEW_USER` nguyên xi.
2. Merge `config.fragment.toml` vào đúng các section đang có. Không append thêm `[features]`, `[skills]`, `[agents]` trùng tên.
3. Giữ model/provider, `sandbox_mode`, `approval_policy`, MCP cần dùng và setting không liên quan của máy mới.

`model_instructions_file` thay model instructions; không có nghĩa nó bỏ hết instruction do host thêm hay bỏ `AGENTS.md`. Custom prompt có thể ảnh hưởng chất lượng; file backup là đường rollback.

## 4. Ý nghĩa và giới hạn từng nhóm

| Nhóm | Baseline đã dùng | Ghi chú |
| --- | --- | --- |
| Model prompt | `model_instructions_file` | Dùng prompt gọn trong repo |
| Multi-agent | `features.multi_agent = false`, `agents.enabled = false` | Tắt hệ agent con ở cấu hình này |
| Plugin/apps | `features.plugins = false`, `features.apps = false`, `apps._default.enabled = false` | Giảm phần tích hợp không dùng; kiểm tra host thực tế |
| Skill instructions | `skills.include_instructions = false` | Bỏ block skill instructions tự động; không coi đây là xóa mọi skill khỏi disk |
| Skill cụ thể | `[[skills.config]] enabled = false` | Fragment lưu ba bundled skill theo tên; các skill theo path cần quyết định lại trên máy mới |
| Shell | `features.shell_tool = true` | Giữ shell hoạt động |
| Thinking/UI | `model_reasoning_summary`, `hide_agent_reasoning`, `show_raw_agent_reasoning`, `personality` | Không hứa rằng ẩn UI sẽ giảm context hay inference token |

Máy gốc còn có `features.js_repl = false` và `features.personality = false`, nhưng CLI 0.167.2 liệt kê hai feature đó là **removed**. Không đưa các flag removed vào template như thể chúng vẫn là công tắc hiệu quả. `personality = "none"` ở root là setting riêng.

Các preference như compression, fast mode, shell snapshot, theme và notification không được copy vào fragment tối ưu context này.

### Skill theo path và MCP

Máy gốc từng tắt nhiều skill bằng path tuyệt đối trong home/project. Không mang danh sách đường dẫn cũ sang máy mới. Chỉ thêm entry cho skill thực sự có mặt, ví dụ trong section `[[skills.config]]`:

```toml
[[skills.config]]
path = 'C:/path/on/THIS/machine/to/skill/SKILL.md'
enabled = false
```

Máy gốc tắt các MCP `link-saver`, `codex_tui`, `codex_worktrees`, `zread`, `cua_repl`, `blender`; `node_repl` vẫn có cấu hình active do runtime cung cấp. Đây là inventory tham khảo, **không phải khuyến nghị disable toàn bộ trên máy mới**. Với server không dùng, sửa `enabled = false` trong table server đã có; không copy command/env/token từ máy cũ.

## 5. Kiểm tra và rollback

```powershell
codex --version
codex features list
codex mcp list
```

Mở phiên Codex mới và xem `/status`, `/skills`, phần context có sẵn trên bản đang dùng. Nếu dùng Desktop/IDE, kiểm tra đúng tại đó: host có thể thêm tools, developer instructions và MCP khác với CLI.

Không dùng báo cáo audit cũ tháng 09/2026 làm số token hiện tại: file prompt đã thay đổi sau báo cáo đó. Hướng dẫn này không tạo một phép đo request/token mới.

Muốn rollback: khôi phục các file `.before-context-*.bak` đã tạo; hoặc bỏ `model_instructions_file` để trở lại model instructions mặc định, rồi khôi phục các feature cần dùng.

Nguồn: [OpenAI configuration reference](https://developers.openai.com/codex/config-reference/). Snapshot file và trạng thái feature CLI trên máy gốc là nguồn cho các key/flag phụ thuộc phiên bản ở trên.
