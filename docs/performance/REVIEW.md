# Hợp đồng review và nghiệm thu

Tài liệu này dành cho agent triển khai và Codex khi review. Dùng cùng [kế hoạch](README.md) và [thiết kế từng pha](IMPLEMENTATION.md).

## 1. Luồng làm việc

1. Fetch `origin/main`, kiểm tra working tree và đọc hướng dẫn áp dụng. Nếu có `.codegraph/`, dùng CodeGraph trước khi tìm code; không tự index nếu không có.
2. Tạo branch `codex/<phase>-<description>` hoặc prefix do người dùng yêu cầu, từ main mới. Không commit/push trực tiếp main; `upstream` chỉ đọc.
3. Với phase có tính năng mới, chạy Spec Kit theo AGENTS và cập nhật task trạng thái. P03/P04 phải có ADR chỉ rõ ranh giới và tradeoff.
4. Chỉ triển khai phạm vi một PR như bảng P01–P07. Không trộn frontend polling, async quota, catalog migration và region cutover vào một PR.
5. Chạy các kiểm tra bắt buộc, push branch và tạo PR vào repo custom: `thanhdo257205/freellmapi-custom`. Dùng `gh -R thanhdo257205/freellmapi-custom` vì CLI có thể mặc định repo upstream.
6. **Đối với các PR triển khai theo handoff này:** bàn giao PR và evidence cho người dùng/Codex review trước khi merge hoặc deploy. Đây là điểm review do yêu cầu bàn giao của người dùng; không phải yêu cầu phải xin lại quyền cho mọi read/test local.
7. Sửa finding, chạy lại kiểm tra liên quan và nhận review xong; sau đó merge/sync main/deploy theo chỉ dẫn người dùng. Không tự hiểu CI xanh là đã hoàn thành review hiệu năng hoặc bảo mật.

## 2. Nội dung bắt buộc của mỗi PR

| Mục | Bằng chứng cần có |
| --- | --- |
| Trigger cụ thể | Trang/route/workload nào chậm và user bị ảnh hưởng ra sao |
| Phạm vi | Phase ID, module sửa, phần còn sync/chưa làm và non-goals |
| Baseline | Commit, environment, fixture size, role, region, cold/warm, concurrency, sample count |
| Kết quả | p50/p95/max, errors/timeouts, DB counts, request count, RSS và event-loop nếu liên quan |
| Reproduce | Script/lệnh và dữ liệu giả có thể dựng lại; không phụ thuộc duy nhất file `.cache` trên máy tác giả |
| Tính đúng đắn | Test parity, RBAC, isolation, quota/transaction hoặc catalog invariants tương ứng |
| Build/runtime | Full tests/build/lint, supported Node CI, import app bằng Node thuần và image runtime |
| Vận hành | Cờ/config mới có default; trạng thái hiện tại, canary, điều kiện dừng và rollback |
| Hạn chế | Số nào chỉ là DB-only; endpoint live nào chưa test có login; provider/inference nào chưa được gọi |

Không ghi “0 lỗi” mà thiếu tổng mẫu/thời gian quan sát. Không dùng mẫu nhanh nhất, bỏ timeout khỏi mẫu hoặc lấy localhost RTT so với production Internet rồi công bố phần trăm cải thiện.

### Mẫu bảng measurement

```text
phase,commit,env,backend,node,role,route,fixture,concurrency,warm,
samples,failures,timeouts,p50_ms,p95_ms,max_ms,
logical_db_calls,raw_prepare_calls,queue_wait_ms,event_loop_p95_ms,rss_peak_mib
```

Nếu không đo được một cột, ghi `not_measured`, không điền 0. Tổng duration DB song song và thời gian HTTP là hai đại lượng khác nhau. Bổ sung manifest/initial JS gzip/transfer cho P06 và số request mỗi page/tab cho P02.

## 3. Lệnh kiểm tra bắt buộc

Chạy từ root sau khi cài dependency phù hợp OS:

```sh
npm ci
npm test
npm run build
npm run lint
npm run check:i18n -w client
node --input-type=module -e "await import('./server/dist/app.js')"
git diff --check
```

`npm ci` chỉ cần chạy khi thiếu dependency hoặc lockfile thay đổi. Không dùng native `node_modules` Windows cho Linux. Native driver đã từng làm full test Windows worker crash; dùng WSL/Ubuntu hoặc CI Linux để xác minh đầy đủ, không xóa test vì lỗi môi trường.

Nếu đổi schema/index, thêm `npm run test:migrations`. Test migration trên DB dùng một lần với dữ liệu cũ; không chạy fresh/down/reset trên production. CI phải pass Node 20/22/24 và Docker amd64/arm64 theo workflow hiện có; kiểm tra range thực tế nếu repo đã cập nhật.

### Regression test hiện có cần bảo toàn

- [Turso adapter](../../server/src/__tests__/db/turso.test.ts): bindings, nested rollback, migrations, error redaction và remote backup guard.
- [Settings scope](../../server/src/__tests__/db/routing-settings-scope.test.ts): request/await boundary, write/RETURNING/rollback invalidation và bounded handles.
- [Health fairness](../../server/src/__tests__/services/turso-health-fairness.test.ts), [catalog startup](../../server/src/__tests__/services/turso-catalog-startup.test.ts).
- [Key roster query count](../../server/src/__tests__/routes/keys-roster-query-count.test.ts), [monthly budget](../../server/src/__tests__/services/key-budget.test.ts).
- [RBAC surface tripwire](../../server/src/__tests__/custom/surface.test.ts), [user quotas](../../server/src/__tests__/custom/user-quotas.test.ts).
- [Client API identity guards](../../client/src/lib/api.test.ts) và các test session/profile mà agent tìm được khi lập call graph.

Danh sách là điểm bắt đầu, không thay cho full suite hoặc test mới chứng minh hành vi thay đổi. Đặc biệt phải thêm test concurrency khi đưa `await` vào enforcement/transaction, không chỉ test lần lượt.

## 4. Điều kiện chặn merge

Codex ưu tiên review tính đúng đắn trước số hiệu năng. Các trường hợp sau phải giải quyết trước merge:

- Rò key/token/password/OAuth code qua logs, metrics, HAR, query key, fixture hoặc artifact PR.
- Cache/session response của user A xuất hiện ở B; late 401 của A xóa session B; profile A/B lẫn dữ liệu.
- User B đoán ID personal key/usage của A và đọc/sửa được; repository mới bỏ điều kiện owner hoặc dùng owner từ query/body thay cho identity đã xác thực.
- Session/key bị revoke vẫn cấp phép cho request mới do cache hoặc read snapshot cũ.
- Quota/reservation vượt giới hạn khi request song song; settlement lặp hoặc mất sau abort/timeout/crash.
- Async callback chạy trong sync transaction; transaction dùng nhầm global connection; lock/pool/client không được giải phóng.
- Lỗi DB bị biến thành thành công với dữ liệu stale hoặc fallback sang DB local khác.
- Catalog công bố dở dang, marker/version sai, mất override/tombstone/custom scope hoặc đổi ID model đang tồn tại.
- Bỏ kiểm tra chữ ký, auth gate, permission hoặc nội dung readiness để đạt benchmark.
- Không có bằng chứng async thực sự: handler async nhưng service vẫn gọi native remote sync cho phần chậm chính.
- Index/migration phá tương thích bản code cũ, sửa migration đã apply hoặc không có roundtrip/evidence query plan.
- Lazy loading phá invite/reset/OAuth/deep link hoặc tải tất cả chunk bằng prefetch nên không giảm transfer thật.
- Cần sửa quá rộng file upstream nhưng không có ADR/phạm vi được review; tự đổi vùng/gói hoặc ảnh hưởng DB dự án khác.

## 5. Kiểm thử concurrency và lỗi tối thiểu

| Tình huống | Kết quả yêu cầu |
| --- | --- |
| DB chậm 150–300 ms, 5–10 GET song song | Ping không bị chặn bởi chờ mạng; queue có giới hạn |
| Role/session/key đổi trong lúc read chờ | Không cấp phép request mới bằng quyền đã cũ; response client không lẫn identity |
| Một slot quota, 10 admission đồng thời | Không cấp vượt số slot còn lại; release đúng một lần |
| Timeout ngay trước/sau commit | Không retry write mù; có outcome/reconciliation/idempotency theo thiết kế |
| Hai catalog sync cùng lúc | Chỉ một operation có quyền publish; operation còn lại xử lý theo policy đã review |
| Crash sau chunk/publish/marker | Có recovery xác định; reader không thấy dữ liệu nửa chừng |
| Tab ẩn hoặc user đổi account/profile | Polling và request/cache behavior đúng; không giữ quyền hoặc cache cũ |
| Redeploy làm chunk cũ không còn | UI có lỗi/recovery có kiểm soát; không loop reload |

Giả lập provider bằng stub server/fixture để không tiêu quota. Kết quả stress phải đến từ staging/disposable DB, không tự tạo traffic lớn lên dịch vụ live.

## 6. Rollout và rollback

### Trước rollout

- Ghi main SHA đã merge sau review/CI, deploy SHA hiện tại và rollback SHA đã biết chạy được. Kiểm tra quyền/cấu hình hiện có bằng cách không in secret.
- Snapshot/backup đúng loại khi đổi schema/data. Dashboard export cấu hình không chứa đầy đủ account/session nên không phải full DB backup.
- Xác nhận `ENCRYPTION_KEY` không thay đổi; không ghi nó vào PR hoặc report. Migrations additive phải tương thích rollback code.
- Cờ async/catalog mặc định an toàn; canary một nhóm endpoint. Không bật mọi flag cùng lúc.

### Kiểm tra sau deploy

- Render API/dashboard phải xác nhận **đúng commit** đang Live; image build pass không đủ. Không tạo deploy trùng khi đã có deploy cùng SHA đang chạy.
- `/api/ping`, `/livez`, `/api/auth/status`, `/api/auth/methods` trả JSON như contract. `/readyz` trả 200 nếu staging có upstream giả được cấu hình; 503 với reason đúng khi cố ý không có upstream, không coi đó là lỗi runtime.
- Không login: `/api/keys`, `/api/admin/users` bị từ chối. Có login admin/member: test đúng quyền và ownership trên DB staging với token riêng; không mint session trực tiếp vào production để benchmark.
- Kiểm tra browser flow thực tế cho phần UI được sửa; Google/email thực chỉ thử khi có cấu hình và người dùng cho phép các thao tác tương ứng. Không gửi mail/inference thật chỉ để có dấu PASS.
- Đo warm public + authenticated routes sau khi app sẵn sàng; ghi cold start riêng. Xem service events để phát hiện `server_failed`/unhealthy restart, không chỉ nhìn nhãn Live.
- Quan sát ít nhất hai health pass hoàn tất; với catalog, thêm một sync lớn có test signature hợp lệ và một failure injection trên staging.

### Điều kiện dừng và quay về

- Bất kỳ rò dữ liệu/authorization/quota sai hoặc catalog integrity sai: dừng rollout ngay; không chờ đủ mẫu latency.
- Nếu hai cửa sổ liên tiếp cùng workload có p95 xấu hơn baseline >20%, error tăng hoặc health-check timeout mới liên quan thay đổi: ngừng mở rộng, giữ evidence và rollback/canary-off.
- Drain/cancel in-flight theo thiết kế; đóng transaction trước khi chuyển backend/flag. Không cắt sang sync fallback giữa write chưa rõ outcome.
- Tắt flag của module mới hoặc deploy commit tương thích đã biết tốt. Đổi app code không tự rollback DB migration/data; không chạy migration down live theo phản xạ.
- Catalog lỗi: giữ guard remote tự động tắt. Region cutover lỗi: cần reconcile writes sau cutover trước khi quay về DB cũ.

## 7. Gói bàn giao cho Codex

Agent gửi: URL PR, head SHA, phase ID, ADR/Spec Kit artifacts, diff tóm tắt, bảng đo có script dựng lại, kết quả full checks, danh sách phần chưa chuyển/chưa test, và rollout/rollback cụ thể.

Codex review code thực trên đúng head SHA, kiểm tra số đo và race/failure tests; không coi bản tóm tắt của agent là bằng chứng đã chạy. Sau vòng sửa phải đối chiếu diff mới và chạy lại kiểm tra bị ảnh hưởng. Finding P0/P1 phải được giải quyết; không đánh dấu hoàn tất chỉ vì CI xanh hoặc bản deploy hiện đang trả 200.
