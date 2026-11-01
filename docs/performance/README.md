# Bàn giao tối ưu hiệu năng FreeLLMAPI custom

**Ngày lập:** 2026-11-01. **Mốc code đã kiểm tra:** `4efcf3b1` trên `origin/main`.

Đây là kế hoạch triển khai và hợp đồng review, **chưa phải các tối ưu đã được thực hiện**. Người dùng sẽ giao tài liệu cho agent triển khai; Codex review PR và bằng chứng trước khi phát hành các thay đổi tiếp theo. Agent phải đọc lại code ở HEAD mới và ghi nhận sai khác so với mốc trên.

## Đọc theo thứ tự

1. Tài liệu này: hiện trạng, phạm vi, thứ tự và tiêu chí thành công.
2. [IMPLEMENTATION.md](IMPLEMENTATION.md): thiết kế, công việc và kiểm thử cho từng giai đoạn.
3. [REVIEW.md](REVIEW.md): bằng chứng cần bàn giao, điều kiện chặn merge, rollout và rollback.
4. [AGENT_PROMPT.md](AGENT_PROMPT.md): prompt có thể gửi trực tiếp cho agent triển khai.

Các quy tắc trong [AGENTS.md](../../AGENTS.md) và [constitution](../../.specify/memory/constitution.md) vẫn áp dụng. Với tính năng mới, agent thực hiện workflow Spec Kit của repo: specify → plan → tasks → implement. Bộ tài liệu này cung cấp yêu cầu đầu vào; không thay thế các artifact Spec Kit hoặc giả định rằng các lệnh đó đã được chạy.

## 1. Mục tiêu và giới hạn

- Giảm thời gian chờ dữ liệu của dashboard; giữ HTTP phản hồi được khi DB hoặc provider chậm.
- Đo được p50/p95, số lần truy cập DB, số request trình duyệt, độ trễ event loop và bộ nhớ.
- Giữ nguyên RBAC, cách ly tài khoản, thu hồi session/key, hạn mức và tính nhất quán dữ liệu.
- Duy trì SQLite local/Docker, API `/v1/*`, `/api/ping`, `/livez`, `/readyz`, auth Google/email và tất cả chức năng custom.
- Không đổi DB engine, chuyển vùng, nâng gói trả phí hoặc thêm dịch vụ ngoài trong phạm vi mặc định.
- Không triển khai đồng loạt cả lộ trình trong một PR. Mỗi PR phải có tác động đo được, kiểm thử và cách quay về bản cũ.
- Không tạo Redis, hàng đợi bên ngoài, database riêng cho từng user hoặc replica local chỉ vì muốn thêm cache. Chỉ đề xuất khi có số đo và ADR chứng minh nhu cầu.

## 2. Hiện trạng đã xác minh

| Thành phần | Trạng thái ở mốc baseline | Hệ quả cho triển khai |
| --- | --- | --- |
| DB contract | `DbStatement.get/all/run`, `Db.exec/transaction` đều đồng bộ | Không được trả Promise vào contract cũ bằng ép kiểu |
| Turso | Native `libsql`, DB libSQL từ xa, lựa chọn qua `FREEAPI_DB_DRIVER=turso` | Tối ưu async dự kiến dùng `@libsql/client`, không tự chuyển sang engine Turso mới |
| Prepared statement | LRU tối đa 128 SELECT handle; không cache kết quả | Bảo toàn đọc mới của auth/key/quota; đừng thêm TTL kết quả để thay thế |
| Routing settings | Allowlist đọc gộp trong phần đồng bộ của request; hết hạn trước async continuation và invalidated sau ghi/transaction | Không kéo dài scope hiện tại qua `await` một cách máy móc |
| Keys roster | JOIN `key_monthly_usage` theo tháng UTC, lấy cap từ `api_keys` | Bảo vệ tính O(1) của số truy vấn theo số key |
| Provider health | Turso mặc định 2 worker và nhường I/O giữa key; SQLite mặc định 8 | Env `HEALTH_CHECK_CONCURRENCY` có thể ghi đè; không tăng mặc định khi chưa đo |
| Catalog | Automatic sync/replay bị bỏ qua trên Turso; local vẫn hoạt động | Chỉ bật lại sau khi có đường apply không chặn và công bố dữ liệu nhất quán |
| Client cache | `App.tsx` đã có `staleTime: 30_000`; cùng query key chia sẻ kết quả | Đo trước khi đề xuất thêm dedup hoặc cache |
| Client session | Revision theo session, xóa QueryClient khi đổi identity; `apiFetch` chặn response muộn | Không bỏ các hàng rào này khi thêm cancellation, lazy loading hay query key mới |
| Polling | Models: routing/rate-limit usage 15s. Keys: health 30s | Keys query ở cấp trang không tự khai báo polling 30s; phải kiểm tra từng observer/component |
| Logs/analytics | `/api/logs` đã có `limit`, `sinceId`, ring buffer. Analytics requests có `limit/offset`, trần 500 | Không coi mọi log read là SQL chưa phân trang; tìm đúng nguồn chậm |
| Build runtime | Server build biên dịch shared; CI và Docker runtime import app bằng Node thuần | Giữ các kiểm tra này; test bằng TS loader không đủ chứng minh image chạy được |
| Hạ tầng đã quan sát | Render Free Singapore; DB hostname biểu thị Tokyo | Xác minh lại metadata thực trước quyết định region; chưa coi chuyển vùng là miễn phí/an toàn |

### Số đo tham chiếu và cách hiểu

Số dưới đây là quan sát ngày 2026-11-01, không phải SLO hoặc cam kết tốc độ cho mọi user.

| Phép đo | Kết quả | Phạm vi |
| --- | --- | --- |
| Đọc cap/usage từng key so với JOIN, 61 key | Khoảng 17,7 giây → 140 ms | Chỉ SELECT từ máy phát triển; không phải toàn bộ GET `/api/keys` đã xác thực |
| 12 routing setting riêng so với đọc gộp | 1 863 ms → 142 ms | Phần DB từ máy phát triển |
| SELECT với/không reuse handle, 5 cặp mẫu | Trung vị 71/142 ms | Mẫu nhỏ; không suy thành kết quả stress test |
| 4 endpoint public × 30 vòng trước sửa | 7/120 request lỗi, gồm timeout và 502 | Phép đo qua Internet; không có token admin |
| Sau giảm worker và sau tối ưu adapter | Mỗi đợt 0/120 request lỗi | Có một health pass 59 key hoàn thành trong đợt sau adapter |
| `/api/auth/status` trước/sau adapter | Trung vị 251/175 ms | Chỉ endpoint public, không đại diện dashboard đã login |
| RAM/CPU trong cửa sổ 1 giờ | RAM đỉnh khoảng 102/512 MiB; CPU đỉnh khoảng 14% hạn mức | Không chứng minh rằng mọi lỗi exit 137 trong lịch sử đều không liên quan RAM |
| Client main bundle | Khoảng 1 797 KB minified, 529 KB gzip | Build hiện tại; phải đo lại cùng toolchain |

Báo cáo gốc nằm ở máy chủ dự án tại `C:/Users/dotha/Documents/FreeLLMAPI-Deployment/2026-11-01/render-performance-report.json`. File này **không thuộc repo**, có thể không tồn tại trên máy agent khác. Được phép tiếp tục bằng baseline mới trên môi trường test; không yêu cầu gửi secret hoặc copy toàn bộ thư mục triển khai lên GitHub.

Các bản sửa nền đã merge: [PR #24](https://github.com/thanhdo257205/freellmapi-custom/pull/24), [#25](https://github.com/thanhdo257205/freellmapi-custom/pull/25), [#26](https://github.com/thanhdo257205/freellmapi-custom/pull/26).

## 3. Bản đồ code cần đọc

| Mục đích | File/symbol |
| --- | --- |
| DB hiện tại, lựa chọn backend | [types.ts](../../server/src/db/types.ts), [index.ts](../../server/src/db/index.ts), [turso.ts](../../server/src/db/turso.ts) |
| Settings scope | [routing-settings-scope.ts](../../server/src/db/routing-settings-scope.ts), `withRoutingSettingsScope`, `readRoutingSetting` |
| Mount custom/RBAC | [register.ts](../../server/src/custom/register.ts), `PERMISSION_GATES`, [requireAuth.ts](../../server/src/middleware/requireAuth.ts), [requirePermission.ts](../../server/src/middleware/requirePermission.ts) |
| Dashboard data | [keys.ts](../../server/src/routes/keys.ts), [fallback.ts](../../server/src/routes/fallback.ts), [router.ts](../../server/src/services/router.ts), [profile-models.ts](../../server/src/services/profile-models.ts) |
| Auth và quota | [auth.ts](../../server/src/services/auth.ts), [user-rate-limit.ts](../../server/src/middleware/user-rate-limit.ts), [user-quotas.ts](../../server/src/services/user-quotas.ts), [key-budget.ts](../../server/src/services/key-budget.ts), [ratelimit.ts](../../server/src/services/ratelimit.ts) |
| Logging và usage | [request-log.ts](../../server/src/lib/request-log.ts), [server-logs.ts](../../server/src/lib/server-logs.ts), [analytics.ts](../../server/src/routes/analytics.ts), [logs.ts](../../server/src/routes/logs.ts) |
| Background work | [scheduler.ts](../../server/src/lib/scheduler.ts), [health.ts](../../server/src/services/health.ts), [catalog-sync.ts](../../server/src/services/catalog-sync.ts), [index.ts](../../server/src/index.ts) |
| Client data/identity | [App.tsx](../../client/src/App.tsx), [api.ts](../../client/src/lib/api.ts), [session-state.ts](../../client/src/custom/session-state.ts), [use-session.ts](../../client/src/custom/use-session.ts) |
| Pages cần profile | [FallbackPage.tsx](../../client/src/pages/FallbackPage.tsx), [KeysPage.tsx](../../client/src/pages/KeysPage.tsx), [ProviderList](../../client/src/components/keys/provider-list.tsx) |
| Packaging | [Dockerfile](../../Dockerfile), [server/package.json](../../server/package.json), [shared/package.json](../../shared/package.json), [CI](../../.github/workflows/ci.yml) |

## 4. Thứ tự và cách chia PR

| ID | Phạm vi một PR | Phụ thuộc | Điều kiện để bắt đầu bước tiếp |
| --- | --- | --- | --- |
| P01 | Baseline có login + instrumentation opt-in | Không | Có số đo và danh sách 3 điểm chậm nhất; review overhead/privacy |
| P02 | Polling, cancellation, query identity theo page/tab/quyền | P01 | Số request giảm, test switch account/profile không hồi quy |
| P03a | ADR + async DB read interface, adapter và test lỗi | P01 | Review ranh giới sync/async, loại DB, transaction và cờ rollout |
| P03b | Chuyển một luồng GET đã profile sang async | P03a | Có bằng chứng giảm event-loop stall và giữ nguyên response/RBAC |
| P03c | Mở rộng từng nhóm API đọc, health/status nếu phù hợp | P03b | Mỗi nhóm một PR; auth/quota/write path vẫn tách riêng |
| P04a | ADR catalog batch + công bố atomic | P03a | Chốt thiết kế bảo toàn override/tombstone/profile/model ID |
| P04b | Catalog async, thử nghiệm với fixture và DB dùng một lần | P04a | Chứng minh parity, crash/retry, health responsiveness; chưa tự bật live |
| P05 | Một nhóm truy vấn analytics hoặc index có EXPLAIN chứng minh | P01 | Mục tiêu cụ thể và migration roundtrip nếu có schema change |
| P06 | Route-level lazy loading, chunk budget | P01; có thể sau P02 | Build manifest/browser network chứng minh tải ít hơn |
| P07 | ADR region/gói hạ tầng, nếu vẫn cần | Số đo mới | Chỉ lập phương án; người dùng duyệt tác động/cost/cutover trước khi thay đổi |

Thứ tự khuyến nghị: **P01 → P02 → P03a/P03b**, sau đó chọn P04/P05/P06 theo kết quả đo. P03c không đồng nghĩa đã chuyển toàn bộ server sang async. Auth, quota, request settlement và migration là các phạm vi rủi ro cao, cần ADR/PR riêng nếu thực sự phải thay đổi.

## 5. Tiêu chí thành công

Đây là **mục tiêu ban đầu để đánh giá**, cần xác nhận bằng P01, không phải kết quả đã đạt:

- Cùng fixture và workload: p95 của API được sửa giảm ít nhất 20%, hoặc số DB call giảm rõ ràng; không lấy một mẫu nhanh nhất làm bằng chứng.
- P03: dưới injected DB latency 150–300 ms và 5 request đọc đồng thời, ping vẫn đáp ứng. Trong staging có RTT client ổn định ≤200 ms, mục tiêu ping p95 <500 ms, max <2s; không có timeout health check 5s do test gây ra.
- Quan sát staging ít nhất 15 phút **và** ít nhất hai health pass hoàn thành; ghi cả lỗi, timeout, sample count, RSS và event-loop p95/max.
- Số truy vấn của Keys roster không tăng tuyến tính theo số key; giữ test 60 key hiện có. Số network call chỉ được công bố khi thực sự đo được transport.
- P02: tab ẩn/unmounted không tiếp tục polling dữ liệu tùy chọn; tab hiện cập nhật đúng chính sách freshness. Một cache identity không tạo nhiều request giống nhau cùng lúc.
- P06: mục tiêu giảm ít nhất 20% gzip của tập JS cần cho lần mở route đầu tiên; không chuyển toàn bộ chi phí sang prefetch ngay sau load.
- Mọi mục tiêu tốc độ đứng sau tính đúng đắn, auth và quota. Nếu baseline đã tốt, agent có thể đề xuất không sửa, kèm bằng chứng.

## 6. Ràng buộc không được đánh đổi

1. Không lưu plaintext key, token, password, OAuth code/state hoặc email vào performance log, metric label, HAR công khai hoặc fixture.
2. Không cache kết quả xác thực/quyền/quota trên server bằng TTL để đạt số đẹp. UI cache không có quyền cấp phép request.
3. Giữ `apiFetch` session revision guards, session cache boundary và query identity có profile. Hủy request cũ không đủ thay cho kiểm tra identity.
4. Không biến API đồng bộ thành Promise mà vẫn giữ type/caller cũ. Không đặt callback async vào `Db.transaction()` hiện tại.
5. Không dùng `Promise.all()` cho mọi truy vấn hoặc mọi provider; cần giới hạn đồng thời và xử lý queue.
6. Không chuyển bản ghi usage/lease có ý nghĩa enforcement sang fire-and-forget; không lặp write sau timeout khi chưa biết transaction đã commit chưa.
7. Không làm nhẹ `/livez` hoặc `/readyz` thành luôn-200 để che lỗi. Giữ Render health path hiện tại; đo độ trễ thay vì nới bảo vệ.
8. Không bật lại catalog tự động trước khi pass kiểm thử atomicity/parity; chia chunk tự nó không bảo đảm dữ liệu được công bố atomic.
9. Migrations đã apply là bất biến; schema/index mới phải có migration timestamp mới và kiểm tra up/down.
10. `origin` là repo custom. Không push upstream, không reformat/refactor file upstream ngoài phạm vi cần thiết. Không đụng DB/group của dự án Turso khác.
11. Với personal key/usage và dữ liệu thuộc user, lấy owner từ session/key đã xác thực và áp điều kiện ownership trong truy vấn; không tin `userId` do client gửi. Provider pool global dành cho admin là phạm vi khác, không tự chuyển thành mô hình per-user trong PR hiệu năng.

## 7. Nguồn tham chiếu

Đối chiếu ngày 2026-11-01; agent phải kiểm tra lại API theo package version thực tế trong lockfile:

- [Turso TypeScript reference](https://docs.turso.tech/sdk/ts/reference): phân biệt DB libSQL với engine Turso mới; API Promise, batch và transaction.
- [Node 24 perf_hooks](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html): timing và event-loop histogram; repo còn hỗ trợ Node 20/22 nên không dùng API chỉ có ở Node mới hơn phạm vi hỗ trợ.
- [TanStack useQuery](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery), [window focus](https://tanstack.com/query/latest/docs/framework/react/guides/window-focus-refetching), [query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation).
- [Render Free](https://render.com/docs/free), [health checks](https://render.com/docs/health-checks): idle sleep và unhealthy restart là hai hiện tượng khác nhau. Nâng instance không sửa synchronous DB blocking.
- [Turso group create](https://docs.turso.tech/cli/group/create): region nằm ở cấp group; group bổ sung có giới hạn theo gói. Chuyển vùng không được mặc định là thao tác miễn phí, riêng biệt cho một DB.
- [Tài liệu Turso hiện có của repo](../en/deployment/03-turso.md).
