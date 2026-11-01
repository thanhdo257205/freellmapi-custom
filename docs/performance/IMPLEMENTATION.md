# Hướng dẫn triển khai theo giai đoạn

Đọc [bối cảnh và thứ tự PR](README.md) trước. Tất cả tên module, flag và interface mới bên dưới là **đề xuất**, không phải API đã tồn tại. Agent được điều chỉnh cách làm khi chứng minh được tương đương bằng ADR và số đo.

## P01 — Baseline và quan sát hệ thống

### Việc cần làm

1. Ghi commit, Node/package versions, backend, app/DB region, mức CPU/RAM, env tuning không nhạy cảm. Tách cold start khỏi warm service.
2. Trên staging/DB dùng một lần, tạo fixture 1/60/300 key và 1.000/100.000 request ledger bằng dữ liệu giả. Không chạy seed/reset/migrate benchmark trên DB production.
3. Đo dashboard thực sự đã login bằng admin và member, ngoài ping public. Các màn hình đầu tiên: Models, Keys, Analytics, Logs. Ghi request waterfall, số request và thời gian dữ liệu quan trọng xuất hiện.
4. Đo mỗi workload với concurrency 1/5/10, warm-up riêng, ít nhất 100 request thành công/thất bại được ghi nhận mỗi route/workload. Có hai lần chạy để thấy biến động; timeout vẫn nằm trong thống kê lỗi.
5. Tách các số: thời gian HTTP phía client; thời gian handler; DB execution/prepare; thời gian đợi queue; JSON serialization; download asset; cold start. Tổng duration các DB call song song có thể lớn hơn thời gian request, không được cộng trừ như critical path.

### Thiết kế instrumentation đề xuất

- Đặt module riêng, ví dụ `server/src/custom/performance/`; middleware mount tối thiểu ở entry point phù hợp. Nếu cần đo từ trước auth/body parsing thì phải nêu rõ vì mount ở `registerCustomRoutes` chỉ quan sát phần sau các middleware đứng trước nó.
- Dùng `performance.now()` cho duration; `monitorEventLoopDelay()`/event-loop utilization nếu có trên tất cả Node được hỗ trợ. Histogram event-loop dùng nanosecond: chuyển sang ms trước khi báo cáo.
- Một monitor mỗi process; reset histogram theo cửa sổ, `.unref()` timer, có cleanup; không tạo monitor/timer mới cho mỗi request.
- `AsyncLocalStorage` có thể giữ request-local counters, không chứa token/key/response. Test hai request xen kẽ không trộn counter.
- Các counter phân biệt logical DB execution, raw prepare cache miss, số statement trong batch, số operation đang chờ và đang chạy. Không gọi số `Db.prepare()` là số RPC thực; SDK có thể có handshake/retry/batch nội bộ.
- Chỉ log method, route **template**/route ID từ allowlist, status, duration, counts, backend và request ID ngẫu nhiên do server tạo. Không log `originalUrl`, query string, bind values, headers, body, SQL text chứa literal, raw driver error hoặc dynamic user/model/key ID làm label.
- Giới hạn cardinality và bộ nhớ; aggregate histogram/counter thay vì giữ mọi request. Bắt `finish`/`close` và bảo đảm chỉ kết toán một lần. Client đóng kết nối trước khi handler xong không được tính là thành công hoàn tất.
- Flag opt-in đề xuất `CUSTOM_PERF_METRICS=1`: mặc định tắt hoặc aggregate chi phí thấp. Không tạo endpoint metric public; nếu cần dashboard metric thì phải thiết kế permission riêng qua hệ thống gate hiện có.
- Mục tiêu overhead khi bật: không quá 5% p95 và không tăng RSS không giới hạn sau tối thiểu 10.000 request test. Đo được overhead thay vì giả định timer luôn miễn phí.

### Kết quả phải bàn giao

Một bảng top route chậm có p50/p95/max/error count/DB calls, một waterfall đã khử secret, một bảng request theo page/tab/role, và 3 hạng mục ưu tiên có bằng chứng. Production chỉ smoke read-only, tải thấp; không tự stress test dịch vụ live, không gửi inference hoặc health probe tiêu tốn quota provider thật.

## P02 — Polling, cache identity và cancellation trên client

### Audit trước khi sửa

- `App.tsx` đã cấu hình staleTime 30s. `KeysPage` và `ProviderList` đã dùng cùng key `['keys']`. TanStack có sẵn cơ chế chia sẻ query và xử lý focus/visibility; xác minh hành vi version đã cài trước khi tự viết timer/dedup.
- Models có routing và rate-limit usage polling 15s. Keys có health polling 30s; kiểm tra thêm query trong các section con, quyền thực tế và tab đang chọn.
- Phân biệt nhiều observer cùng query với nhiều HTTP request thật. React StrictMode trong dev không phải bằng chứng production đang gửi gấp đôi.

### Chính sách đề xuất

| Nhóm dữ liệu | Chính sách ban đầu | Tính đúng đắn bắt buộc |
| --- | --- | --- |
| Cấu hình/profiles/danh sách key | Ưu tiên invalidation sau mutation, staleTime theo baseline | Đổi profile phải đổi query key và request phải pin profile ID |
| Routing scores/rate usage | Poll khi màn hình/section cần và trang đang hiện; bắt đầu bằng giữ 15s rồi đo | Có indicator stale/error; không hiển thị trạng thái hết quota như dữ liệu mới |
| Health | Poll 30s khi section liên quan hiện; manual refresh vẫn hoạt động | Không nhầm kết quả check provider 401 với session hết hạn |
| Analytics/logs | Dùng time range/filter/page làm query identity; `sinceId` cho log tăng dần | Không bỏ filter/cursor và không tự đổi hợp đồng response |
| Session/quyền | Giữ cơ chế revision hiện có, server vẫn xác thực mỗi request | Logout/login account khác phải xóa toàn bộ dữ liệu identity cũ |

- Dùng API TanStack hiện có (`enabled`, options visibility/focus/refetch) và hook/module custom nhỏ. Không thêm cache `Map<URL, Promise>` dùng chung mọi tài khoản.
- Query function truyền signal: `({ signal }) => apiFetch(path, { signal })`. Giữ nguyên guard revision trước/sau đọc body và xử lý 401 của `apiFetch`.
- Abort phía trình duyệt không chứng minh truy vấn DB phía server đã dừng. Không quảng cáo đã giảm DB work nếu chỉ bỏ response ở client.
- Khi trở lại tab, refetch đúng freshness; không bắn đồng loạt mọi page/section. Không vô hiệu hóa focus refresh toàn app mà không xem từng query.
- Dùng permission helper hiện có; không suy rằng mọi admin có cùng quyền. Không mở quyền API để tránh 403. Query không được phép thì không chạy.
- Retry GET có giới hạn/backoff; không retry vô hạn 401/403 và không tự retry POST/PUT/DELETE có thể đã ghi thành công.

### Kiểm thử cần có

- Tab hiện → ẩn → hiện; unmount/remount section; route change; focus nhanh nhiều lần; mạng offline → online; request chậm hơn interval.
- Account A đang có request → logout → login B → response/401 cũ của A về: không ghi vào cache hoặc đăng xuất B.
- Profile A → B → A, bao gồm response về ngược thứ tự: không lẫn chain hoặc hồi sinh staged edits sai profile.
- Hai component cùng identity: một request in-flight, invalidation sau mutation vẫn cập nhật cả hai.
- Member/delegated admin/primary admin: số request phù hợp quyền; denied endpoint vẫn trả 401/403 ở server.
- Bằng chứng before/after là số request trong 5 phút cho cùng page/tab/role, không chỉ số timer bị xóa.

## P03 — Truy cập DB bất đồng bộ, chuyển dần từng luồng

### P03a: chốt thiết kế trước khi đổi caller

1. Giữ nguyên interface `Db` và factory đồng bộ cho code legacy/migrations/local. Không sửa `get()` thành Promise rồi dùng `as Db`.
2. Tạo interface async riêng trong file mới. Luồng đọc đầu tiên chỉ cần `get/all` Promise với SQL parameterized; chưa cần phơi bày write API cho mọi service.
3. Adapter remote dự kiến dùng `@libsql/client` vì production là DB libSQL. Tên `@tursodatabase/serverless` dành cho engine khác theo tài liệu hiện tại; không thay engine bằng cách đổi tên package.
4. Adapter SQLite giữ hành vi local và cùng mapping dữ liệu. Có thể wrap read đồng bộ bằng Promise để thống nhất caller; phải ghi rõ cách này không làm SQLite CPU work thành nonblocking.
5. Một số lượng connection/client hữu hạn cho process; không tạo client mỗi request. Giới hạn concurrency/queue theo số đo; đặt timeout theo cơ chế SDK thực sự hỗ trợ. `Promise.race(timeout)` tự nó không hủy query/transaction.
6. Chuẩn hóa row không tồn tại, null, number/bigint, BLOB, named/positional bindings, lỗi và redaction. Không làm lộ auth header/DB URL trong lỗi native hoặc HTTP client.
7. Nếu dùng đồng thời sync và async connection vào cùng DB, chứng minh chúng trỏ đúng DB và có lifecycle rõ ràng. Không chạy migrations sau khi bắt đầu nhận traffic; không chia một transaction qua hai connection.
8. Cờ rollout đề xuất `TURSO_ASYNC_READS`: chỉ điều khiển nhóm handler đã chuyển. Cờ chưa tồn tại ở baseline; cần định nghĩa default, startup validation và cách rollback. Không fallback sang DB SQLite khác khi Turso lỗi.

Ví dụ contract mang tính thiết kế, chưa phải patch:

```ts
interface AsyncQueryExecutor {
  get<T>(sql: string, args?: readonly unknown[]): Promise<T | undefined>;
  all<T>(sql: string, args?: readonly unknown[]): Promise<T[]>;
}
// Nếu về sau cần write: một withTransaction(fn) riêng, fn nhận chính
// executor của transaction. Không tái sử dụng Db.transaction(fn) đồng bộ.
```

### P03b: chọn đúng luồng thử nghiệm

- P01 chọn một endpoint đọc chậm, scope hẹp. Keys roster sau JOIN là ứng viên ít phụ thuộc; routing/fallback khó hơn vì `refreshStatsCache` có thể write observed speed rank và cập nhật state trong memory.
- Vẽ call graph thực tế, đánh dấu từng sync read/write và cache. Đổi Express handler thành `async` không đủ nếu service con vẫn gọi native driver đồng bộ.
- Auth/RBAC legacy vẫn có thể chặn trong giai đoạn đầu. Báo chính xác phần còn sync; không tuyên bố đã chuyển cả request hoặc cả server sang async.
- Tránh copy nguyên router upstream thành router async thứ hai. Tách data-access/helper nhỏ, dùng cùng phần tạo DTO hoặc test parity để tránh hai nguồn logic khác nhau. Nếu cần đổi nhiều file upstream để giữ đúng logic, ghi ADR về ngoại lệ phạm vi và xin review thiết kế thay vì giấu trong refactor lớn.
- Giữ JOIN của roster và param tháng UTC. Chạy test SQLite và adapter async có latency giả; số query không tăng theo 1/60/300 key.
- Các read độc lập có thể chạy song song trong giới hạn pool, nhưng chỉ khi không cần cùng snapshot. Read phụ thuộc transaction/authorization không được tùy tiện `Promise.all`.
- Không kéo dài `routing-settings-scope` hiện tại qua `await`. Nếu cần config snapshot async, thiết kế object immutable được tải tường minh, chỉ chứa allowlist không nhạy cảm; reload sau ghi và không dùng object đó để cấp quyền/quota.
- Timeout/read failure phải trả lỗi có kiểm soát theo quy ước hiện có, không trả dữ liệu admin cũ như thành công.

### Ranh giới auth/quota/write: chưa thuộc PR đọc đầu tiên

Thêm `await` làm các request xen kẽ được. Với pattern “đọc used → kiểm tra limit → ghi used”, hai request có thể cùng vượt qua. Khi phạm vi này được đề xuất, cần PR/ADR riêng:

- Audit `checkUserRateLimit`, `reserveMonthlyBudget`, rate-limit lease, key revocation, user-key lookup và request settlement. Bộ đếm RPM trong memory và ledger tháng bền vững là hai cơ chế khác nhau.
- Với một slot còn lại và 10 request song song, chỉ số request được phép tương ứng slot mới được nhận; release đúng một lần khi success/error/abort. Không rò reservation.
- Đề xuất atomic conditional write/transaction/lease phù hợp backend. Mutex trong process chỉ có giá trị ở một instance; không được công bố multi-instance safe từ test đó.
- Revoke session/key trong khi request đang đợi DB: chốt thời điểm kiểm tra quyền/admission, kiểm tra lại khi cần; request bắt đầu sau revoke commit phải bị từ chối. Không dùng snapshot cũ để cấp quyền mới.
- Ghi usage và analytics/trigger liên quan phải giữ nguyên atomicity, idempotency và chính sách retention. Không “tối ưu” bằng cách bỏ durable enforcement hoặc ghi usage sau response không bảo đảm hoàn tất.
- Không tự retry write/settlement khi timeout mà chưa biết commit đã xảy ra hay chưa. Cần idempotency key hoặc reconciliation được thiết kế và test.
- Hủy/timeout/commit phải close hoặc rollback transaction đúng connection; không để lock sống đến timeout mặc định.

### Test và rollout của P03

- Fixture driver trả kết quả sau 150–300 ms; ping khác phải được xử lý trong lúc query chưa xong. Đo thêm adapter thật trên DB staging; fake latency không thay thế test giao thức.
- Hỏng token, DB unreachable, malformed response, timeout, process shutdown, pool saturation; queue/memory phải có giới hạn.
- Test parity SQLite/async cho DTO, ordering, UTC boundary, overrides/profile và lỗi; thực thi RBAC trên HTTP thật.
- Canary một nhóm endpoint với cờ off/on; không shadow-write và không nhân đôi query production để “so kết quả”. Có thể so read-only trên staging hoặc sampling được review.
- Rollback bằng tắt cờ/deploy commit đã biết tốt sau khi xử lý in-flight work. Không chuyển connection giữa chừng khi transaction còn chạy.

## P04 — Catalog async/batch có công bố dữ liệu atomic

### Những thứ phải giữ nguyên

`syncCatalog` kiểm chữ ký Ed25519 trên đúng bytes, kiểm version/tier, áp dụng catalog, bảo toàn model overrides, tombstones, retirement, endpoint scope, modality tables và profile membership. Các custom model/key/profile hiện có không được biến mất. ID của model đã tồn tại phải giữ ổn định để log và liên kết không sai.

Không dùng test “số model bằng nhau” thay cho parity đầy đủ. Không sửa chữ ký/public key/policy license để làm sync nhanh hơn.

### ADR P04a phải trả lời

- Cách fetch/verify/normalize/diff trước khi ghi; các lần đọc metadata được gộp thế nào để tránh SELECT cho từng model.
- SQL batch size và payload byte limit; có thể bắt đầu thử 50 statement/batch rồi đo. Con số này là cấu hình thử nghiệm, không phải limit chính thức của Turso.
- Cách bảo đảm chỉ một sync chạy, kể cả manual và scheduler trùng nhau; process lock không đủ nếu có hai instance trong rolling deploy.
- Cách bảo đảm reader thấy bộ catalog cũ hoặc mới hợp lệ, không thấy chuỗi update dở dang.
- Nếu dùng staging table bền vững: migration mới, operation ID, cleanup, stable model ID, tham chiếu FK và atomic publish bằng SQL set-based/transaction. **Staging không tự tạo atomicity** nếu reader vẫn đọc live table đang bị sửa từng chunk.
- Nếu chọn một transaction bao trùm: chứng minh thời gian nằm trong giới hạn thực tế của DB. Tài liệu libSQL hiện nêu timeout 5s cho interactive transaction; không coi `await` hoặc `batch()` là cách bỏ giới hạn đó.
- Khi crash sau vài batch, sau publish nhưng trước ghi marker, hoặc giữa ghi version/tier/cached JSON: cách recovery/idempotency để không công bố metadata sai hoặc ghi trùng.
- Những invariant nào cần schema mới hoặc hook nhiều upstream file; nếu chưa giải được mà vẫn giữ tương thích, giữ catalog remote tự động tắt và bàn giao hạn chế còn lại.

### Thử nghiệm và bật lại

- Fixture 100/1.000/5.000 model bao gồm chat, media, embeddings và trường hợp custom, override, tombstone, retired, profile đang có staged edits.
- So sánh normalized state với apply local hiện tại, bao gồm các giá trị/ID/tập liên kết; test version cũ/same version, chữ ký sai, manual/automatic cùng lúc và retry sau crash.
- Inject lỗi ở mỗi ranh giới ghi/publish; không có nửa catalog active, orphan FK hoặc marker “applied” khi dữ liệu chưa hoàn tất.
- Trong lúc sync, probe ping/readiness và API dashboard; đo event-loop delay và DB queue. Không nới health check để test pass.
- Scheduler hiện tại `every` không đợi async callback hoàn tất trước tick tiếp. Module mới phải tự kiểm soát in-flight hoặc tự schedule sau khi xong; không sửa toàn bộ scheduler nếu chưa audit mọi caller.
- Cờ đề xuất `TURSO_ASYNC_CATALOG` mặc định off. Chỉ đề xuất bật ở live sau review số đo/parity/crash recovery; không tự xóa `CATALOG_SYNC_DISABLED` hoặc remote guard trong PR adapter.

## P05 — Analytics, logs, phân trang và index dựa trên số đo

- Phân biệt `/api/logs` với `/api/analytics/requests`. Logs viewer hiện dùng ring buffer để query và có `sinceId`, trần limit 500; log persistence/restore lại có DB I/O. Đo đúng phần trước khi thêm index hoặc endpoint mới.
- Analytics requests đã có `limit/offset` và trần 500. Audit SQL aggregate/time range, các count query và deep offset với fixture lớn. Không ghi rằng đang thiếu pagination nếu code đã có.
- Chạy `EXPLAIN QUERY PLAN` trên staging cho đúng filter/order và cardinality đại diện. Ghi index hiện có, query plan trước/sau, p95 read, chi phí insert/settlement và kích thước DB.
- Nếu deep offset là vấn đề, đề xuất cursor/keyset có thứ tự ổn định với ID làm tie-breaker. Giữ request/response cũ hoạt động hoặc đưa version/additive contract có test; không âm thầm đổi semantics `offset`.
- Filter/sort phải parameterized/allowlisted; giới hạn page/time range theo contract hiện tại. Không chuyển filter từ server về client để lấy toàn bộ dữ liệu trước.
- Index mới phải có migration timestamp độc lập, tên rõ ràng, up/down và test sau dữ liệu đã tồn tại. Không thay migration lịch sử; không thêm index trùng tiền tố theo phỏng đoán.
- Không xóa hoặc cắt ngắn durable monthly usage để làm analytics nhanh. Analytics retention không đồng nghĩa quota reset.
- Schema rollback phải được thử trên DB dùng một lần; code rollback không tự gỡ index/migration live. Chọn migration backward-compatible để bản code cũ vẫn chạy được.

## P06 — Chia bundle theo route

- `App.tsx` hiện import tĩnh nhiều page. Dùng manifest/build report để xác định route/dependency nào thực sự nằm trong main chunk; main bundle lớn không chứng minh mọi page đều là nguyên nhân.
- Ưu tiên `React.lazy`/dynamic import ở page ít dùng như Analytics, Premium, modality detail. Giữ auth shell/nav/identity boundary và các UI thiết yếu ổn định.
- Thêm Suspense/loading/error phù hợp UI hiện có; error boundary phải xử lý chunk load failure khi redeploy hoặc offline. Không tạo vòng reload vô hạn.
- Giữ deep link trực tiếp, BrowserRouter basename, invite query, OAuth callback, password-reset URL, refresh trang, locale/RTL và permission gating. Không bỏ token/reset query param trước khi handler cần dùng.
- Không prefetch tất cả lazy page ngay sau login. Nếu prefetch, dựa intent và có giới hạn; tính tổng JS thực tải trong 10 giây đầu, không chỉ main chunk.
- So sánh cùng Node/Vite/lockfile và gzip setting; ghi initial-route JS gzip/transfer, số request, thời gian đến UI dùng được trên desktop và mạng mobile giả lập. Mục tiêu giảm ≥20% JS cho route đầu tiên phải kiểm chứng, không hứa trước.
- Không nâng bundler/React hoặc refactor i18n cùng PR chỉ để đổi chunk; kiểm tra 60 locale theo quy trình repo.

## P07 — Region hoặc gói hạ tầng, phạm vi ADR

- Xác minh lại app region, DB primary group, mọi DB dùng chung group và giới hạn gói qua nguồn chính thức. Không dựa hoàn toàn vào hostname.
- Đo RTT/app-to-DB từ chính môi trường chạy app và tách prepare/execution trước khi quyết định. Đổi region có thể cải thiện latency mỗi lượt, nhưng không sửa việc gọi tuần tự quá nhiều lần.
- ADR phải nêu chi phí, phạm vi ảnh hưởng tới DB khác, backup đầy đủ kèm encryption key bảo quản riêng, cửa sổ dừng ghi, cutover, xác minh và reconcile writes nếu quay về.
- Không chuyển region/group của dự án Turso khác, tạo gói trả phí hoặc đổi plan Render trong phạm vi mặc định của handoff. Gửi phương án cụ thể cho người dùng quyết định trước.
- Render Free có idle sleep; đo cold start riêng. Không triển khai bot ping giữ thức làm lời giải cho latency warm hoặc synchronous blocking.
