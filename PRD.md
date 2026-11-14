# PRD — UMail

**Unified Gmail Manager** — satukan beberapa akun Gmail dalam satu inbox, satu pencarian, satu composer, dan satu panel manajemen.

| Item | Nilai |
|---|---|
| Nama produk | UMail |
| Versi dokumen | 1.0 |
| Status | Draft untuk implementasi |
| Stack | Hono + Node.js 20, SQLite (`better-sqlite3`), Vite, Vanilla JS, TailwindCSS v4 |
| Basis desain | UDrive (`/home/gegeembrie/Documents/NodeJS/udrive`) |
| Target | Self-hosted, native Node.js + Docker |

---

## 1. Ringkasan

UMail adalah aplikasi web self-hosted untuk mengelola banyak akun Gmail sekaligus. Pengguna menghubungkan akun Google via OAuth, lalu membaca, mencari, mengirim, membalas, memberi label, mengarsipkan, dan menghapus email dari semua akun tanpa berpindah tab atau login ulang.

Berbeda dari UDrive yang menggabungkan kapasitas penyimpanan, UMail menggabungkan **kotak masuk dan identitas pengirim**. Setiap email tetap dimiliki akun asalnya. UMail tidak memindahkan email antar akun dan tidak membuat alamat email baru.

Prinsip:

1. **Gmail adalah sumber kebenaran.** Cache lokal hanya untuk kecepatan.
2. **Satu UI untuk semua akun.** Account filter tersedia di mana-mana.
3. **Aman secara default.** Token tidak pernah dikirim ke browser; HTML email dirender tanpa script dan tanpa gambar remote.
4. **Sama seperti UDrive.** Struktur proyek, pola route, permission, tema, dan komponen visual mengikuti UDrive.

---

## 2. Masalah

Pengguna memiliki 2–10 akun Gmail: pribadi, kerja, komunitas, project, atau akun lama. Akibatnya:

- Harus login/logout atau memakai banyak browser profile.
- Inbox, label, dan pencarian terpisah.
- Email penting terlewat karena tidak ada tampilan gabungan.
- Mudah membalas dari akun yang salah.
- Tidak ada audit aktivitas dan kontrol akses saat perangkat dipakai bersama.
- Tidak ada API terpadu untuk otomasi.

---

## 3. Tujuan dan non-goals

### 3.1 Tujuan

- Menghubungkan minimal 5 akun Gmail dalam satu aplikasi.
- Menyediakan unified inbox, unified search, dan unified label view.
- Membaca thread dan mengirim email dari akun yang dipilih.
- Menyimpan metadata email di SQLite agar daftar email tetap cepat.
- Menyediakan multi-user dengan role Master/Slave dan permission granular.
- Menyediakan API key untuk otomasi, activity log, dan system log.
- Berjalan native maupun Docker dengan database persisten.

### 3.2 Non-goals MVP

- Bukan penyedia email baru; tidak ada alamat `@umail`.
- Tidak mendukung IMAP/POP3, Outlook, Yahoo, atau provider non-Gmail.
- Tidak menggabungkan thread yang sama dari akun berbeda menjadi satu percakapan.
- Tidak memindahkan/menyalin email antar akun.
- Tidak ada kalender, kontak, Google Chat, atau Google Drive.
- Tidak ada mode offline penuh; body email diambil saat dibuka.
- Tidak ada push notification real-time via Google Pub/Sub pada MVP.
- Tidak ada public share link untuk email.
- Tidak ada AI summary, filter Gmail, vacation responder, atau scheduled send pada MVP.
- Tidak menyimpan password Google; hanya OAuth token.

Catatan: akun Google Workspace didukung jika admin mengizinkan Gmail API dan OAuth client.

---

## 4. Pengguna dan peran

| Peran | Kemampuan |
|---|---|
| Master | Semua permission. Membuat user, mengatur permission, mengelola akun Google, settings, API key, dan melihat semua log. |
| Slave | Hanya halaman dan aksi yang diberikan. Default: lihat email, tapi tidak bisa kirim, hapus, atau kelola akun. |
| API client | Akses via API key dengan permission dan rate limit per key. Tidak bisa login ke UI. |

Setup pertama membuat Master. Master tidak bisa dihapus dari UI.

---

## 5. Keputusan produk default

Keputusan ini dipakai kecuali user meminta lain:

- **Gmail API only**, bukan IMAP.
- **Polling** tiap 60 detik (bisa diubah 30 detik–15 menit), bukan Pub/Sub.
- **Metadata cache 90 hari** per akun, maksimal 1.000 pesan saat sync awal. Email lebih lama diambil remote saat dibutuhkan.
- **Body tidak disimpan permanen** pada MVP; diambil saat thread dibuka, lalu hanya ada di memori.
- **Satu thread = satu akun.** Thread dari akun berbeda tidak digabung.
- **Composer plain text** pada MVP; rich text, signature, dan template masuk P1.
- **Account default** dipakai sebagai pengirim awal; user tetap bisa memilih akun lain di composer.
- **Tidak ada keep-alive palsu.** Kesehatan akun dicek dengan refresh token dan sinkronisasi, bukan membuat email aktivitas.
- **Scope Gmail restricted.** Untuk pemakaian publik, Google verification diperlukan. Untuk self-hosted pribadi, gunakan mode Testing dengan test user.

---

## 6. Prioritas lingkup

| Prioritas | Isi |
|---|---|
| **P0 — MVP** | Setup/login, multi-user dasar, tambah/hapus akun via OAuth, token refresh, sync inbox, unified inbox, thread reader, archive/trash/spam/star/read, label filter + apply, search lintas akun, compose/reply/reply-all/forward, attachment download/upload, draft simpan, settings dasar, theme, responsive, activity/system log, Docker. |
| **P1 — Parity** | User management UI, permission granular, API key + API v1 + docs, autosave draft, signature per akun, composer rich text, label CRUD, account health, database export/import, keyboard shortcuts, browser notification, bulk select all, unread badge, mobile gestures. |
| **P2 — Lanjutan** | Pub/Sub push, sendAs alias, Gmail filters/vacation, scheduled send, undo send, template/snippet, contact autocomplete, AI summary, import mbox, shared mailbox. |

---

## 7. Fitur

### 7.1 Setup dan autentikasi aplikasi

- First run: wizard membuat Master (username, password, konfirmasi).
- Login: username + password, session httpOnly cookie.
- Password: PBKDF2 via Web Crypto, sama seperti UDrive.
- Session timeout per user (default 24 jam).
- CSRF token untuk request mutasi.
- Logout dengan konfirmasi.
- Route guard: halaman hanya tampil jika user punya minimal satu permission di grup halaman.
- Google OAuth hanya bisa dimulai oleh user yang sudah login ke UMail dan punya `accounts:add`.
- State OAuth ditandatangani dan terikat ke session untuk mencegah CSRF.

### 7.2 Manajemen akun Google

- Tambah akun lewat tombol **Add Account** → redirect Google OAuth.
- Satu callback menambah atau memperbarui satu akun berdasarkan email.
- Simpan `access_token`, `refresh_token`, `token_expiry`, `scopes`, `history_id`.
- Refresh token otomatis sebelum kedaluwarsa; retry sekali saat 401.
- Akun card menampilkan: avatar, nama, email, warna, badge Default, unread count, last sync, status sehat/error.
- Aksi: set default, ganti warna, refresh sekarang, reconnect, hapus.
- Hapus akun menghapus token dan seluruh cache email akun tersebut; konfirmasi eksplisit.
- Tidak ada import token/rclone. Tambah akun hanya via OAuth.
- Warna card otomatis dari palette UDrive dan bisa diubah.
- Jika refresh token dicabut, akun ditandai `reauth_required` dan UI menampilkan tombol Reconnect.

### 7.3 Unified inbox

- Pilihan tampilan: **All accounts** atau satu akun.
- Mailbox: Inbox, Starred, Sent, Drafts, Archive, Spam, Trash, Important. Snoozed tidak didukung.
- Daftar gabungan diurutkan `internal_date DESC`, cursor-based pagination.
- Setiap baris: checkbox, star, warna akun, avatar/inisial, pengirim, subjek, snippet, label chip, ikon attachment, tanggal.
- Baris unread lebih tebal; baris terbaca lebih redup.
- Badge unread per akun dan total di sidebar.
- Aksi massal pada pilihan: mark read/unread, star/unstar, archive, trash, spam, apply/remove label.
- Aksi massal lintas akun dijalankan per akun; hasil parsial dilaporkan via toast.
- Filter akun disimpan di `localStorage`.
- "Load older" mengambil halaman berikutnya dari Gmail untuk akun terpilih, atau fan-out ke semua akun.
- Refresh manual + auto-refresh sesuai interval.
- Empty state berbeda untuk inbox kosong, filter kosong, dan akun belum tersambung.

### 7.4 Reader dan thread

- Klik baris membuka thread di pane kanan (desktop) atau full screen (mobile).
- Tampilkan semua pesan dalam thread, urut kronologis, pesan terbaru terbuka.
- Header: subjek, label, akun, pengirim, penerima, CC, tanggal.
- Body HTML dirender dalam `<iframe sandbox>` tanpa `allow-scripts`; CSP memblokir resource eksternal.
- Gambar remote diblokir default; tombol "Show images" memuat ulang dengan izin sementara.
- Fallback ke `text/plain` jika HTML tidak ada.
- Attachment ditampilkan sebagai chip: nama, ukuran, tombol download.
- Aksi: reply, reply all, forward, star, archive, trash, spam, mark unread, apply label, open in Gmail.
- Tandai read saat thread dibuka, kecuali setting "Mark as read on open" dimatikan.
- Link di body tidak otomatis membuka tab dari dalam iframe; klik link ditangani untuk membuka tab baru dengan `noopener`.
- Pesan yang sangat besar di-truncate dengan tombol "View entire message".

### 7.5 Compose, reply, forward, send

- Composer docked di kanan bawah; bisa diperbesar menjadi modal.
- Field: From (account dropdown), To, Cc, Bcc, Subject, Body.
- Mode: new, reply, reply-all, forward.
- Reply memakai `threadId`, `In-Reply-To`, dan `References` yang benar.
- `Reply-To` dipertahankan jika ada.
- Plain text pada MVP; newline dikonversi ke HTML sederhana saat membangun MIME.
- Attachment via file picker; total pesan maksimal 25 MB (batas Gmail).
- Tombol Send, Save draft, Discard.
- Draft disimpan ke Gmail Drafts; draft lokal disimpan lebih dulu agar tidak hilang saat request gagal.
- Outbox lokal untuk retry jika jaringan gagal; status terlihat di toast/panel.
- Setelah sukses, tampilkan toast dan buka thread Sent.
- Validasi: minimal satu penerima valid, subject boleh kosong, From wajib akun yang terhubung.
- Jangan pernah menaruh BCC di header yang terlihat penerima.
- Deteksi kegagalan quota/rate limit dan tampilkan pesan yang bisa ditindaklanjuti.

### 7.6 Organisasi email

- Star/unstar, read/unread, archive (remove `INBOX`), move to inbox, trash/untrash, spam/not spam.
- Apply/remove label yang sudah ada.
- Label sistem dan label custom ditampilkan; label dengan nama sama dari akun berbeda digabung di UI, tetapi aksi tetap per `account_id + label_id`.
- Bulk action pada halaman aktif.
- Tidak ada permanent delete pada MVP; hanya trash. Permanent delete masuk P2.
- Create/rename/delete label masuk P1.

### 7.7 Search

- Search bar global di top bar.
- Query diteruskan ke Gmail `q` untuk setiap akun terpilih (fan-out paralel, concurrency dibatasi).
- Mendukung sintaks Gmail: `from:`, `to:`, `subject:`, `has:attachment`, `after:`, `before:`, `label:`, `is:unread`.
- Hasil digabung, di-dedupe berdasarkan `(account_id, gmail_message_id)`, diurutkan berdasarkan tanggal.
- Search hanya mencakup akun yang dipilih; default semua akun.
- Hasil remote tidak disimpan permanen; metadata yang sudah ada di cache dipakai lebih dulu.
- Tampilkan jumlah hasil per akun dan status jika salah satu akun gagal.
- Search lokal pada cache menjadi fallback jika Gmail API error.

### 7.8 Attachment

- Download diproksikan backend: `GET /api/attachments/:accountId/:messageId/:attachmentId`.
- Nama file disanitasi; `Content-Disposition: attachment`.
- Inline image (`Content-ID`) di-rewrite ke URL attachment bertanda tangan berumur pendek, bukan `cid:` langsung.
- Batas ukuran upload mengikuti Gmail 25 MB; tampilkan error sebelum kirim.
- Tidak ada antivirus; UI memberi peringatan bahwa file dari pengirim tidak dikenal berisiko.
- Attachment tidak disimpan permanen di server.

### 7.9 Settings

- General: default account, sync interval, sync window (30/90/180 hari), mark read on open, block remote images.
- Tampilan: theme light/dark/auto, timezone, format 12/24 jam.
- Compose: signature per akun (P1), default reply behavior (P1).
- Logging: enable/disable activity log dan system log.
- Database: download backup, restore backup (P1).
- Account health: daftar akun, status token, last sync, last error.
- API access: kelola API key (P1).
- Danger zone: hapus cache, disconnect semua akun.

### 7.10 User, role, permission

- Master dapat membuat, menonaktifkan, menghapus user Slave.
- Permission per grup halaman, sama seperti UDrive.
- Session timeout per user.
- Reset password oleh Master.
- User tidak bisa mengubah role sendiri menjadi Master.
- Audit perubahan permission di activity log.

### 7.11 Activity dan system log

- Activity log: user, aksi, akun, detail, waktu. Contoh: `mail.send`, `mail.delete`, `accounts.add`, `settings.update`.
- System log: level, pesan, detail, waktu. Contoh: token refresh gagal, sync gagal, quota exceeded.
- Filter: user, aksi, akun, level, rentang tanggal.
- Retention default 30 hari; bisa dikonfigurasi.
- Jangan pernah mencatat token, password, isi email, atau attachment.

### 7.12 API akses

- API key dengan prefix, hash, permission, rate limit, expiry, last used.
- Endpoint API v1 untuk accounts, messages, threads, labels, search, send.
- Rate limit per key per menit, disimpan di SQLite.
- API docs page berisi contoh curl.
- API key hanya ditampilkan sekali saat dibuat.
- Permission API: `api:mail:read`, `api:mail:send`, `api:mail:modify`, `api:accounts:read`.

### 7.13 Deployment dan data

- Native: `npm run dev`, `npm run build`, `npm start`.
- Docker: satu container, port 3000, volume `/app/data`.
- SQLite di `data/umail.db`.
- Backup/restore file database; restore membutuhkan restart.
- `.env` hanya berisi kredensial OAuth dan port; pengaturan aplikasi disimpan di DB.

---

## 8. UX dan desain visual

Desain mengikuti UDrive, bukan meniru Gmail.

### 8.1 Design tokens

- TailwindCSS v4, class-based dark mode: `@custom-variant dark (&:where(.dark, .dark *))`.
- Font: Inter.
- Ikon: Material Icons Outlined.
- Warna utama: `blue-600`; hover `blue-700`; background terang `white` / `gray-50`; dark `gray-900` / `gray-800`.
- Border: `gray-200` light, `gray-700` dark.
- Tombol utama: pill (`rounded-full`), `btn-primary`; tombol sekunder outline pill; tombol danger merah.
- Card: `rounded-xl` + border tipis, shadow hanya saat hover.
- Header: tinggi 48 px (`h-12`), border bawah.
- Sidebar desktop: 256 px, item nav `rounded-full`, aktif `bg-blue-50 text-blue-700` / dark `bg-blue-900/30`.
- Mobile bottom nav: tinggi 56 px, item ikon + label kecil.
- Toast: kanan bawah, di atas mobile nav.
- Modal: overlay hitam 50%, panel `rounded-xl shadow-2xl`.
- Account card: border 2 px + border-top 4 px sesuai warna akun, seperti UDrive.
- Empty state: ikon outline besar, judul, deskripsi, satu CTA.

### 8.2 Layout

```text
┌──────────────────────────────────────────────────────────────┐
│ Top bar 48px: hamburger | UMail | search | refresh | theme | user │
├──────────────┬───────────────────────┬───────────────────────┤
│ Sidebar 256  │ Mail list 380px       │ Reader / pane kanan   │
│              │                       │                       │
│ Compose      │ [ ] ☆ Sender          │ Subject               │
│ All accounts │     Subject           │ Messages...           │
│ Inbox  12    │     Snippet           │                       │
│ Starred      │                       │                       │
│ Sent         │                       │                       │
│ Drafts       │                       │                       │
│ Archive      │                       │                       │
│ Spam         │                       │                       │
│ Trash        │                       │                       │
│ Labels       │                       │                       │
│ Accounts     │                       │                       │
│ Sync status  │                       │                       │
└──────────────┴───────────────────────┴───────────────────────┘
```

- Desktop: sidebar + list + reader (three-pane).
- Tablet: sidebar collapsible; list + reader.
- Mobile: satu pane pada satu waktu. List → reader full screen; tombol back.
- Composer: panel bawah kanan 520×420 px, bisa maximize.
- Search: overlay di top bar; hasil tampil di list.
- Bulk action bar muncul di atas list saat ada pilihan.

### 8.3 Halaman dan route hash

| Route | Halaman |
|---|---|
| `#/` | Inbox semua akun |
| `#/mail/:mailbox` | Inbox/starred/sent/drafts/archive/spam/trash |
| `#/label/:name` | Filter label gabungan |
| `#/thread/:accountId/:threadId` | Thread reader |
| `#/search?q=` | Hasil pencarian |
| `#/accounts` | Manajemen akun Google |
| `#/settings` | Settings |
| `#/users` | Manajemen user (Master) |
| `#/activity` | Activity log |
| `#/logs` | System log |
| `#/api-access` | API key |
| `#/api-docs` | Dokumentasi API |
| `#/login` | Login |
| `#/setup` | First-run wizard |

### 8.4 Komponen

- `sidebar.js`: nav mailbox, label, account selector, unread badge, sync status, collapsed mode.
- `top-bar.js`: search, refresh, theme toggle, user menu.
- `mail-list.js`: virtualized/segmented list, checkbox, star, account dot, date formatting.
- `reader.js`: thread header, message cards, HTML iframe, attachment list, reply bar.
- `composer.js`: From/To/Cc/Bcc, subject, body, attachment, send/draft/discard, minimize.
- `account-card.js`: kartu akun berwarna, status, unread, actions.
- `toast.js`, `modal.js`, `context-menu.js`, `logout-modal.js`: reuse pola UDrive.
- `search-overlay.js`: input, hint sintaks, hasil.
- `sync-indicator.js`: status sinkron, spinner, last sync, error.
- `empty-state.js`, `skeleton.js`.
- `attachment-chip.js`.
- `label-chip.js`.
- `bulk-bar.js`.
- `confirm-dialog.js` untuk aksi destruktif.

### 8.5 State dan feedback

- Loading pertama: skeleton baris.
- Sync berjalan: indikator kecil di sidebar, tidak memblokir UI.
- Aksi optimistis untuk star/read; rollback + toast jika gagal.
- Error API: toast merah dengan pesan singkat; detail di system log.
- Rate limit: pesan "Gmail rate limit. Coba lagi dalam X detik."
- Token expired: banner "Reconnect akun X".
- Offline: banner "Tidak ada koneksi. Menampilkan cache."
- Konfirmasi wajib untuk: hapus akun, hapus cache, trash massal, permanent delete (P2), restore database.
- Tidak ada spinner global yang menutupi seluruh aplikasi.

### 8.6 Aksesibilitas

- Semua tombol punya `title`/`aria-label`.
- Fokus terlihat (`focus-visible:ring-2`).
- Kontras teks minimal WCAG AA.
- Navigasi keyboard: Tab, Enter, Escape menutup modal, `/` fokus search, `c` compose, `j/k` pindah baris (P1).
- Status tidak hanya dibedakan dengan warna; gunakan ikon/teks.
- `prefers-reduced-motion` untuk animasi.

### 8.7 Responsif

- Breakpoint `md` 768 px.
- Mobile: bottom nav berisi Mail, Accounts, Settings, Users (jika berhak), Compose FAB.
- Reader dan composer full screen di mobile.
- Tabel/label tidak overflow horizontal.
- Target sentuh minimal 40×40 px.

---

## 9. Arsitektur teknis

### 9.1 Stack

- Backend: Hono di Node.js 20, `@hono/node-server`.
- DB: SQLite via `better-sqlite3`, wrapper async seperti UDrive.
- Frontend: Vite, Vanilla JS SPA, TailwindCSS v4.
- Auth aplikasi: PBKDF2 + session cookie httpOnly.
- Google API: REST `fetch` langsung, tanpa package `googleapis`.
- Tidak ada Redis, queue eksternal, atau edge runtime.

### 9.2 Struktur proyek

```text
umail/
├── src/
│   ├── app.js                  # factory Hono, mount route
│   ├── local.js                # entrypoint Node/Docker
│   ├── db/
│   │   ├── index.js            # initDB, migration, seed
│   │   └── local.js            # wrapper better-sqlite3
│   ├── middleware/
│   │   ├── auth.js             # session, permission, CSRF
│   │   └── api-auth.js         # API key, rate limit
│   ├── routes/
│   │   ├── auth.js             # OAuth Google
│   │   ├── accounts.js
│   │   ├── mail.js             # list, thread, actions
│   │   ├── compose.js          # send, draft, attachment
│   │   ├── search.js
│   │   ├── labels.js
│   │   ├── attachments.js
│   │   ├── settings.js
│   │   ├── users.js
│   │   ├── activity.js
│   │   ├── logs.js
│   │   ├── api-keys.js
│   │   └── api-v1.js
│   ├── services/
│   │   ├── gmail.js            # semua operasi Gmail REST
│   │   ├── token-manager.js    # refresh token
│   │   ├── sync.js             # initial + incremental sync
│   │   ├── sync-scheduler.js
│   │   ├── mime.js             # bangun/parse MIME
│   │   ├── sender.js           # outbox + send
│   │   ├── mail-cache.js       # query cache
│   │   ├── account-health.js
│   │   ├── logger.js
│   │   └── password.js
│   └── config.js
├── client/
│   ├── index.html
│   ├── main.js
│   ├── router.js
│   ├── api.js
│   ├── auth-state.js
│   ├── theme.js
│   ├── time-utils.js
│   ├── style.css
│   ├── components/
│   └── pages/
├── data/                       # SQLite, gitignored
├── scripts/
├── Dockerfile
├── docker-compose.yaml
├── .env.example
├── package.json
└── PRD.md
```

### 9.3 Alur request

```text
Browser → Vite/Hono → session auth → permission check
        → route → service → Gmail API (fetch + token refresh)
        → SQLite cache update → JSON response
```

- Browser tidak pernah memanggil Google langsung.
- Semua token hanya ada di server.
- Setiap request mutasi memeriksa CSRF dan permission.
- Semua operasi Gmail memakai `account_id` eksplisit; tidak ada "current account" global di backend.

### 9.4 Konfigurasi

`.env`:

```env
PORT=3000
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

- Redirect URI diturunkan dari request (`X-Forwarded-Proto`/`X-Forwarded-Host`) seperti UDrive: `/auth/callback`.
- Scope OAuth: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.send`.
- `access_type=offline`, `prompt=consent` agar refresh token didapat.
- Gmail API harus enabled di Google Cloud project.
- Untuk deployment publik dengan scope restricted, siapkan verifikasi Google. Untuk self-hosted pribadi, gunakan OAuth consent screen mode Testing dan daftarkan test user.

---

## 10. Data model SQLite

Semua tabel memakai `created_at`/`updated_at` bila relevan.

### 10.1 Tabel inti

```sql
users (
  id, username UNIQUE, password_hash, role,              -- master | slave
  is_active, session_timeout_hours, created_at
)

sessions (
  token PRIMARY KEY, user_id, csrf_token, expires_at, created_at
)

user_permissions (
  id, user_id, permission, UNIQUE(user_id, permission)
)

google_accounts (
  id, email UNIQUE, display_name, avatar_url,
  access_token, refresh_token, token_expiry, scopes,
  history_id, sync_enabled, is_default,
  card_color, status,                                     -- healthy | reauth_required | error
  last_synced_at, last_error, created_at, updated_at
)

labels (                                                  -- cache label Gmail
  id, account_id, gmail_label_id, name, type,             -- system | user
  color, messages_total, messages_unread,
  threads_total, threads_unread,
  UNIQUE(account_id, gmail_label_id)
)

threads (
  id, account_id, gmail_thread_id, subject, snippet,
  last_message_at, message_count, label_ids,
  is_unread, is_starred, is_important,
  UNIQUE(account_id, gmail_thread_id)
)

messages (
  id, account_id, gmail_message_id, gmail_thread_id,
  internal_date, from_name, from_email,
  to_json, cc_json, bcc_json, reply_to,
  subject, snippet, label_ids, size_estimate,
  is_unread, is_starred, is_important, has_attachment,
  raw_headers_json,
  UNIQUE(account_id, gmail_message_id)
)

attachments (
  id, account_id, message_id, part_id, filename, mime_type,
  size, content_id, is_inline,
  UNIQUE(account_id, message_id, part_id)
)

drafts (
  id, account_id, gmail_draft_id, gmail_message_id,
  thread_id, to_json, cc_json, bcc_json, subject, body,
  attachments_json, status, updated_at
)

outbox (
  id, account_id, draft_id, payload_json,
  status,                                                 -- queued | sending | sent | failed
  attempts, next_attempt_at, last_error, sent_at, created_at
)

sync_state (
  account_id PRIMARY KEY, history_id, last_full_sync_at,
  last_incremental_sync_at, last_error, cursor_json
)

settings (key PRIMARY KEY, value)

activity_log (
  id, user_id, username, action, account_id, detail, created_at
)

system_log (
  id, level, message, detail, created_at
)

api_keys (
  id, name, key_hash UNIQUE, key_prefix, user_id,
  permissions, rate_limit, expires_at, last_used_at, created_at
)

api_rate_limits (
  key_hash, window_start, request_count,
  PRIMARY KEY(key_hash, window_start)
)
```

### 10.2 Index wajib

```sql
CREATE INDEX idx_messages_account_date ON messages(account_id, internal_date DESC);
CREATE INDEX idx_messages_thread ON messages(account_id, gmail_thread_id);
CREATE INDEX idx_messages_labels ON messages(account_id, is_unread, internal_date DESC);
CREATE INDEX idx_threads_account_date ON threads(account_id, last_message_at DESC);
CREATE INDEX idx_labels_account ON labels(account_id, name);
CREATE INDEX idx_attachments_message ON attachments(account_id, message_id);
CREATE INDEX idx_sync_state_account ON sync_state(account_id);
```

### 10.3 Aturan data

- `account_id` selalu bagian dari unique key karena ID Gmail hanya unik per akun.
- Hapus akun → cascade ke label, thread, message, attachment, draft, outbox, sync_state.
- Body email tidak masuk tabel `messages`; hanya snippet dan header.
- Attachment hanya metadata; file diambil on demand.
- Draft lokal disimpan di `drafts`; setelah sukses sync, `gmail_draft_id` diisi.
- Cache boleh dihapus kapan saja tanpa kehilangan data Gmail.

---

## 11. Sync engine

### 11.1 Sync awal

1. Ambil `users.getProfile` → `emailAddress`, `historyId`, `messagesTotal`.
2. Ambil daftar label via `users.labels.list`.
3. Ambil pesan dengan `users.messages.list`, `q=newer_than:90d -in:chats`, `maxResults=500`, halaman sampai batas 1.000 pesan.
4. Ambil metadata tiap pesan dengan `format=metadata` dan `metadataHeaders=From,To,Cc,Bcc,Subject,Date,Message-ID,In-Reply-To,References`.
5. Tulis message dan thread dalam transaksi per batch 50.
6. Simpan `historyId` yang diambil **sebelum** listing, agar perubahan selama sync awal tidak hilang.
7. Isi `sync_state.last_full_sync_at`.

Sync awal berjalan di background job dengan progress per akun. UI tetap bisa dipakai; inbox menampilkan hasil bertahap.

### 11.2 Sync incremental

- `users.history.list` dengan `startHistoryId`.
- Tangani `messageAdded`, `messageDeleted`, `labelAdded`, `labelRemoved`.
- Ambil ulang metadata pesan yang berubah; hapus pesan yang deleted; update label dan thread.
- Simpan `historyId` baru **setelah** transaksi commit.
- Jika history kadaluarsa (`404`), jalankan full sync ulang untuk akun itu.
- Jika `429`/`403 rateLimitExceeded`, backoff eksponensial (2s, 4s, 8s, maks 60s) dan catat system log.
- Satu akun hanya boleh punya satu sync berjalan. Gunakan lock in-memory + status di DB.

### 11.3 Scheduler

- Interval default 60 detik; setting 30 detik–15 menit.
- Jitter 0–15 detik agar semua akun tidak memukul API bersamaan.
- Sync saat startup, setelah tambah akun, setelah aksi yang mengubah state, dan saat tombol Refresh.
- Akun dengan `status=reauth_required` dilewati sampai reconnect.
- Jika app tidur/restart, sync berikutnya melanjutkan dari `historyId`.
- Concurrency global maksimal 4 request Gmail; per akun maksimal 2.
- Timeout request 30 detik; retry maksimal 2 untuk error jaringan.

### 11.4 Sinkronisasi setelah aksi

- Star/read/archive/trash/label: update cache optimistis, kirim ke Gmail, rollback jika gagal.
- Send: simpan ke `outbox`, kirim, lalu update thread Sent.
- Draft: saat Save ditekan, simpan lokal lalu create/update Gmail draft. Autosave 2 detik masuk P1.
- Jangan menunggu sync berikutnya untuk aksi yang baru dilakukan.

---

## 12. Integrasi Gmail API

### 12.1 Endpoint Google yang dipakai

| Operasi | Endpoint |
|---|---|
| Profil | `GET /gmail/v1/users/me/profile` |
| List pesan | `GET /gmail/v1/users/me/messages` |
| Get pesan | `GET /gmail/v1/users/me/messages/{id}` |
| Thread | `GET /gmail/v1/users/me/threads/{id}` |
| Kirim | `POST /gmail/v1/users/me/messages/send` |
| Draft | `POST/PUT/GET/DELETE /gmail/v1/users/me/drafts` |
| Kirim draft | `POST /gmail/v1/users/me/drafts/send` |
| Modify label | `POST /gmail/v1/users/me/messages/batchModify` |
| Modify thread | `POST /gmail/v1/users/me/threads/{id}/modify` |
| Trash | `POST /gmail/v1/users/me/messages/{id}/trash` |
| Untrash | `POST /gmail/v1/users/me/messages/{id}/untrash` |
| Label | `GET/POST/PATCH/DELETE /gmail/v1/users/me/labels` |
| History | `GET /gmail/v1/users/me/history` |
| Attachment | `GET /gmail/v1/users/me/messages/{id}/attachments/{id}` |

Gunakan `fetch` langsung. Tidak memakai `googleapis` atau SDK berat.

### 12.2 Token

- Refresh via `https://oauth2.googleapis.com/token` dengan `grant_type=refresh_token`.
- Refresh 5 menit sebelum `token_expiry`.
- Simpan token baru dan expiry.
- Retry sekali saat 401; jika tetap gagal, tandai `reauth_required`.
- Jangan refresh paralel untuk akun yang sama; gunakan promise lock.

### 12.3 MIME dan pengiriman

- Bangun MIME manual di `mime.js`.
- Header wajib: `From`, `To`, `Subject`, `Date`, `Message-ID`, `MIME-Version`.
- Reply: isi `In-Reply-To` dan `References`; kirim dengan `threadId`.
- `Subject` di-encode RFC 2047 bila non-ASCII.
- Body plain text di-escape lalu diubah ke `<br>` untuk bagian `text/html`; sertakan juga `text/plain`.
- Attachment: `multipart/mixed`, base64, nama file di-encode dengan benar.
- Total pesan maksimal 25 MB. Tolak sebelum request jika melebihi.
- Sertakan alamat BCC saat membangun MIME agar Gmail mengirimkannya; pastikan penerima To/Cc tidak melihat alamat BCC (uji dengan pengiriman nyata).
- Simpan `Message-ID` yang dibuat agar reply berikutnya konsisten.

### 12.4 Quota dan batas

- Hormati Gmail per-user quota dan daily quota.
- Jangan paralel berlebihan; batch actions memakai `batchModify` per akun.
- Jika satu akun kena limit, akun lain tetap jalan.
- Tampilkan status parsial: "Berhasil 8/10, 2 gagal karena rate limit."
- Maksimal 500 ID per `batchModify`; pecah jika perlu.

### 12.5 Rendering HTML masuk

- Body HTML ditempatkan di `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` tanpa `allow-scripts`.
- CSP iframe: `default-src 'none'; img-src data: <origin-umail>; style-src 'unsafe-inline'; font-src data:`. Inline image memakai signed URL, bukan `cid:`.
- Tidak ada `allow-same-origin`.
- Remote image diblokir sampai user menekan "Show images"; permission hanya untuk thread itu. P1: proxy gambar lewat server agar IP pengguna tidak bocor ke pengirim.
- Link dibuka dengan `rel="noopener noreferrer"`.
- Tidak menjalankan form, script, iframe, object, atau embed.
- Fallback plain text selalu tersedia.

---

## 13. API aplikasi

Semua route `/api/*` memakai session + CSRF, kecuali login/setup dan API v1.

### 13.1 Auth dan setup

| Method | Path | Fungsi |
|---|---|---|
| `GET` | `/api/setup/status` | Cek apakah Master sudah ada |
| `POST` | `/api/setup` | Buat Master pertama |
| `POST` | `/api/users/login` | Login |
| `POST` | `/api/users/logout` | Logout |
| `GET` | `/api/users/me` | User, permission, settings |
| `GET` | `/auth/google` | Mulai OAuth akun Google |
| `GET` | `/auth/callback` | Callback OAuth |

### 13.2 Akun

| Method | Path | Fungsi |
|---|---|---|
| `GET` | `/api/accounts` | List akun + status + unread |
| `PATCH` | `/api/accounts/:id` | Default, warna, sync_enabled |
| `DELETE` | `/api/accounts/:id` | Hapus akun + cache |
| `POST` | `/api/accounts/:id/refresh` | Sync sekarang |
| `POST` | `/api/accounts/:id/reconnect` | Mulai ulang OAuth |

### 13.3 Mail

| Method | Path | Fungsi |
|---|---|---|
| `GET` | `/api/mail` | List cache; query: `mailbox`, `accountId`, `label`, `cursor`, `limit`, `q` |
| `POST` | `/api/mail/backfill` | Ambil halaman lebih lama dari Gmail untuk akun terpilih |
| `GET` | `/api/mail/threads/:accountId/:threadId` | Thread lengkap + body |
| `POST` | `/api/mail/actions` | Bulk action |
| `GET` | `/api/labels` | Label gabungan |
| `GET` | `/api/search` | Search remote fan-out |
| `GET` | `/api/attachments/:accountId/:messageId/:attachmentId` | Download attachment |

Contoh `POST /api/mail/actions`:

```json
{
  "accountId": 1,
  "messageIds": ["18c...", "18c..."],
  "action": "archive"
}
```

`action`: `read`, `unread`, `star`, `unstar`, `archive`, `inbox`, `trash`, `untrash`, `spam`, `not_spam`, `add_label`, `remove_label`.

### 13.4 Compose

| Method | Path | Fungsi |
|---|---|---|
| `POST` | `/api/compose/send` | Kirim email |
| `POST` | `/api/drafts` | Simpan draft |
| `PUT` | `/api/drafts/:id` | Update draft |
| `DELETE` | `/api/drafts/:id` | Hapus draft |
| `POST` | `/api/drafts/:id/send` | Kirim draft |

Payload send:

```json
{
  "accountId": 1,
  "to": ["a@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Halo",
  "body": "Isi email",
  "threadId": null,
  "inReplyTo": null,
  "references": [],
  "attachments": []
}
```

### 13.5 Admin

| Method | Path | Fungsi |
|---|---|---|
| `GET/POST/PATCH/DELETE` | `/api/users` | Manajemen user |
| `GET/PUT` | `/api/settings` | Settings |
| `GET` | `/api/activity` | Activity log |
| `GET` | `/api/logs` | System log |
| `GET/POST/PATCH/DELETE` | `/api/api-keys` | API key |
| `GET` | `/api/export` | Backup DB |
| `POST` | `/api/import` | Restore DB (P1) |

### 13.6 Public API v1

Header: `Authorization: Bearer umail_...`

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/v1/accounts` | `api:accounts:read` |
| `GET` | `/api/v1/messages` | `api:mail:read` |
| `GET` | `/api/v1/threads/:accountId/:threadId` | `api:mail:read` |
| `POST` | `/api/v1/messages/send` | `api:mail:send` |
| `POST` | `/api/v1/messages/actions` | `api:mail:modify` |
| `GET` | `/api/v1/labels` | `api:mail:read` |
| `GET` | `/api/v1/search` | `api:mail:read` |

Rate limit per key, default 60 request/menit. Response error konsisten: `{ "error": { "code": "...", "message": "..." } }`.

---

## 14. Permission aplikasi

Halaman tampil jika user punya minimal satu permission di grupnya. Master memiliki semua permission secara implisit.

```text
mail: mail:view, mail:read, mail:send, mail:draft,
      mail:modify, mail:archive, mail:delete, mail:spam,
      mail:labels, mail:attachments, mail:search

accounts: accounts:view, accounts:view_email, accounts:add,
          accounts:remove, accounts:refresh, accounts:color,
          accounts:set_default

settings: settings:view, settings:edit, settings:database

admin: admin:view_users, admin:manage_users, admin:edit_permissions,
       admin:view_activity, admin:view_logs, admin:manage_api,
       admin:view_api_docs
```

Default Slave saat dibuat: `mail:view`, `mail:read`, `mail:search`, `mail:attachments`. Master dapat menambah permission lain. Tanpa `mail:modify`, membuka thread tidak menandai pesan read di Gmail.

Pemetaan aksi:

| Aksi | Permission |
|---|---|
| Buka inbox/thread | `mail:view` + `mail:read` |
| Star/read/archive/label | `mail:modify` |
| Trash/spam | `mail:delete` / `mail:spam` |
| Kirim | `mail:send` |
| Simpan draft | `mail:draft` |
| Download attachment | `mail:attachments` |
| Tambah/hapus akun | `accounts:add` / `accounts:remove` |
| Settings | `settings:edit` |
| API key | `admin:manage_api` |

---

## 15. Keamanan dan privasi

- Token Google hanya di server; tidak pernah masuk HTML, localStorage, atau response API.
- Session cookie: `httpOnly`, `SameSite=Lax`, `Secure` saat HTTPS.
- CSRF token untuk semua mutasi berbasis cookie.
- Rate limit login per IP dan per username.
- Password PBKDF2-SHA256, salt unik, iterasi tinggi.
- API key disimpan sebagai hash; hanya prefix yang ditampilkan.
- Asset HTML email tidak boleh dieksekusi; iframe sandbox + CSP.
- Remote image diblokir default untuk mencegah tracking pixel.
- Attachment dipaksa download; nama file disanitasi; jangan percaya `Content-Type` pengirim.
- Log tidak boleh memuat token, password, body email, atau nama attachment.
- DB berisi token dan metadata sensitif: file permission `0600`, direktori `data/` gitignored, backup diberi peringatan.
- Rekomendasi deployment: HTTPS reverse proxy, full-disk encryption, akses jaringan terbatas.
- Hapus akun = hapus token + cache; tidak menghapus email di Gmail.
- Scope minimal; jangan minta akses Drive/Calendar.
- Restricted scopes Gmail memerlukan Google OAuth verification untuk publik. Tanpa verifikasi, hanya test user yang bisa connect.
- Tidak ada telemetry keluar.

P1: enkripsi token at-rest dengan kunci dari env, dan enkripsi DB.

---

## 16. Non-functional requirements

| Aspek | Target |
|---|---|
| First paint | < 1,5 detik pada koneksi lokal |
| List cache | < 500 ms server, render < 1 detik untuk 50 baris |
| Buka thread | < 2 detik p95 (Gmail API normal) |
| Kirim email | < 3 detik p95 |
| Sync awal | 500 pesan/akun < 60 detik |
| Sync incremental | < 10 detik untuk < 50 perubahan |
| Skala | 10 akun, 100.000 pesan cache, 10 user |
| DB | SQLite WAL, busy timeout, transaksi batch |
| Memory | Tidak menyimpan semua body di memori |
| Uptime | Gagal satu akun tidak menghentikan akun lain |
| Log retention | 30 hari default |
| Browser | Chrome/Edge/Firefox/Safari versi terbaru |

UI copy berbahasa Inggris seperti UDrive. Struktur siap untuk i18n P2.

---

## 17. Milestone implementasi

| Tahap | Deliverable | Estimasi |
|---|---|---|
| M0 | Scaffold Hono + Vite + Tailwind, DB, config, Docker | 2–3 jam |
| M1 | Setup, login, session, role, permission, layout UDrive | 4–6 jam |
| M2 | OAuth Google, account cards, token refresh, account health | 4–5 jam |
| M3 | Gmail service, MIME metadata, sync awal/incremental, scheduler | 8–10 jam |
| M4 | Unified inbox, mail list, reader thread, HTML sandbox | 8–10 jam |
| M5 | Compose, reply, forward, attachment, draft, outbox | 8–10 jam |
| M6 | Actions, labels, search, bulk, toast/optimistic UI | 5–6 jam |
| M7 | Settings, users, activity/logs, API key + docs | 6–8 jam |
| M8 | Test, responsive, dark mode, Docker, README, polish | 4–6 jam |

Total P0: sekitar 50–65 jam fokus (6–8 hari kerja). P1: tambah 16–24 jam.

Urutan build yang disarankan: M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8. Jangan build UI compose sebelum sync dan reader stabil.

---

## 18. Acceptance criteria MVP

1. Fresh install menampilkan setup; Master dibuat; login berhasil; session bertahan setelah restart server.
2. Dua akun Gmail bisa ditambahkan via OAuth; kartu akun tampil dengan warna, unread, dan last sync.
3. Unified inbox menampilkan email dari kedua akun, terurut tanggal, dengan badge unread yang benar.
4. Membuka thread menampilkan seluruh pesan dan menandai read di Gmail.
5. Reply terkirim ke thread yang sama; penerima melihat `In-Reply-To`/`References` benar.
6. Kirim email baru dengan attachment 5 MB berhasil; muncul di Sent dan diterima penerima.
7. Star, archive, trash, dan apply label dari UMail terlihat di Gmail web.
8. Search `from:` dan `has:attachment` mengembalikan hasil dari semua akun.
9. Hapus akun menghapus token dan cache; email di Gmail tidak terhapus.
10. Slave tanpa `mail:send` tidak bisa mengirim; API menolak dengan 403.
11. Dark mode, mobile 375 px, dan keyboard dasar berfungsi.
12. Docker restart mempertahankan akun, session, dan cache.
13. API key dengan `api:mail:send` bisa mengirim email; key tanpa permission ditolak.
14. HTML email berisi `<script>` tidak mengeksekusi script; gambar remote tidak termuat sebelum diizinkan.
15. Error token/quota menampilkan pesan yang jelas dan tidak membuat aplikasi crash.

---

## 19. Risiko dan mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Google OAuth verification | App publik tidak bisa connect | Dokumentasikan mode Testing; siapkan privacy policy + demo video untuk verifikasi |
| Gmail quota/rate limit | Sync/send gagal | Backoff, concurrency limit, batch, status parsial |
| Token dicabut | Akun berhenti sync | Status `reauth_required`, tombol reconnect, banner |
| MIME/threading salah | Balasan tidak menyatu | Test unit MIME + uji kirim nyata ke Gmail |
| HTML email berbahaya | XSS/tracking | Iframe sandbox, CSP, blokir gambar remote |
| Cache membengkak | DB lambat | Batas window, index, vacuum, hapus cache |
| SQLite lock | Request gagal | WAL, busy timeout, transaksi pendek |
| Refresh token disimpan plaintext | Kebocoran jika DB bocor | Permission 0600, full-disk encryption, enkripsi P1 |
| Perbedaan label antar akun | Aksi salah akun | Semua query wajib `account_id`; label mapping per akun |
| Body email besar | UI lambat | Truncate + "View entire message" |

---

## 20. Setup pengguna

### 20.1 Prasyarat

- Node.js 20+.
- Google Cloud project.
- Gmail API enabled.
- OAuth consent screen dikonfigurasi.
- OAuth Client ID tipe Web application.
- Redirect URI: `http://localhost:3000/auth/callback` dan URL produksi.

### 20.2 Langkah

```bash
cd /home/gegeembrie/Documents/NodeJS/umail
npm install
cp .env.example .env
# isi GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET
npm run dev
```

Buka `http://localhost:5173`, buat Master, lalu Add Account.

Produksi:

```bash
npm run build
npm start
```

Docker:

```bash
docker compose up -d
```

### 20.3 First run

1. Buat Master.
2. Hubungkan akun Gmail pertama.
3. Jadikan default.
4. Tunggu sync awal.
5. Buka unified inbox.
6. Atur sync interval dan theme.

---

## 21. Definition of done

- Semua acceptance criteria P0 lulus.
- `npm run build` sukses tanpa error.
- Server production menyajikan `dist/` dan API.
- Docker build + volume DB berfungsi.
- Dark/light/auto, desktop/mobile.
- Tidak ada token/password di client bundle, localStorage, atau log.
- Minimal test: MIME builder, parsing history, permission check, HTML escaping.
- README berisi setup Google Cloud, env, dev, build, Docker, dan batasan Gmail API.
- Tidak ada dependency baru yang tidak perlu; gunakan stdlib/native bila cukup.
- Aksi destruktif selalu konfirmasi.
- Error Gmail selalu punya pesan yang bisa ditindaklanjuti.

---

## 22. Keputusan yang masih terbuka

Default sudah dipilih agar implementasi tidak tertahan. Perubahan yang mungkin diminta setelah review:

1. Rich text composer di P0, bukan P1.
2. Push notification via Pub/Sub di P0 (butuh HTTPS publik + topik Google Cloud).
3. Permanent delete di P0.
4. Dukungan alias `sendAs` di P0 (butuh scope `gmail.settings.basic`).
5. UI copy bahasa Indonesia, bukan Inggris.

Jika tidak ada perubahan, implementasi mengikuti default di bagian 5.
