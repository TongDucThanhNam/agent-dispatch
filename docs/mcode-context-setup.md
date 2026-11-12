# MCode Desktop — context setup và giới hạn sau update

Kiểm tra local ngày **2026-11-12**: MiniMax Code Desktop hiện **3.1.14** (snapshot trước đó là 3.1.10). Worker `mcode` trong repo dùng **Desktop runtime**, không phải standalone CLI chỉ vì cùng tên sản phẩm. [Worker context audit/setup mới](mcode-worker-context.md) dùng Custom Agent riêng, không patch builtin; đã cài/readback/preflight nhưng chưa live-verify do Token Plan hết quota. Default vẫn `mavis`.

## 1. Trạng thái hiện tại

- Global `config.yaml` còn danh sách tool/skill và các cờ tắt memory, delegation, browser/goal/skill-evolve, ask_user.
- `~/.minimax/agents/mavis/config.yaml` hiện là `{}`; không có agent override riêng đáng chép từ file này.
- Các file prompt trong `agents/.builtin/` **đã khác bản trim 2026-10-18**. Không được coi prompt trim cũ vẫn active chỉ vì global config còn giữ.
- Primary `.builtin/mavis/agent.md` hiện dài **42.573 byte**. Đây là template có nhiều nhánh mode/condition; không có nghĩa mỗi model request đều chứa toàn bộ số byte đó.
- Audit follow-up 3.1.14 kiểm tra native config/rendered Agent views và source composition, chưa capture full model-facing prompt/tool catalog; không khẳng định danh sách tool config bằng đúng tool schema được gửi. Xem [evidence và giới hạn](mcode-worker-context.md).

## 2. File portable trong repo

```text
assets/context/mcode/config.fragment.yaml
assets/context/mcode/historical-trim-20261018.reference.json
assets/context/mcode/audit-3.1.14.summary.json
assets/agents/mcode-worker/agent.md
```

Fragment là các group context hiện còn trong global config, không chứa provider/API key, model/effort/variant, context-window override, permission bypass, user ID hay bridge token. Reference JSON là inventory của lần trim trước, không phải patch/installer cho Desktop hiện tại.

Không copy `agents/.builtin/*/agent.md` từ máy cũ. App có thể regenerate chúng, làm mất update hoặc reset bản sửa. `bun run setup:mcode-worker` cài Custom Agent riêng qua API native, không áp lại trim cũ hoặc merge global fragment; xem hướng dẫn worker ở trên.

## 3. Setup global config trên máy mới

1. Cài MiniMax Code Desktop và đăng nhập trên máy mới, chọn model trong app.
2. Xác định data directory app thực sự đang dùng. Máy gốc dùng `~/.minimax`; `~/.mavis` là junction trỏ về đó, không phải hai config độc lập.
3. **Không cần tạo junction `.mavis` trên máy mới** chỉ để tái lập cấu hình. Không dùng tên folder làm bằng chứng runtime đang đọc đúng data dir.
4. Đóng app bình thường và backup config:

```powershell
$mcodeHome = Join-Path $HOME '.minimax' # Đổi nếu app dùng profile/data dir khác.
$config = Join-Path $mcodeHome 'config.yaml'
if (Test-Path -LiteralPath $config) {
    Copy-Item -LiteralPath $config -Destination "$config.before-context-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak" -ErrorAction Stop
}
```

5. Merge `assets/context/mcode/config.fragment.yaml` vào config đó. Không overwrite cả file: provider/auth/model có thể cùng nằm trong `config.yaml`.
6. Mở lại app, tạo session coding mới, kiểm tra tool/skill/feature và context usage trên đúng Desktop. UI `contextWindowUsageEnabled` chỉ bật hiển thị thống kê, không tự giảm context.

## 4. Fragment giữ gì và tắt gì?

| Nhóm | Giá trị lưu |
| --- | --- |
| Tool khai báo | read, write, edit, bash, task_query, task_output, task_stop, grep, glob, todowrite, web_fetch |
| Skill khai báo | init, mcode-tools-master |
| Agent features | mavis false, delegation false, webSearch true |
| Memory | memory.enabled false, beta.autoMemory false |
| Câu hỏi | askUser.enabled false |
| Skill ngoài | skills.external.enabled false |
| Browser/goal/evolve | beta.browserUseTooling, browserBridge, threadGoal, skillEvolve, skillProposal đều false |

Không assume chỉ có 11 tool runtime: webSearch/skill tooling có thể được thêm bởi feature/host. Kết quả kiểm tra cũ 2026-10-18 từng thấy 13 tool thực tế, nhưng đó không phải kết quả kiểm tra version hiện tại.

Danh sách skill trong config cũng không chứng minh chỉ có hai skill được discover/render. Current app vẫn có thư mục `.builtin-skills`; không xóa thư mục đó để ép whitelist. Nếu task bị chặn bởi `askUser.enabled = false`, worker phải trả blocker thay vì tự bịa câu trả lời.

Không đưa `dataContribution.enabled = false` vào fragment như một cách giảm context: đó là preference privacy riêng. Không copy `defaultModelContextWindow = 512000`, model/variant/effort hay `permissionMode = bypassPermissions` từ máy cũ chỉ vì chúng xuất hiện trong cùng file.

## 5. Kết nối delegate-to-mcode

Sau `bun install`, `bun link`, từ repo:

```powershell
agent-dispatch mcode setup
agent-dispatch models --worker mcode
agent-dispatch skills install --worker mcode --include-missing
agent-dispatch guide mcode
```

`setup` cần Desktop đang đóng hoặc đã có bridge hợp lệ. Nếu app đang mở mà chưa có bridge, đóng app bình thường rồi chạy lại; tool không forcible restart. Manifest startup token là dữ liệu ephemeral của máy mới, không copy/commit.

Executable mặc định là `%LOCALAPPDATA%/Programs/MiniMax Code/MiniMax Code.exe`. Nếu cài khác chỗ, dùng `MCODE_DESKTOP_EXE` và đọc [Desktop integration](minimax-code-integration.md) về các override.

Dispatcher đã gửi `team_mode_off: true` khi tạo session và `enable_team: false` cho turn. Đây là tắt teamwork ở đường delegate, **không phải thay system prompt bằng worker profile hai tool như AGY**. Nó pin provider/model của Desktop và không tự chuyển sang standalone CLI/BYOK.

Bản integration trước được smoke-test với Desktop 3.0.74; đọc số version trong tài liệu cũ như historical evidence. Bridge/schema/preflight của 3.1.14 đã kiểm tra, nhưng baseline model task bị quota nên không thay thế full integration/model acceptance trên version mới.

## 6. Bản trim 2026-10-18 còn giá trị gì?

Lần đó đã hạn chế 19 tool IDs, chỉnh primary/worker/explore/verifier prompt, và kiểm tra production catalog/render. Báo cáo cũ ghi prompt giảm 20.687 → 13.643 byte (34,1%) và skill catalog còn hai tên. Reference JSON lưu số đo cùng hash file, không lưu nội dung request hay credentials.

Hiện các file đã khác các after-hash đó. Một số phần config vẫn tương ứng baseline, nhưng **không được suy ra 34,1% còn đúng**. Muốn tối ưu mạnh hơn phải audit current merged agent config, prompt render và tool filter của 3.1.10, không đè template cũ lên built-in mới.

## 7. Rollback

Đóng app bình thường, khôi phục `config.yaml.before-context-*.bak`, rồi mở session mới. Không khôi phục auth, database, runtime leases hay manifest từ máy khác. Nếu từng sửa built-in prompt riêng, giữ backup theo đúng version thay vì dùng file của bản khác.

Nguồn: [MiniMax Code upstream](https://github.com/MiniMax-AI/minimax-code) có thể dùng làm tham khảo CLI/config, **không coi standalone CLI docs là cam kết tương thích Desktop**. Các setting và trạng thái trên lấy từ Desktop/config local; đường delegate được mô tả trong source của repo và [integration guide](minimax-code-integration.md).
