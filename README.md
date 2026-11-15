# UMail

Unified Gmail manager. Satu inbox, satu pencarian, satu composer untuk banyak akun Google.

Status: P0 selesai (M0–M8) dan P1 selesai. Auth/permission, OAuth Google, sync, unified inbox, reader, compose/draft/outbox, search, label, bulk action, settings, activity/log, API key + REST API v1, Docker. P1 sudah ada: label CRUD, signed attachment URL, proxy gambar, autosave draft, signature per akun, default reply behavior, rich text composer, gesture swipe mobile, export/import database, keyboard shortcuts, notifikasi browser, enkripsi token OAuth at-rest. P2 sebagian: scheduled send, undo send, AI summary, AI compose assist, dan AI chat read-only.

## Jalankan

Butuh [Bun](https://bun.sh) 1.4+.

```bash
bun install
cp .env.example .env
bun run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3000`
- Produksi: `bun run build && bun start`
- Test: `bun test`

Saat pertama dibuka, UMail meminta pembuatan akun Master.

## Docker

Image dibangun otomatis oleh GitHub Actions dan dipublikasikan ke `ghcr.io/gegedevs/umail` (tag `latest`, `sha-…`, dan versi `v*`).

```bash
cp .env.example .env   # isi GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL, TOKEN_ENCRYPTION_KEY
docker compose pull
docker compose up -d
```

- Buka `http://localhost:3000`.
- Database tersimpan di volume `umail-db` (`/app/data`), bukan di image.
- Build lokal: `docker compose up -d --build`.
- `.env` dibaca oleh container; jangan commit file itu.

## Install sebagai aplikasi (PWA)

UMail punya `manifest.webmanifest` + service worker, jadi bisa dipasang seperti aplikasi Chrome.

- **Desktop Chrome/Edge:** buka UMail, klik ikon install di address bar (atau menu ⋮ → *Install UMail*).
- **Android Chrome:** menu ⋮ → *Add to Home screen* / *Install app*.
- **iOS Safari:** Share → *Add to Home Screen*.

Butuh HTTPS (atau `localhost`). Aplikasi berjalan standalone tanpa address bar. Service worker hanya meng-cache shell UI; data email tetap dari server dan endpoint `/api/` tidak di-cache.

## Google OAuth

1. Buka Google Cloud Console, buat project, aktifkan **Gmail API**.
2. Buat **OAuth client ID** tipe *Web application*.
3. Tambahkan authorized redirect URI persis seperti yang ditampilkan di halaman Accounts, contoh:
   - `http://localhost:3000/auth/callback`
   - `https://mail.example.com/auth/callback` untuk produksi.
4. Isi `.env`:

```bash
PORT=3000
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# Opsional, wajib di belakang reverse proxy:
PUBLIC_URL=https://mail.example.com
```

5. Restart UMail, lalu **Accounts → Add Account**.

Catatan:
- Scope `gmail.modify` dan `gmail.send` adalah restricted. Untuk pemakaian publik perlu verifikasi Google; untuk self-hosted pribadi cukup consent screen mode **Testing** dengan test user terdaftar.
- Token disimpan di SQLite via `bun:sqlite`; password Google tidak pernah disimpan. Set `TOKEN_ENCRYPTION_KEY` untuk enkripsi token at-rest (AES-256-GCM). Token plaintext lama dienkripsi otomatis saat startup. Key harus sama setelah restore backup, jika tidak token tidak bisa dibaca dan akun perlu reconnect.
- Hapus akun akan mencabut token Google (best-effort) dan menghapus cache lokal.
- Status `reauth_required` berarti refresh token dicabut/kedaluwarsa. Tekan **Reconnect** pada kartu akun.
- Sync awal mengambil 90 hari terakhir (maks 1.000 pesan). Sync berikutnya memakai `historyId`; scheduler jalan tiap 30–900 detik sesuai setting `sync_interval`.

## Keyboard

`/` fokus search, `c` compose, `j`/`k` pindah baris, `Enter` buka thread, `Esc` tutup composer/modal/reader, `Delete` hapus pesan terpilih.

## AI summary

Buka **Settings → AI summary**. Isi:

- **Base URL** — endpoint OpenAI-compatible, misalnya `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, atau Ollama `http://localhost:11434/v1`.
- **Model** — misalnya `gpt-4o-mini`.
- **API key** — disimpan di DB, terenkripsi bila `TOKEN_ENCRYPTION_KEY` diisi. Kosongkan saat menyimpan untuk mempertahankan key lama.

Isi thread dikirim ke provider tersebut saat tombol **Summarize with AI** diklik; browser meminta konfirmasi sekali per browser. Ringkasan tidak disimpan di DB.

Di composer, menu **AI assist** menyediakan **Rewrite**, **Shorten**, **Formal**, dan **Translate**. Hanya isi pesan yang dikirim; signature tidak diubah dan tidak ikut dikirim.

Ikon forum di topbar membuka **Ask your mail**. Model bisa mencari email, membaca thread, mendaftar akun, dan mengelola thread (arsip, trash, spam, inbox, read/unread, star, important, label, snooze) lewat allowlist tool di server. Aksi berisiko (archive, trash, spam, snooze) berhenti sebagai `pendingAction` dan menunggu pilihan **Deny / Allow / Always allow**; **Always allow** menyimpan aturan per user dan bisa dicabut di **Settings → AI chat permissions**. Model tidak bisa mengirim email. Jawaban menyertakan link ke thread sumber. Isi email diperlakukan sebagai data, bukan instruksi; hanya pesan user yang boleh meminta aksi. Maksimal 4 langkah tool per pertanyaan dan maksimal 8 pesan riwayat. Riwayat chat disimpan per user di `ai_chat_sessions` + `ai_chat_messages` (maksimal 15 sesi, 60 pesan per sesi). Pesan ditambahkan (append-only) dengan `clientId` unik, jadi dua perangkat tidak saling menimpa. Isi pesan dan sumber dienkripsi at-rest bila `TOKEN_ENCRYPTION_KEY` diisi. Sesi yang dihapus memakai tombstone: perangkat lain tidak bisa menghidupkannya lagi. Browser menyimpan cache; sesi lama di localStorage diunggah sekali saat pertama memakai versi ini. Tombol riwayat untuk pindah sesi dan tombol chat baru untuk mulai dari kosong. Pencarian chat menanyakan Gmail secara live lebih dulu; kalau Gmail tidak bisa dihubungi, baru memakai cache lokal (kata kunci dicocokkan OR dan diurutkan dari jumlah kata yang cocok, jadi "daftar email BNSP" tetap menemukan email BNSP). Link sumber membuka thread langsung di reader. Daftar sumber dari jawaban sebelumnya ikut dikirim ke model, sehingga lanjutan seperti "Apa isi email nomor 1?" dibaca langsung dari thread yang benar. Model juga menerima tanggal hari ini menurut setting timezone, jadi pertanyaan seperti "email baru hari ini" dibandingkan dengan tanggal yang benar.

## API

Buat API key di `#/api-access` (butuh permission `admin:manage_api`). Key hanya ditampilkan sekali.

```bash
curl -s http://localhost:3000/api/v1/messages?box=inbox \
  -H "Authorization: Bearer $UMAIL_KEY"
```

Endpoint: `/api/v1/accounts`, `/messages`, `/threads/:accountId/:threadId`, `/labels`, `/search?q=`, `/messages/actions`, `/messages/send`. Tiap key punya permission sendiri, rate limit per menit, dan expiry opsional. Dokumentasi lengkap di `API-DOCUMENTATION.md` dan `#/api-docs`.

## Struktur

```text
src/      Hono di Bun, bun:sqlite, auth, OAuth, service
client/   SPA Vanilla JS + Tailwind
data/     umail.db (gitignored)
PRD.md    spesifikasi produk
```

## Roadmap

- M0 scaffold, DB, build, Docker
- M1 setup/login/session/permission/layout
- M2 Google OAuth + account cards + token refresh + health check
- M3 Gmail sync engine + scheduler
- M4 inbox + thread reader
- M5 compose/send/draft/attachment
- M6 actions/search/labels
- M7 settings/log/API
- M8 test/polish
- P2 (sebagian): scheduled send, undo send, AI summary, AI compose assist, aksi kontekstual + undo, mark important, snooze, template, autocomplete penerima, AI chat dengan konfirmasi aksi. Belum: Pub/Sub push, sendAs alias, Gmail filters/vacation, import mbox, shared mailbox, permanent delete.
