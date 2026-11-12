# Claude Code — lưu cấu hình tối ưu context

Snapshot máy gốc: **Claude Code 2.1.322**, ngày 2026-11-12. Đây là bộ setting + allowlist đã dùng; không phải thay toàn bộ system prompt bằng prompt worker AGY.

## 1. File đã lưu

```text
assets/context/claude/settings.fragment.json
assets/context/claude/claude-profile.ps1
```

Fragment chỉ chứa phần context/tool/skill đã chọn; không chứa model alias, provider/token, `permissions.defaultMode`, theme hoặc lựa chọn context window của máy cũ. Một số key đặc thù phiên bản có thể đổi; nếu bản mới báo không nhận key thì kiểm tra schema/help của CLI đang cài, không assume key bị bỏ qua vẫn có tác dụng.

## 2. Backup và merge settings

Đăng nhập Claude riêng trên máy mới. Xác định config directory:

```powershell
$claudeHome = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$settings = Join-Path $claudeHome 'settings.json'
if (Test-Path -LiteralPath $settings) {
    Copy-Item -LiteralPath $settings -Destination "$settings.before-context-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak" -ErrorAction Stop
}
```

Đọc `settings.fragment.json`, rồi merge các key cần dùng vào settings hiện có. Không ghi đè toàn bộ file nếu máy mới đã có cấu hình.

- `permissions`: merge danh sách `deny`; giữ `allow`, `ask`, default mode và các rule bảo vệ của máy mới.
- `env`: chỉ merge `CLAUDE_CODE_DISABLE_AUTO_MEMORY`; không thay toàn bộ environment map.
- `skillOverrides`: các tên được đặt `off` trên máy gốc; chỉ giữ entry phù hợp với skill đang cài ở máy mới.
- `enabledPlugins: {}` và `extraKnownMarketplaces: {}` là trạng thái trống ở máy gốc, không phải patch tự xóa entry khi deep-merge. Tắt plugin không dùng một cách rõ ràng trên máy mới.

Máy gốc có `~/.claude/CLAUDE.md` gần như trống. Không cần chép file trống và không xóa instruction project chỉ để tái lập trạng thái này.

## 3. Các phần tối ưu đã lưu

- Hạn chế skill listing bằng `skillListingBudgetFraction = 0.001`, `maxSkillDescriptionChars = 512`; tắt bundled skills và một số skill cụ thể.
- Tắt connector tự động, workflows, artifacts, remote control và các surface không dùng qua các key snapshot trong fragment.
- Tắt auto memory và thinking summaries. **Ẩn summaries không chứng minh reasoning token bị bỏ**; một số key chỉ đổi UI/hành vi, không trực tiếp cắt schema.
- Danh sách deny giữ nguyên từ máy gốc: agent/subagent, cron/schedule, task tracking, artifact/workflow, plan/worktree, Glob/Grep, MCP resource helpers và các tool phụ khác.

Phân biệt `permissions.deny` với `--tools`: deny là quy tắc permission; `--tools` là danh sách built-in tool được expose. Không dùng deny làm bằng chứng duy nhất rằng schema của tool đã biến mất.

Các setting máy gốc **không tự mang theo**: model/advisor `fable`, effort theo model, `autoCompactWindow = 300000`, bypass permission, và `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP`. Chúng là lựa chọn model/security/lifecycle riêng, không cần để tái lập baseline context.

## 4. Nạp wrapper allowlist trên Windows

Từ thư mục repo, nạp cho PowerShell hiện tại:

```powershell
. ./assets/context/claude/claude-profile.ps1
Get-Command claude | Select-Object -ExpandProperty CommandType
```

Kết quả là `Function`. Wrapper giữ các lệnh quản lý (`auth`, `mcp`, `plugin`, `update`...) và lựa chọn `--tools` tường minh; phiên chat thông thường được thêm:

```text
Bash,PowerShell,Read,Edit,Write,ToolSearch,WebFetch,WebSearch,Skill,AskUserQuestion
```

**Chi tiết snapshot:** `PowerShell` có trong allowlist nhưng cũng có trong `permissions.deny` của máy gốc. Giữ nguyên cả hai để không âm thầm đổi policy; không khẳng định mười tên trên đều usable. Nếu muốn dùng PowerShell tool riêng, phải chủ động review rule deny đó. Bash vẫn có thể gọi PowerShell executable khi được policy cho phép.

Muốn giữ wrapper qua các lần mở terminal, backup/merge `$PROFILE.CurrentUserAllHosts` và thêm đúng **một** dòng dot-source trỏ tới đường dẫn tuyệt đối của `assets/context/claude/claude-profile.ps1` trong clone mới. Tìm đường dẫn bằng:

```powershell
(Resolve-Path ./assets/context/claude/claude-profile.ps1).Path
```

Không chép cả profile PowerShell từ máy cũ; file đó còn chứa wrapper AGY và cấu hình khác. Nếu repo di chuyển, cập nhật dòng dot-source. Wrapper này dành cho Windows (`claude.exe`); ở shell khác truyền `--tools` trực tiếp.

`claude.exe` gọi thẳng binary và bỏ qua wrapper. `--tools` không tự giới hạn MCP tools; kiểm tra MCP/connector riêng.

## 5. Quan trọng với agent-dispatch

`delegate-to-claude`/adapter spawn executable trực tiếp, nên **không nhận wrapper PowerShell**. Global settings vẫn áp dụng theo config directory, nhưng adapter hiện tại **chưa truyền allowlist `--tools`**.

Hướng dẫn này lưu đúng hiện trạng, không tự thay đổi Claude worker. Không hứa Claude delegated worker có cùng tool schema với phiên `claude` mở từ wrapper. Muốn đồng bộ phần đó cần sửa adapter và kiểm tra riêng, không sửa thin skill.

## 6. Xác minh và rollback

```powershell
claude.exe --version
claude.exe --help
```

Mở **phiên mới bằng `claude`**, kiểm tra `/context`, `/mcp`, `/skills`, `/config` hoặc `/doctor` theo phiên bản. Kiểm tra các tool và skill thực tế, không chỉ kiểm tra JSON parse. Bản mới có thể giữ một số tool bắt buộc dù allowlist bỏ tên đó.

Nếu MCP có key/header riêng, cấu hình lại trên máy mới; không copy `.claude.json` hay `.credentials.json` từ máy cũ. Không có phép đo token Claude mới trong tài liệu này.

Rollback settings bằng backup; bỏ dòng dot-source khỏi PowerShell profile hoặc chạy `claude.exe` để bỏ qua wrapper.

Nguồn: [Claude CLI reference — tools/system-prompt flags](https://code.claude.com/docs/en/cli-reference), [settings và precedence](https://code.claude.com/docs/en/settings). Các key khác được lưu theo snapshot local 2.1.322, không coi tất cả đều là API ổn định.
