# Prompt bàn giao cho agent triển khai

Sao chép phần dưới để bắt đầu. Các file phải được đọc từ checkout hiện tại; đừng chỉ dựa vào đoạn chat tóm tắt.

---

Bạn đang triển khai tối ưu hiệu năng cho `thanhdo257205/freellmapi-custom`, một fork cần giữ khả năng đồng bộ upstream. Tôi sẽ nhờ Codex review PR của bạn trước khi merge/deploy các thay đổi triển khai.

Đọc theo thứ tự:

1. `AGENTS.md`, `.specify/memory/constitution.md` và mọi hướng dẫn áp dụng trong repo.
2. `docs/performance/README.md`.
3. `docs/performance/IMPLEMENTATION.md`.
4. `docs/performance/REVIEW.md`.
5. Code thực tại HEAD; baseline tài liệu là `4efcf3b1`, vì vậy hãy ghi nhận nếu code đã thay đổi.

**Lượt triển khai đầu tiên chỉ làm P01: baseline và instrumentation opt-in.** Không triển khai cả roadmap trong một PR. Sau khi tôi/Codex review P01, mới chuyển sang P02 rồi P03a/P03b theo số đo. Các phase catalog, quota/write hoặc region cần thiết kế riêng như tài liệu quy định.

Yêu cầu:

- Tạo branch mới từ `origin/main`; không commit/push main và không push upstream. Dùng repo custom tường minh khi gọi `gh`.
- Nếu có `.codegraph/`, dùng CodeGraph trước khi tìm/đọc code. Nếu không có thì không tự tạo index.
- Dùng workflow Spec Kit cho feature theo repo. Tài liệu roadmap là đầu vào, không phải bằng chứng rằng bạn đã chạy Spec Kit.
- P01 phải đo cả dashboard đã login admin/member trên staging, không chỉ ping public. Dùng key/user giả và provider stub; không gọi inference thật hoặc stress test production.
- Ghi p50/p95/max, failures/timeouts, DB counts đúng định nghĩa, event-loop delay, RSS và request waterfall theo page/tab/role. Tách cold/warm, DB-only/HTTP/full page.
- Metrics/logs phải hữu hạn, overhead được đo và không chứa secret, email, URL query string, token, SQL params hoặc raw driver errors. Không thêm endpoint metric public.
- Giữ nguyên auth/RBAC, session revision/cache boundary, profile identity và enforcement quota. Không thêm cache kết quả auth/quota để làm benchmark nhanh hơn.
- Giữ sync `Db` contract hiện tại. Async DB là phase riêng; không cast Promise thành row hoặc truyền callback async vào sync transaction.
- Giữ catalog tự động remote tắt cho đến khi thiết kế publish atomic và crash recovery được review/pass test. Không tự bật flag hoặc đổi vùng/gói hạ tầng.
- Viết module custom riêng, chạm entry point nhỏ; không reformat/refactor rộng code upstream. Migrations mới phải timestamp riêng; không sửa migration đã apply.
- Chạy full tests/build/lint, i18n nếu áp dụng, runtime import bằng Node thuần và migration roundtrip nếu đổi schema. Không dùng dependency native khác OS. Giữ CI Docker runtime smoke.
- PR phải có script tái hiện bằng dữ liệu giả, bảng before/after, head SHA, phần chưa làm/chưa đo và rollout/rollback. Không coi CI xanh là bằng chứng performance.

Kết thúc lượt bằng **PR sẵn sàng review**, kết quả đo và artifact liên quan; chưa tự merge/deploy PR triển khai theo handoff. Nêu ngắn gọn nếu thiếu quyền/cấu hình để có authenticated benchmark; tiếp tục các phần local/staging làm được, không xin người dùng dán secret vào chat.

---

Sau khi agent hoàn tất, người dùng có thể gửi Codex:

```text
Review PR <URL> theo docs/performance/REVIEW.md.
Đối chiếu đúng head SHA, kiểm tra code thực, số đo và race/failure tests.
Ưu tiên phát hiện mất bảo mật/tính đúng đắn trước khi đánh giá tốc độ.
Chưa merge/deploy cho đến khi các finding quan trọng được xử lý.
```
