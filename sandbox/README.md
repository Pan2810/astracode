# AstraCode Sandbox

Tool `bash` của agent chạy **trong container**, không chạy trên máy host. MCP server cũng vậy.

Đây là kiểm soát bảo mật thật cho bash — khác với denylist lệnh, vốn chỉ chống tai nạn. Xem [../documents/SECURITY.md](../documents/SECURITY.md) §4.

## Cấu trúc

```
sandbox/
├── docker-compose.yml        # runner: nơi bash chạy
├── Dockerfile.runner         # toolchain: node, python, git, ripgrep
├── proxy/
│   ├── tinyproxy.conf        # egress proxy, mặc định deny
│   └── filter.txt            # allowlist domain
└── mcp/
    ├── servers.json          # catalog MCP đóng gói sẵn
    └── docker-compose.mcp.yml
```

## Ba profile mạng

| Profile | Mạng | Dùng khi | Rủi ro exfiltration |
|---|---|---|---|
| `none` (mặc định) | Không có | Chạy test, build với dep đã cài, lint | Không |
| `restricted` | Qua proxy, allowlist domain | `npm install`, `pip install` | Thấp |
| `full` | Thoải mái | Trường hợp đặc biệt | **Cao** |

Đổi profile là hành động của **user**, không phải của agent. Agent không được tự nâng profile — nếu lệnh cần mạng, nó phải nói ra và user quyết.

## Chạy thử bằng tay

```powershell
$env:ASTRA_WORKSPACE = "C:\Work\05_AI\02_Project\AstraOpen"
docker compose --profile none up -d
docker compose exec -T runner bash -lc "node -v; rg --version"

# Kiểm chứng không có mạng:
docker compose exec -T runner bash -lc "curl -m 5 https://example.com" ; # phải fail

docker compose --profile none down
```

## Ghi chú cho Windows

**Bắt buộc Docker Desktop với backend WSL2.** Hyper-V backend không hỗ trợ đủ các tùy chọn security ở đây.

**Hiệu năng bind mount.** Mount thư mục từ ổ Windows (`C:\Work\...`) vào container qua WSL2 rất chậm — `npm install` hoặc test chạm nhiều file có thể chậm 5–10 lần. Ba lựa chọn:

1. **Để repo trong WSL2** (`\\wsl$\Ubuntu\home\<user>\projects\...`) và mở VS Code bằng Remote-WSL. Nhanh nhất, khuyến nghị nếu bạn chấp nhận đổi cách làm việc.
2. Chấp nhận chậm — vẫn dùng được cho lệnh nhẹ (lint, test đơn lẻ, git).
3. Tắt sandbox cho repo đó (`"sandbox": "host"`) và chấp nhận rằng bash chạy trên host.

**Quyền file.** Với bind mount từ ổ Windows, Docker Desktop bỏ qua UID nên `user: "1000:1000"` không gây vấn đề. Với repo nằm trong WSL2, UID 1000 khớp user mặc định của Ubuntu — nếu bạn dùng UID khác, sửa `Dockerfile.runner` và `user:` trong compose.

**Line ending.** Nếu host là Windows và container là Linux, đặt `git config core.autocrlf input` trong repo để tránh agent thấy file "đã thay đổi" chỉ vì CRLF.

## Khi không có Docker

AstraCode phải chạy được cả khi máy không có Docker — nhưng phải **nói rõ**:

- `sandbox: "docker"` (mặc định): không có Docker → hiện banner đỏ, đề nghị chuyển sang `host` hoặc cài Docker. Không tự âm thầm chuyển.
- `sandbox: "host"`: bash chạy trên máy thật. UI hiện badge cảnh báo thường trực. Mọi lệnh vẫn cần duyệt tay.

## Điều sandbox này KHÔNG bảo vệ

Nói thẳng để không ảo tưởng an toàn:

- **Workspace vẫn ghi được.** Agent xóa sạch code của bạn trong container thì file trên host cũng mất. Checkpoint mới là thứ chống việc này, không phải sandbox.
- **Với profile `restricted` hoặc `full`, exfiltration vẫn khả thi** — allowlist có github.com thì dữ liệu vẫn đi ra được qua đó.
- **Docker escape** là có thật dù hiếm. `cap_drop: ALL` + `no-new-privileges` + non-root làm nó khó hơn nhiều, không phải bất khả.
- **Không bao giờ mount `/var/run/docker.sock`.** Mount vào là mất toàn bộ giá trị của sandbox trong đúng một dòng.
