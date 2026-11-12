# ZCode worker profiles — tối ưu mà không sửa Desktop

Fresh workers mặc định **`files`**, sau khi baseline và profile này đều pass live smoke test trên native 0.17.1. Thay đổi chỉ nằm trong argv/environment của child process; không sửa bundle, Desktop launcher/config hay environment User/Machine. Resume giữ profile đã lưu; legacy resume không tự chuyển sang profile mới. Native authentication vẫn có thể cập nhật credential store theo hành vi thông thường.

## Profile

| Tên | Built-in tools mục tiêu trên native 0.17.1 |
| --- | --- |
| `files` (default fresh run) | Read, Write, Edit, Bash, TaskOutput, TaskStop |
| `web` | files + WebFetch, WebSearch |
| `shell` | Bash, TaskOutput, TaskStop |
| `stock` | Không thêm denylist/toolsearch/workflow flags; bỏ qua context overlay cũ trong child |

Ba profile gọn dùng cờ native `--disallowed-tools`, `--toolsearch-mode off`, `--workflow-mode disabled`. Model, effort và `--mode` giữ nguyên. Bỏ EnterPlanMode/ExitPlanMode tool không bỏ policy read-only khi caller chọn `--mode plan`.

Đây là built-in tool policy; không giả định nó loại được MCP/host tools ngoài inventory. Native inventory có thể đổi sau update: chạy audit theo đúng version trước khi khẳng định vẫn đúng sáu tool.

## Cách dùng

Sau khi xác thực native đã hoạt động, không cần truyền profile cho task file/code:

```powershell
agent-dispatch check --worker zcode --stage discovery --brief .tmp/discovery.md --notify none
agent-dispatch launch --worker zcode --stage discovery --brief .tmp/discovery.md
```

Task cần web:

```powershell
agent-dispatch launch --worker zcode --stage discovery --brief .tmp/discovery.md --context-profile web
```

Chọn profile khi bắt đầu **mỗi fresh stage**; execution mới từ discovery là run mới, mặc định `files` chứ không tự kế thừa profile web của discovery. `check` và receipt hiển thị `contextProfile`. Advanced JSON run config dùng key `zcodeContextProfile` với cùng bốn giá trị; explicit `null` giữ đường argv/environment cũ để đối chứng. Nếu bỏ key/cờ ở fresh run, default là `files`.

Resumes giữ profile đã lưu trong run config. Legacy resumes không có profile được giữ `null`: không tự thêm flags hay đổi biến context overlay. CLI `resume` không có cờ đổi profile để tránh thay toolset ngầm giữa phiên.

## Giới hạn ảnh hưởng và rollback nhanh

- `ZCODE_CONTEXT_PROFILE=stock` chỉ được đặt trong environment của worker có profile (gồm default `files`); nó ngăn legacy in-memory overlay tác động vào child. Không sửa giá trị User/Machine hoặc file profile cũ.
- Không thay `ZCODE_AGENT_SERVER_COMMAND` hay `ZCODE_AGENT_SERVER_ARGS_JSON`.
- Không thay bundle, `~/.zcode/cli/config.json`, `~/.zcode/v2/setting.json`, provider config hay context-tuning profile.
- Không gọi/restart Desktop. `desktop <ref>` vẫn là handoff sang app, không cam kết app dùng cùng worker toolset.
- Preflight đọc bundle để kiểm tra sự có mặt của các cờ cần thiết trước khi tạo run. Đây là capability advertisement check, không phải bảo đảm tương thích mọi version tương lai. CLI không có cờ thì dừng, không tự fallback âm thầm.
- Protocol-control tools RespondToCoordinator/submit_result/escalate không nằm trong denylist.

Muốn dùng toolset gốc đồng thời bỏ qua legacy context overlay riêng trong child thì chọn `stock`:

```powershell
agent-dispatch launch --worker zcode --stage discovery --brief .tmp/discovery.md --context-profile stock
```

Muốn giữ chính xác argv/environment cũ để đối chứng, dùng advanced JSON `zcodeContextProfile: null`. Không bỏ cờ rồi coi như đã rollback: fresh run không có cờ vẫn mặc định `files`.

Không cần restore app/config chỉ để opt out vì profile không ghi các file đó. Nếu một run đã bắt đầu/đã lỗi, inspect nó trước; không tự launch bản sao để retry, nhất là lỗi quota/auth.

## Kiểm tra đã làm

- Unit/integration checks: default `files`, explicit files/web/shell/stock/null, argv Unicode/quoting, permission mode, exact resume ID, process-local env, legacy resume, unsupported flag rejection trước khi tạo worker state. 113 tests trên 12 files và typecheck pass sau khi bật lại default đã được live-verify.
- Trên source native 0.17.1 thật, implemented denylist → production getTools(model) đúng 6/8/3 built-in tools trong offline probe. Không sửa contract hay executor của tool giữ lại.
- Ban đầu cả baseline không flags lẫn profile đều bị `project_token_login_failed`. Default đã được rút trong lúc chẩn đoán; không dùng unit tests thay acceptance test. Sau browser login chính thức, cả hai bài test thật đều pass: sửa fixture, Bash kiểm tra và ghi proof, ghi report, final `PASS`, status `ready_for_review`. Mỗi bài dùng project/database tạm riêng, cùng prompt, provider/model/effort `account:zai-individual-coding-plan/GLM-5.3-Flash`, `max`.
- Provider usage của request main đầu: **9.489 → 4.037 input tokens (~57,5% giảm)**; cả hai không có cache-read ở request đầu. Hai runs đều có 5 main requests, không retry/error; telemetry ghi Read/Edit/Bash/Write completed. Snapshot tool enablement của run `files` chỉ có sáu tool trong bảng trên. Đây là kết quả của một matched smoke pair, không phải bảo đảm mọi task đều giảm đúng tỷ lệ này.
- Managed end-to-end: launch qua supervisor không truyền profile dùng default `files`; resume giữ `files` và đúng session ID cũ. Cả hai `ready_for_review`, report có `PASS`, telemetry ghi Read/Bash thành công, discovery worktree guards clean. Credential store không đổi trong hai lượt managed này. Tool maps được kiểm tra trên message có field `tools`, không nhầm synthetic user messages không có tool map là toolset rỗng.
- Hash bundle, CLI config, Desktop settings, provider config và context-tuning profile đều không đổi so với snapshot **sau login**. Credential file có thay đổi trong smoke pair; native có lưu metadata `project-key-location` vào store khi xác thực, nên không khẳng định credential file bất biến hay tối ưu là tác nhân ghi nó. Đây không phải một lần restart GUI Desktop.

Số schema/description 28.936 → 7.827 ký tự trong [audit offline trước triển khai](zcode-0.17.1-context-audit.md) là phép đo khác với provider input tokens ở trên.

## Nếu gặp `project_token_login_failed`

Trên native 0.17.1, lỗi này bao trùm nhiều lỗi ở bước đổi OAuth token thành business token, không chứng minh token đã hết hạn. Đối chứng trước login ngày 2026-11-12 gọi cùng endpoint native `https://api.z.ai/api/auth/z/login`: HTTP 200, JSON `code: 500`, không trả access token. Không ghi response/token vào repo; credential file không thay đổi trong diagnostic đó. Browser login chính thức sau đó giải quyết blocker trên máy kiểm tra. Lỗi bước xác thực không chứng minh Desktop không mở được.

Khôi phục bằng luồng đăng nhập được CLI hỗ trợ, có người dùng xác nhận trên trình duyệt:

```powershell
$env:ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = 'C:/Program Files/ZCode/resources/config/provider/zcode-builtin.json'
$env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = "$HOME/.zcode/v2/provider_config.json"
node 'C:/Program Files/ZCode/resources/glm/zcode.cjs' login zai --no-browser
```

Phải truyền **cả hai** biến provider config: bundle Desktop 0.17.1 không tự tìm đúng built-in config khi gọi trực tiếp bằng Node. Nếu thiếu, nó tìm nhầm `resources/glm/provider/` hoặc `C:/config/provider/` rồi dừng trước login. Hai biến trên chỉ áp dụng trong terminal hiện tại, không lưu environment User/Machine. Worker adapter vốn đã truyền đủ hai biến này.

Trên Windows, dùng `--no-browser`, copy **toàn bộ** OAuth URL CLI in ra vào thanh địa chỉ trình duyệt và giữ terminal login đang chờ. Native 0.17.1 mở browser bằng `cmd.exe /c start "" <url>`; URL chứa `&` có thể bị shell cắt, khiến trang báo thiếu `response_type`, `redirect_uri`, `state`. Đây là lỗi mở URL, không chứng minh tài khoản lỗi. Nếu login đang chờ thì dùng URL đầy đủ của chính lần đó; nếu flow đã hết hạn, dừng nó rồi chạy lại để lấy URL mới. Không ghép state từ lần login khác hoặc lưu URL có state vào repo.

Điều chỉnh đường cài đặt nếu khác. Login chính thức có thể cập nhật credential dùng chung và model selection; không tự sửa JSON, chép token, đổi auth-source hay bỏ qua kiểm tra xác thực. Không cần logout/xóa cache trước. Khi chẩn đoán trên máy mới, thử `stock` hoặc advanced JSON explicit `null` trước, rồi mới so với `files`; không lặp lại một run lỗi auth khi trạng thái đăng nhập chưa đổi.
