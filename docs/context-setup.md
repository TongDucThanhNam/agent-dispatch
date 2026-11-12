# Tái lập cấu hình context trên máy mới

Các cấu hình đã được đối chiếu từ máy gốc ngày **2026-11-12**. Chúng là baseline đã dùng, không phải cam kết mọi key còn hỗ trợ ở tất cả phiên bản tương lai.

| Agent | Hướng dẫn | Dữ liệu portable trong repo |
| --- | --- | --- |
| Codex | [Codex context setup](codex-context-setup.md) | `assets/context/codex/`: config fragment, model instructions, AGENTS.md |
| Claude Code | [Claude context setup](claude-context-setup.md) | `assets/context/claude/`: settings fragment và wrapper PowerShell |
| AGY worker | [AGY worker setup](agy-worker-setup.md) | `assets/agents/agy-lean/agent.md`, lệnh `bun run setup:agy` |
| ZCode | [ZCode context setup](zcode-context-setup.md) | `assets/context/zcode/`: fragments, AGENTS.md và reference overlay cũ |
| MCode Desktop | [MCode context setup](mcode-context-setup.md) | `assets/context/mcode/`: YAML fragment và reference trim cũ |

**Trạng thái quan trọng sau update:** ZCode không chạy overlay 0.16.9 trên native 0.17.1; [worker profiles](zcode-worker-profiles.md) dùng cờ native, fresh workers mặc định `files` sau khi baseline và filtered live smoke đều pass. Sau browser login chính thức, request đầu giảm 9.489 → 4.037 input tokens trong bài test đối chiếu; không thay Desktop launcher/config. MCode Desktop hiện 3.1.14: [Custom Agent worker](mcode-worker-context.md) đã cài/readback/preflight, nhưng default vẫn `mavis` vì baseline bị quota; không áp lại bản trim 2026-10-18 hoặc coi nó còn active.

## Cách dùng sau khi clone

1. Cài runtime và CLI tương ứng; đăng nhập riêng trên máy mới.
2. `bun install`, `bun link` trong repo nếu dùng agent-dispatch.
3. Làm theo hướng dẫn của từng agent. **Codex/Claude/ZCode/MCode là merge thủ công**, không chạy installer AGY rồi coi như cả năm đã được setup.
4. Backup file có sẵn trước khi sửa. Giữ nguyên model/provider, credentials, permission policy và cấu hình riêng của máy mới.
5. Kiểm tra bằng phiên mới. Desktop/IDE/dispatcher có thể thêm context hoặc không dùng wrapper shell.

## Không mang sang máy khác

- `auth.json`, `.credentials.json`, token, API key, Authorization header.
- Toàn bộ home, chat history, database, MCP runtime environment.
- Đường dẫn project/skill tuyệt đối, trust history, desktop notification handler.
- Permission bypass, model alias, context-window override chỉ vì máy cũ đang dùng chúng.

Tắt hiển thị thinking không đồng nghĩa bỏ thinking khỏi request hoặc giảm token. Đặt allow/deny cũng không luôn tương đương bỏ tool schema. Hãy kiểm tra context thực tế trên đúng bề mặt đang dùng; không coi số đo AGY là số đo của Codex/Claude.

Các file trong repo không tự cập nhật global config khi `git pull`: AGY có `setup:agy`; Codex/Claude cần merge lại phần thay đổi theo hướng dẫn.
