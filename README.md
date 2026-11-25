# Jira MCP (remote) cho Jira Cloud

MCP server chạy qua Streamable HTTP, dùng được làm custom connector trên claude.ai.
Giai đoạn hiện tại: **API token + chạy local + Cloudflare tunnel** để dùng thử.

## Tool (41)

| Nhóm | Đọc | Ghi |
|---|---|---|
| Issues | `get_myself`, `find_users`, `list_projects`, `search_issues`, `get_issue`, `get_transitions`, `get_worklogs`, `get_issue_history`, `list_link_types` | `create_issue`, `update_issue`, `add_comment`, `transition_issue`, `add_worklog`, `delete_worklog` ⚠, `link_issues`, `remove_issue_link` ⚠ |
| Fields & metadata | `list_fields`, `get_create_meta`, `list_project_components`, `list_project_versions` | |
| Templates | `list_templates` | (`create_issue` với `template`) |
| Backlog & sprints | `list_boards`, `list_sprints`, `get_sprint_issues`, `get_backlog`, `list_epics` | `move_issues_to_sprint`, `move_issues_to_backlog`, `rank_issues`, `create_sprint`, `update_sprint`, `start_sprint`, `close_sprint` ⚠ |
| Reports | `get_sprint_summary`, `get_velocity`, `get_cycle_time`, `get_time_report`, `get_epic_progress` | |
| Bulk | | `bulk_update_issues` |
| Filters | `list_filters`, `run_filter` | |

⚠ = có `destructiveHint`. Không có tool xóa issue, sprint, board hay project (`remove_issue_link` chỉ xóa link, `delete_worklog` chỉ xóa một worklog).

- `search_issues`, `get_issue`, `get_sprint_issues`, `get_backlog`, `list_epics`, `run_filter` trả thêm các field trong `listFields` của config (story points, sprint, components, automation status, work type) và `flagged`. Tham số `fields` (tên hoặc ID) để lấy thêm field khác.
- `create_issue` / `update_issue` nhận `fields` theo tên hiển thị, key trong config, hoặc ID: `{"Story Points": 3, "automationStatus": "Automated"}`. `extraFields` vẫn là raw passthrough.
- `get_sprint_summary`: không truyền `sprintId` thì lấy sprint active của `defaultBoardId`. Trả committed/done/remaining (points + items), theo status/assignee/work type, item chưa estimate, item bị block (theo `blocked` trong config), scope change (thêm sau khi start, bị bỏ ra, carried-in từ sprint đã đóng). Sub-task không tính; points là giá trị hiện tại; với sprint đã đóng, issue chỉ tính "done" nếu được resolve trước lúc đóng sprint.
- `get_velocity`: committed vs completed của N sprint đã đóng gần nhất (mặc định 6), cùng cách tính như trên.
- `get_cycle_time`: từ lần đầu vào status `cycleTime.start` đến lần cuối vào `cycleTime.end` (config). Trả median, p85, average và các issue chậm nhất.
- `get_time_report`: giờ log trong khoảng ngày (tính theo time zone của tài khoản Jira), group theo author/issue/component/week/epic. Tối đa 300 issue.
- Lịch sử (sprint, status) đọc qua `changelog/bulkfetch`; site không có API này thì gọi từng issue. Mọi chỗ gọi theo từng issue chạy tối đa 5 request song song.
- Description/comment dùng Markdown: `#` heading, `**bold**`, `*italic*`, `` `code` ``, `[text](url)`, list (lồng 1 cấp, thụt 2 space), bảng `| a | b |`, code block, mention `@[accountId]`.
- `add_comment` nhận thêm `attachments`: danh sách đường dẫn file trên máy chạy server (tối đa 10). File được upload lên issue; ảnh hiện ngay trong comment, file khác hiện dạng thẻ file. Chỉ đọc được file nằm trong `ATTACHMENTS_DIR` (.env); không đặt thì tính năng này tắt.
- `add_comment` với `clipboardImage: true` đính kèm ảnh đang có trong clipboard (Windows). Dùng khi chụp màn hình (Win+Shift+S), dán vào chat Claude rồi bảo "comment ảnh này vào AUTOKAT-123": dán xong thì ảnh vẫn còn trong clipboard. Không cần `ATTACHMENTS_DIR`; `body` có thể bỏ trống. Lưu ý: server lấy ảnh **đang** có trong clipboard, nên nếu đã copy thứ khác sau khi dán thì sẽ ra ảnh khác.

## An toàn khi ghi

- `READ_ONLY=true`: không đăng ký tool ghi nào (connector chỉ thấy tool đọc).
- `ALLOWED_PROJECTS=AUTOKAT,SANDBOX`: mọi tool ghi kiểm tra project của **tất cả** issue bị đụng tới trước khi ghi. Tool sprint kiểm tra project của board.
- `bulk_update_issues` mặc định `dryRun=true`: chỉ trả giá trị hiện tại và giá trị mới, không ghi. Chạy thật bằng `dryRun=false`. Tối đa 50 issue, JQL khớp hơn 50 thì bị từ chối.
- `close_sprint` mặc định `confirm=false`: chỉ trả danh sách issue chưa xong sẽ bị chuyển. Với `confirm=true`, server chuyển các issue chưa xong (sang sprint chỉ định hoặc backlog) **trước**, rồi mới đóng sprint. Lý do: khi đóng sprint qua API, Jira Cloud tự đẩy issue chưa xong về backlog và không cho chọn đích.
- Mọi thao tác ghi hiện tên chủ API token trong Jira.

## Config file và templates

`jira-mcp.config.json` (đường dẫn đổi bằng env `CONFIG_FILE`) cho biết project/board mặc định và tên các field của team. Bắt đầu từ mẫu:
```bash
cp jira-mcp.config.example.json jira-mcp.config.json
cp templates.example.json templates.json
```
- `fields`: key logic -> danh sách tên hoặc ID ứng viên, lấy cái đầu tiên tồn tại trên site. Nếu một tên trùng nhiều field, tool báo lỗi kèm danh sách ID: chạy `list_fields` rồi ghi ID (vd `customfield_10016`) vào config.
- Không có file: server chạy với giá trị mặc định. File sai schema: giữ bản hợp lệ gần nhất và in lỗi ra stderr.
- Cả config và templates được đọc lại khi file thay đổi, không cần restart.

`templates.json` (đường dẫn trong `templatesFile`, tính từ thư mục chứa config) chứa các mẫu task. Mỗi mẫu có thể đặt `project`, `issueType`, `labels`, `components`, `assignee` (`"me"`), `parent`, `fields` (theo tên), `description` (khung Markdown) và `extends` (một mẫu cha). Khi `create_issue` dùng `template`: tham số truyền vào thắng giá trị của mẫu; `labels`/`components` được gộp; không truyền `description` thì dùng khung của mẫu. Templates chỉ sửa qua git, không có tool ghi.

## Cài đặt

Yêu cầu: Node.js 20.6 trở lên.

1. Tạo API token tại https://id.atlassian.com/manage-profile/security/api-tokens (token có hạn dùng, nhớ gia hạn).
2. Cấu hình:
   ```bash
   cp .env.example .env
   openssl rand -hex 32   # dán kết quả vào MCP_PATH_SECRET
   ```
   Điền `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. Nên đặt `ALLOWED_PROJECTS` trong lúc thử.
3. Chạy:
   ```bash
   npm install
   npm run dev          # hoặc: npm run build && npm start
   npm run typecheck && npm test   # kiểm tra
   ```
   Endpoint: `http://127.0.0.1:3000/mcp/<MCP_PATH_SECRET>`

## Test local bằng MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```
Chọn transport **Streamable HTTP**, nhập URL endpoint ở trên, bấm Connect, rồi thử `get_myself` trước.

## Đưa lên claude.ai qua Cloudflare tunnel

1. Cài `cloudflared`: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. Mở tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   Lấy URL dạng `https://xxxx.trycloudflare.com`.
3. Trên claude.ai, thêm custom connector (Settings → Connectors) với URL:
   `https://xxxx.trycloudflare.com/mcp/<MCP_PATH_SECRET>`
   Nếu tài khoản thuộc gói Team/Enterprise, có thể cần Owner của tổ chức thêm connector.

Lưu ý: quick tunnel đổi URL mỗi lần chạy lại, nên phải cập nhật connector. Muốn URL cố định thì dùng named tunnel (cần domain trên Cloudflare).

## Dùng với Claude Desktop (stdio, không cần tunnel)

`npm run build`, rồi thêm vào `claude_desktop_config.json` (Settings → Developer → Edit Config):
```json
"mcpServers": {
  "jira": {
    "command": "node",
    "args": ["--env-file=C:\\path\\to\\jira-mcp\\.env", "C:\\path\\to\\jira-mcp\\dist\\stdio.js"]
  }
}
```
Thoát hẳn Claude Desktop (cả icon ở khay hệ thống) rồi mở lại.

## Ví dụ prompt trên claude.ai

- "Liệt kê issue của tôi chưa Done trong AUTOKAT, kèm story points"
- "Tạo task từ template maintenance: sửa script login bị fail trên Chrome, 2 points"
- "Sprint hiện tại thế nào? Ai đang ôm nhiều points nhất, item nào bị block, có gì thêm vào giữa sprint?"
- "Velocity 6 sprint gần nhất của board 2092"
- "Cycle time của các Story Done trong 30 ngày qua, issue nào chậm nhất?"
- "Báo cáo giờ log tuần trước theo từng người" / "... theo epic"
- "Tiến độ các epic component API đang Automated là bao nhiêu %?"
- "Gắn label regression và đổi Automation Status thành Automated cho các issue trong filter X" (xem dry run trước rồi mới áp dụng)
- "Đóng sprint hiện tại, chuyển issue chưa xong sang sprint kế tiếp" (xem preview rồi mới confirm)
- "AUTOKAT-123 is blocked by AUTOKAT-120"
- "Log 2h vào ABC-123 cho sáng nay lúc 9h, ghi chú: fix locator"

## Troubleshooting

- **Connector chỉ hiện tool đọc**: kiểm tra `READ_ONLY` trong `.env` (phải là `false`) và quyền tool của connector trong claude.ai (Settings → Connectors → connector → tool permissions).
- **"Field ... matches several fields"**: có hai field trùng tên trên site. Chạy `list_fields` với tên đó, chọn đúng ID và ghi vào `fields` trong `jira-mcp.config.json`.
- **Output thiếu storyPoints/automationStatus**: tên field trong config không khớp site. Chạy `list_fields` rồi sửa config (không cần restart).
- **`create_issue` báo 400**: lỗi kèm danh sách field bắt buộc còn thiếu và giá trị hợp lệ. Có thể xem trước bằng `get_create_meta`.
- **Ghi field Team báo lỗi**: field Team cần team id (UUID), lấy từ URL trang team; REST API không đổi được tên team sang id.
- **"Write blocked: ... not in ALLOWED_PROJECTS"**: thêm project vào `ALLOWED_PROJECTS` hoặc đổi sang project khác.
- **401**: API token sai hoặc hết hạn, tạo token mới.

## Kiểm tra thủ công với Jira thật

1. `list_fields` với query "story", "sprint", "team", "automation", "work type", "flagged". Ghi ID vào `fields` trong `jira-mcp.config.json` (vd `"storyPoints": ["customfield_10016"]`). Gọi `get_issue` một issue AUTOKAT và kiểm tra các field hiện đúng.
2. `get_sprint_summary` (board 2092, sprint active): so committed/done/scope change với Sprint Report trong Jira; thử `get_velocity` và so với Velocity Chart.
3. Trong project sandbox (đặt `ALLOWED_PROJECTS` chỉ gồm sandbox): `create_issue` với `template` (và `projectKey` sandbox), kiểm tra labels/components/fields/description; thử `link_issues` "blocks" và xem chiều link trên giao diện Jira; thử `bulk_update_issues` dry run rồi apply trên 2 issue.

## Bảo mật

- Secret path là lớp bảo vệ duy nhất ở giai đoạn này: ai có URL là dùng được Jira với quyền của bạn. Không commit `.env`, không chia sẻ URL. Nếu lộ, đổi `MCP_PATH_SECRET` và thu hồi API token.
- Server chỉ bind `127.0.0.1`, nên chỉ truy cập được qua tunnel trên máy bạn.
- Mọi thao tác ghi đều hiện tên chủ token trong Jira.
- Kiểm tra với admin/client rằng việc đưa dữ liệu Jira qua claude.ai phù hợp chính sách.

## Cấu trúc

```
src/
  index.ts          Express + Streamable HTTP (stateless), kiểm tra secret path
  server.ts         Tạo McpServer, đăng ký tool
  config.ts         Đọc và kiểm tra .env
  settings.ts       Schema của jira-mcp.config.json
  templates.ts      Schema + merge/extends của templates
  util/jsonFile.ts  Đọc JSON có kiểm tra zod, tự đọc lại khi mtime đổi
  jira/auth.ts      Interface JiraAuth + ApiTokenAuth  <- điểm mở rộng cho OAuth 3LO
  jira/client.ts    fetch wrapper: retry 429, timeout, thông báo lỗi dễ đọc
  jira/adf.ts       Markdown <-> Atlassian Document Format
  jira/fields.ts    Field registry: tên/ID -> field, chuyển giá trị đọc/ghi theo schema
  jira/format.ts    Rút gọn JSON issue cho gọn context
  jira/changelog.ts Changelog nhiều issue (bulkfetch, fallback từng issue)
  jira/paging.ts    Đọc hết các trang (Agile startAt, JQL nextPageToken)
  reports/sprint.ts Tính toán sprint (thuần, không gọi API)
  util/pool.ts      mapLimit: giới hạn số request song song
  reports/cycle.ts  Cycle time + thống kê; reports/time.ts: cửa sổ thời gian, gom giờ
  tools/            issues, agile (sprint), worklogs, meta, backlog, links, reports, history, time, epics, bulk, filters; context.ts (helper chung)
test/               vitest, fetch được giả lập (không gọi mạng)
```

## Bước tiếp theo cho cả team

1. Deploy lên Cloudflare Workers (dùng template remote MCP có OAuth của Cloudflare).
2. Thêm `OAuth3loAuth` implement `JiraAuth`: baseUrl `https://api.atlassian.com/ex/jira/{cloudId}`, Bearer token, refresh token.
3. Tạo `JiraClient` theo từng user cho mỗi request (server đã stateless, chỉ cần đổi chỗ khởi tạo `ctx` trong `index.ts`). Code tool giữ nguyên.
