# ZCode — context setup và trạng thái overlay cũ

Kiểm tra local ngày **2026-11-12**: bundled native CLI hiện tại là **0.17.1**. Phải phân biệt phần config thông thường với overlay source đã làm trước đây.

Phân tích trước triển khai: [ZCode 0.17.1 context audit](zcode-0.17.1-context-audit.md). Dispatcher dùng [worker profiles](zcode-worker-profiles.md) qua cờ native, không phục hồi overlay cũ và không sửa Desktop launcher/config. Fresh workers mặc định `files` sau khi baseline và filtered live smoke đều pass; dùng `stock` để bỏ filtering. Browser login chính thức đã giải quyết blocker auth trên máy kiểm tra; xem hướng dẫn Windows trong trang worker profiles.

## 1. Hiện tại phần nào còn dùng được?

| Lớp | Trạng thái đã quan sát |
| --- | --- |
| `~/.zcode/cli/config.json` | Còn các setting tắt plugin, skill, MCP, memory |
| `~/.zcode/v2/setting.json` | `memoryEnabled = false`, workflow disabled, proactive suggestions off; một số preference UI/search |
| CLI tool/prompt overlay 0.16.9 | **Không áp dụng vào bundle hiện tại**: SHA-256 khác, loader fallback stock đúng thiết kế |
| Dispatcher worker profiles | Opt-in: `files`/`web`/`shell` có native filtering; không truyền profile thì giữ nguyên launch cũ |
| ZCode Desktop | Dùng bundled resolver; không được coi là đang chạy CLI overlay |

Chạy `zcode native --version` qua helper có sẵn trên máy gốc in:

```text
[ZCode context profile] Bundle version changed; using stock behavior. Re-audit before patching.
0.17.1
```

Đây là kiểm tra local không gọi model. `enabled: true` trong profile cũ **không chứng minh overlay đang hoạt động**.

## 2. File portable trong repo

```text
assets/context/zcode/config.fragment.json
assets/context/zcode/desktop-settings.fragment.json
assets/context/zcode/AGENTS.md
assets/context/zcode/overlay-0.16.9.profile.reference.json
assets/context/zcode/audit-status.json
```

Hai file cuối chỉ là **tư liệu overlay cũ**, không phải installer cho 0.17.1. Không đưa bundle, rewrite-preview source, provider registry, token hay request capture vào repo.

`AGENTS.md` giữ nguyên instruction navigation trên máy gốc, kể cả dòng **ALWAYS RESPOND IN ENGLISH**. Đây là preference cá nhân, không bắt buộc để giảm context; đọc và chỉnh ngôn ngữ trước khi dùng.

## 3. Setup config trên máy mới

1. Cài ZCode, mở app và đăng nhập/kết nối model riêng trên máy mới. Chạy app một lần để tạo data/config.
2. Đóng app bình thường trước khi sửa config, tránh app ghi đè thay đổi khi thoát. Không kill app hoặc xóa database.
3. Backup các file có sẵn:

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($relative in @('.zcode/cli/config.json', '.zcode/v2/setting.json', '.zcode/AGENTS.md')) {
    $file = Join-Path $HOME $relative
    if (Test-Path -LiteralPath $file) {
        Copy-Item -LiteralPath $file -Destination "$file.before-context-$stamp.bak" -ErrorAction Stop
    }
}
```

4. Merge `config.fragment.json` vào `~/.zcode/cli/config.json`:
   - `plugins.enabled = false` và các official plugin entry tắt.
   - `skills.enabled = false`, `features.skill = false`.
   - `features.mcp = false`, `features.memory = false`, `memory.use = false`.
   - Giữ provider/model, credentials, permission policy, hooks và config không liên quan.
5. Merge `desktop-settings.fragment.json` vào `~/.zcode/v2/setting.json` nếu muốn dùng cùng preference. Không thay toàn bộ file desktop settings vì nó còn chứa workspace/account/connection state.
6. Tùy chọn merge `AGENTS.md` vào instruction cá nhân, không ghi đè instruction đang dùng mà chưa đọc.
7. Mở lại app và tạo **phiên mới** để kiểm tra plugin/MCP/skill/memory thực tế. Một số key phụ thuộc version; JSON parse thành công chưa chứng minh runtime honor tất cả key.

`nativeSearchEnhancementsEnabled` và `toolSearchMode` là preference search của máy gốc, không phải bằng chứng native tools đã biến mất. `messageStreamShowReasoning` chỉ là hiển thị; `messageStreamShowTodos` vẫn true. Không coi toàn bộ desktop fragment là phép cắt system prompt.

Máy gốc còn tắt từng MCP server đã đăng ký. Fragment không copy URL, command/env hay từng server của máy cũ; review và tắt server không cần dùng trên máy mới. Không mang theo skill entry bằng path tuyệt đối.

## 4. Dùng với agent-dispatch

Từ clone repo sau `bun install`, `bun link`:

```powershell
agent-dispatch models --worker zcode
agent-dispatch skills install --worker zcode --include-missing
agent-dispatch guide zcode
agent-dispatch doctor
```

Mặc định Windows dùng `C:/Program Files/ZCode`; đổi `ZCODE_INSTALL_DIR` hoặc advanced `zcodeInstallDir` nếu cài nơi khác. Dispatcher dùng bundled native CLI và `assets/node/native-config-loader.mjs`, không giả định desktop đang dùng cùng overlay.

Loader của dispatcher đã có optional import `~/.zcode/context-tuning/loader.mjs`; trên máy mới không có file đó thì không có overlay. Việc import được cũng không thay thế kiểm tra version/hash. CLI helper `zcode` cài riêng trên máy gốc không phải prerequisite bắt buộc chỉ để merge fragment; đừng copy launcher có username cũ.

Khi có worker profile (mặc định `files` cho fresh runs), child dùng `ZCODE_CONTEXT_PROFILE=stock` để không chạy overlay cũ. Legacy resume không tự nhận profile. Advanced JSON `zcodeContextProfile: null` giữ argv/environment cũ để đối chứng; `--context-profile stock` bỏ filtering và vô hiệu overlay cũ trong child. Xem giới hạn và kiểm tra live trong [worker profiles](zcode-worker-profiles.md).

## 5. Overlay 0.16.9: lưu để biết, không tự kích hoạt

Overlay trước đây lọc built-in tools và rút ngắn tool description/schema description cùng một số đoạn prompt. Nó giữ nguyên validation, executor, permission và protected/identity instructions. Sau lần bỏ plan tools, profile nhắm giữ 12 tool tùy host/model gates, không phải worker hai tool kiểu AGY.

Hash bundle được overlay cũ hỗ trợ:

```text
31965ce1d5d4a808ef156784f67996de42ccab335591d2386a61ea8f6f506a54
```

Hash bundle 0.17.1 đã quan sát ngày audit:

```text
d9afd58d694f98a5279bf548cdc7646413c125762e86730605a6071f9e0346d6
```

**Không đổi expected hash sang hash mới để ép chạy.** Muốn có overlay cho runtime mới phải locate lại symbols bằng AST, dry-run/inspect rewrites, xác minh schema constraints, permission/executor, read-only agent, protected prompt và stock fallback; sau đó kiểm tra đúng đường CLI/dispatcher. Repo hiện không tự cài overlay cũ.

Không tái tạo override `ZCODE_AGENT_SERVER_COMMAND` / `ZCODE_AGENT_SERVER_ARGS_JSON` để gắn overlay vào Desktop: thử nghiệm 0.16.9 từng làm desktop vướng `preparing_session_storage` / `unsupported_runtime` do thiếu metadata storage startup. Bundled resolver là đường đã khôi phục. Không copy biến môi trường override của máy cũ.

Các số giảm khoảng 58% từng ghi nhận là **character count offline của profile cũ**, không phải token billable hay hiệu quả hiện tại của 0.17.1. Không dùng làm benchmark mới.

## 6. Rollback

Khôi phục các file `.before-context-*.bak` sau khi app đã đóng bình thường. Overlay cũ nếu còn trên máy riêng có escape hatch `ZCODE_CONTEXT_PROFILE=stock` cho process CLI; trên máy mới theo hướng dẫn này không cài loader nên không cần restore bundle.

Nguồn: [ZCode FAQ — config locations](https://zcode.z.ai/en/docs/qa), [plugins](https://zcode.z.ai/en/docs/plugin). Trạng thái version/hash và overlay là kết quả đọc source/config local, không phải API public ổn định.
