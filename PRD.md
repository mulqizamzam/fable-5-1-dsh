# PRD: fable-5-1-dsh

Dokumen ini menggantikan `PRD.md` v0.1.0-draft. Versi lama adalah spesifikasi
sebelum kode ditulis; isinya sudah tidak cocok dengan repo (misalnya klaim
"100 spec diimplementasikan" dan nama tool `fable51.*`). Teks lama tetap bisa
dibaca di riwayat git (commit `1d17745`) dan versi revisinya ada di
`PRD_REVISI.md`.

Dokumen ini disusun dari kode yang ada di commit `3b701d6`, bukan dari niat
awal. Setiap angka di bawah punya perintah atau berkas sumber.

| Item | Nilai |
|---|---|
| Status | as-built, revisi 1 |
| Tanggal verifikasi | 2026-10-20 |
| Versi paket | `0.1.1` (`package.json`) |
| Commit acuan | `3b701d6` (working tree bersih) |
| Target host | dsh developer preview `0.2.0-rc.2`, commit `23c78fcdd5ee0b497a77ca356608c51093c74bb9` |
| Runtime | Cordis, TypeScript, ESM |
| Lisensi | MIT |
| Artefak yang dijalankan host | `lib/` (gitignored, hasil `pnpm build` di mesin lokal) |

## 1. Ringkasan produk

Satu bundle dsh yang membawa disiplin reasoning Fable 5.1 ke dalam agent loop.
Bentuknya satu service (`ctx.fable51`), empat hook event, dan 90 tool
berprefiks `fable51_`.

Dari 100 spec di `sumber100specs.md`:

| Kelas | Jumlah | Bentuk |
|---|---|---|
| Punya tool sendiri | 90 | tool `fable51_<nama>` |
| Hidup sebagai method service yang dipicu hook | 8 | spec 6, 10, 15, 18, 43, 58, 96, 100 |
| Tidak diimplementasikan | 2 | spec 4 `progress-reporting`, spec 55 `reasoning-bandwidth` |

Angka 90 berasal dari enumerasi `allToolSpecs()` di `src/tools/index.ts`.
Sebaran per kelompok:

| Kelompok | Jumlah |
|---|---|
| `context` | 6 |
| `verification` | 9 |
| `dag` | 4 |
| `cost` | 4 |
| `escalation` | 7 |
| `ops` | 7 |
| `reasoning-core` | 13 |
| `reasoning-flow` | 16 |
| `reasoning-ops` | 17 |
| `governance` | 7 |
| Total | 90 |

Nama tool memakai garis bawah, bukan titik. Alasannya ada di
`src/tools/shared.ts`: provider yang kompatibel dengan OpenAI menolak nama tool
di luar pola `^[a-zA-Z0-9_-]+$`, sehingga namespace `fable51.` berubah menjadi
`fable51_` di commit `1255017`. README masih menulis `fable51.*` dan perlu
dikoreksi.

## 2. Masalah yang diselesaikan

Agent loop jangka panjang punya tiga titik gagal yang tidak tertutup oleh
disiplin model saja.

1. **Klaim tanpa bukti.** Model bisa menulis "sudah diverifikasi" tanpa
   artefak, perintah, atau output. Tidak ada tempat yang mencatat klaim itu
   dengan bukti yang bisa diperiksa ulang.
2. **Struktur reasoning tidak terlihat.** Fork, merge, retry, replan, dan
   eskalasi berjalan tanpa ledger. Setelah sesi selesai, tidak ada cara
   mengetahui berapa pass yang dibuat, mana yang dibuang, dan berapa biayanya.
3. **Konfigurasi plugin gagal diam.** Typo satu key membuat plugin berjalan
   dengan nilai lain tanpa error. Operator mengira pengaman aktif padahal tidak.

Bundle ini menutup ketiganya dengan service yang menyimpan ledger, envelope
hasil yang membawa status verifikasi, dan config yang menolak key asing dengan
menyebut field path.

## 3. Pengguna dan jalur pemakaian

| Pengguna | Kebutuhan | Jalur |
|---|---|---|
| Operator dsh | Memasang bundle dan membuktikan aktivasi | `package.json` profile + `cordis.patch.yml` |
| Agent/model | Memanggil pengecekan spesifik | tool `fable51_*` |
| Agent/model (jalur ringan) | Memakai urutan kerja tanpa hafal nama tool | skill `fable-5-1-discipline` |
| Maintainer | Membuktikan perilaku sebelum rilis | `pnpm test`, `pnpm typecheck` |

Jalur ringan memakai skill `fable-5-1-discipline` (stage map, fork,
verifikasi, merge). Jalur manual memanggil tool langsung; daftar tool yang
paling sering dipakai ada di `PLAYBOOK.md`.

## 4. Lingkup

**Termasuk:**

- Satu policy service yang menyimpan registry, lineage, cache, snapshot,
  gate log, worklog, dan cost ledger.
- Empat hook event: `agent/pre-step`, `tools/result`, `llm/stream`,
  `session/event` (ditambah `session/created` dan `session/disposed`).
- 90 tool dengan envelope hasil seragam.
- Config sembilan blok dengan validasi fail-loud.
- Suite unit, integration, dan e2e yang memuat bundle ke host Cordis nyata.

**Tidak termasuk:**

- Sandbox tingkat OS. `sandbox-boundaries` adalah pencocokan path terhadap
  allow-list, bukan pembatas filesystem.
- Penegakan approval otomatis. `human-in-the-loop` hanya menjawab bila model
  memanggil tool itu.
- Isolasi state per session. State dibagi satu host (lihat §13).
- Perubahan parameter model. Eskalasi effort hanya mengubah nilai buku di
  service dan mencatatnya.
- Antarmuka pengguna, dashboard, atau penyimpanan lintas proses.

Kalau operator butuh pembatasan yang mengikat, yang berlaku adalah permission
dsh sendiri, bukan bundle ini.

## 5. Arsitektur surface

```
dsh host
├── ctx.fable51 (Fable51Policy)
│   ├── config        hasil validateConfig, fail-loud
│   ├── registry      PolicyRegistry, versi beku
│   ├── lineage       PassLineage, append-only + prune
│   ├── cache         ReasonCache, content-addressed
│   ├── snapshots     SnapshotStore, checkpoint + hash
│   ├── gateLog       cincin 5000
│   ├── worklog       cincin 5000
│   └── costLedger    cincin 5000 + total per stage
├── hooks
│   ├── agent/pre-step      waterfall, observasional
│   ├── tools/result        emit, mencatat bukti dan biaya
│   ├── llm/stream          waterfall generator, penghitung token
│   └── session/*           lifecycle + durable event
└── tools fable51_*         90 tool, 10 kelompok
```

Registrasi terjadi di konstruktor service (`src/policy-service.ts`), bukan di
`apply`. Service mendeklarasikan `inject: ['tools', 'llm', 'sessions']`. Bila
salah satu belum siap, plugin menunggu dan tidak berjalan, sesuai perilaku dsh.
Karena itu aktivasi harus dibuktikan lewat baris log yang memuat
`fable-5-1 loaded` beserta jumlah tool terdaftar, dan lewat keberadaan tool di
`ctx.tools.schemas()`.

## 6. Persyaratan fungsional

Setiap persyaratan punya kriteria terima dan status pada commit acuan.

### FR-01 Aktivasi terbukti

Bundle harus mendaftarkan service, hook, dan tool saat dimuat, dan menulis satu
baris log yang menyebut jumlah tool. Aktivasi tidak boleh diasumsikan dari
"plugin terpasang".

- Terima: log muncul, jumlah tool sama dengan hasil enumerasi, tidak ada state
  menunggu.
- Status: terpenuhi di suite integration/e2e. Boot profile dsh nyata belum
  dijalankan ulang pada sesi ini.

### FR-02 Permukaan tool lengkap

90 tool harus terdaftar dengan nama `fable51_<nama>`, satu tool per spec yang
dikelompokkan, dan tidak ada nama dobel.

- Terima: `allToolSpecs()` mengembalikan 90 nama unik dengan prefiks benar.
- Status: terpenuhi. Diverifikasi dengan enumerasi dan
  `test/unit/tool-name-pattern.spec.ts`.

### FR-03 Envelope hasil seragam

Setiap tool harus mengembalikan objek dengan tujuh field: `ok`, `spec`,
`output`, `verdict`, `unverified`, `rerun`, `gates`. Argumen yang salah harus
menjadi `ok:false`, bukan exception yang lolos ke host.

- Terima: semua tool mengembalikan bentuk itu; kasus argumen buruk diuji.
- Status: terpenuhi (`src/tools/shared.ts`, suite unit).

### FR-04 Idempotency dan tool effectful

Tool murni harus memakai cache content-addressed dengan kunci
`hash(argumen) + spec + fingerprint(config)`. Tool yang mengubah state service
harus selalu eksekusi ulang dan tidak pernah membaca cache.

- Terima: panggilan kedua dengan input sama mengembalikan `rerun:true`; 26 tool
  effectful selalu eksekusi ulang.
- Status: terpenuhi. Enumerasi mencatat 26 tool effectful, 64 tool murni.

### FR-05 Verdict tidak boleh mengarang

`verdict` hanya boleh turun ke `unverified`. Tool yang melaporkan
`pass:false`, `missing[]`, atau `unverified[]` tidak boleh kembali sebagai
`verified`.

- Terima: setiap jalur penurunan verdict punya test.
- Status: terpenuhi (`judge()` di `src/tools/shared.ts`, suite verifikasi).

### FR-06 Config fail-loud

Config harus divalidasi saat load. Key asing, tipe salah, nilai di luar batas,
atau threshold context yang tidak urut harus melempar `ConfigError` yang
menyebut field path persis. Config parsial di-deep-merge di atas default
lengkap. `config:` yang ada tetapi bukan object harus ditolak, bukan dianggap
kosong.

- Terima: setiap aturan punya test; pesan error memuat path.
- Status: terpenuhi (`src/config/schema.ts`, `test/unit/config.spec.ts`).

### FR-07 Hook `agent/pre-step`

Hook harus mencatat satu baris observability per step, mengklasifikasi rasio
context (ok, compact, drop, spill), dan menaikkan effort tier satu kali per
task saat pesan memuat sinyal `search`, `multihop`, atau `ambiguity`. Hook
tidak boleh menolak step. Fault di dalam hook dicatat lalu step tetap
diizinkan lewat `next()`.

- Terima: event dispatch nyata di suite e2e; fault tidak menghentikan step.
- Status: terpenuhi. Klasifikasi context hanya mencatat; tidak memotong atau
  memindahkan message list.

### FR-08 Hook `tools/result`

Hook harus mencatat hasil tool ke worklog, menandai bukti baru untuk
perhitungan konvergensi, dan membukukan biaya kasar per panggilan. Hook tidak
boleh mengubah hasil tool.

- Terima: hasil tool tercatat; `isError` membuat baris worklog masuk sebagai
  `neutral` dengan daftar `unverified` terisi.
- Status: terpenuhi.

### FR-09 Hook `llm/stream`

Hook harus menghitung token per stream, memberi alert pada 80 persen budget dan
sinyal stop pada 100 persen, mem-fingerprint chunk untuk deteksi duplikat
(stream tetap diteruskan), melabeli reasoning antar tool call sebagai
`interleaved`, dan mencatat jarak konvergensi per turn.

- Terima: stream tidak berubah; angka budget dan convergence tercatat.
- Status: terpenuhi di level hook. Jalur streaming LLM penuh belum pernah
  dieksekusi end-to-end (lihat §13).

### FR-10 Hook lifecycle session

`session/created` harus mereset state episode (rung, replan, fork/merge,
effort, label pass, jendela konvergensi). `turn/start` harus mereset budget
token stage dan counter fork/merge. `turn/end` harus membuat snapshot.
`session/disposed` harus menyimpan handoff dan menulis baris postmortem.

- Terima: reset teramati; snapshot dan handoff punya id unik.
- Status: terpenuhi (`src/hooks/session-event.ts`).

### FR-11 State terbatas

Semua ledger harus punya batas dan membuang entri tertua lebih dulu. Total
biaya per stage tidak boleh ikut turun saat cincin ledger membuang entri lama.

- Terima: cap ditegakkan; `stageCost` tetap akumulatif.
- Status: terpenuhi (`pushCapped`, `recordCost` di `src/policy-service.ts`).

### FR-12 Determinisme

Seed, urutan iterasi, dan versi pin harus berasal dari config. Fingerprint
konten harus stabil untuk input yang sama sehingga replay menghasilkan hash
yang sama.

- Terima: tool `determinism` mengembalikan urutan sesuai mode; replay
  membandingkan hash.
- Status: terpenuhi di level unit. Replay lintas proses belum diuji.

### FR-13 Kebersihan encoding

Semua berkas teks: LF, UTF-8 tanpa BOM, newline di akhir berkas.

- Terima: skrip pemeriksaan melaporkan nol pelanggaran.
- Status: sebagian. Pada 79 berkas yang diperiksa, dua berkas tidak berakhir
  newline: `PLAYBOOK.md` dan `test/unit/audit-defects.spec.ts`.

### FR-14 Paket bisa dipasang

`package.json` harus memuat `dsh.bundle.patch`, menaruh paket dsh di
`peerDependencies`, dan menyertakan `lib/`, `cordis.patch.yml`, README, serta
LICENSE di daftar `files`.

- Terima: `dsh --profile <p> --dump-config` menampilkan entry `fable-5-1`.
- Status: manifest terpenuhi. Komposisi profile belum dijalankan ulang pada
  sesi ini.

## 7. Cakupan 100 spec

### 7.1 Yang benar-benar menahan

Hanya tiga hal di bundle ini yang bisa menghentikan sesuatu.

| Mekanisme | Perilaku |
|---|---|
| `sandbox-boundaries` (26) | Escape dicatat dengan verdict `discarded`. Bila `escapeAction: 'abort'`, tool melempar sehingga envelope menjadi `ok:false`, bukan hasil yang terlihat sah. Allow-list kosong berarti read diizinkan dan write ditolak. Allow-list yang dideklarasikan dicocokkan persis. |
| `human-in-the-loop` (27) | Fail-closed. `irreversible`, `external`, atau `estimatedCost` yang tidak dikirim tetap meminta approval. Tetap hanya berjalan bila model memanggil tool. |
| Isolasi fault hook | Error di `agent/pre-step` atau `llm/stream` dicatat, lalu step atau stream lanjut. Plugin tidak bisa membatalkan turn. |

### 7.2 Yang mengklasifikasi dan melapor

| Spec | Konsekuensi |
|---|---|
| `context-management` (1) | Aksi compact, drop, spill diklasifikasi dan dicatat. Tidak ada message list yang dipotong. |
| `effort-escalation` (6) | `effortTier` naik dan dicatat. Parameter model tidak berubah. |
| `reasoning-backpressure` (71) | Dilaporkan dari queue depth yang dikirim pemanggil. |
| `idempotency` (19) | Cache hanya untuk tool murni. |
| `research-provenance` (7) | Tag `[fetch:url]`, `[mem:era]`, `[inf]` ditempel pada string; tidak diverifikasi. |

### 7.3 Delapan spec yang hidup di service atau hook

| Spec | Nama | Mekanisme |
|---|---|---|
| 6 | effort-escalation | `escalateEffort()` dipanggil hook pre-step, sekali per task |
| 10 | session-handoff | `handoffSnapshot()` dipanggil saat session disposed |
| 15 | parallel-vs-sequential | `labelPass()` dari hook stream, nilai `interleaved` |
| 18 | rollback-protocol | `lastVerifiedSnapshot()` sebagai target rollback |
| 43 | reasoning-cache | cache dipakai `defineTool` untuk semua tool murni |
| 58 | convergence-criteria | `converged()` dari jarak per turn dan bukti baru |
| 96 | fork-merge-budget | `canFork()`, `canMerge()`, `recordFork()`, `recordMerge()` |
| 100 | policy-registry | `PolicyRegistry`, perubahan berarti versi baru |

### 7.4 Dua spec yang tidak ada

| Spec | Nama | Akibat |
|---|---|---|
| 4 | progress-reporting | Tidak ada format update progres. Narasi progres tetap tanggung jawab model. |
| 55 | reasoning-bandwidth | `maxConcurrentPasses` ada di config dan divalidasi, tetapi tidak ada yang membatasi pass paralel. |

Kedua spec ini tidak boleh dihitung sebagai fitur yang aktif. Kalau operator
butuh, keduanya harus dibuat dan ditambahkan ke tabel 7.3 atau 7.1.

## 8. Referensi config

Config opsional. Cukup tulis blok yang ingin diubah; `resolveConfig()`
menggabungkan config parsial di atas default lengkap, lalu memvalidasi.

| Blok | Key dan default |
|---|---|
| `context` | `compactAt 0.70`, `dropAt 0.85`, `spillAt 0.90`, `spillPath .dsh/fable-spill` |
| `effort` | `defaultTier mid`, `escalateOn [search, multihop, ambiguity]`, `costCeiling 2000000` |
| `budget` | `maxReplans 2`, `maxPassRetries 2`, `passTimeoutMs 120000`, `stageTimeoutMs 600000`, `stageTokenBudget 400000`, `maxForkDepth 4`, `maxForksPerStage 8`, `maxMergesPerStage 8` |
| `reasoning` | `maxConcurrentPasses 4`, `convergenceDelta 0.02`, `convergenceTurns 3`, `decayLambda 0.15`, `quorumThreshold 0.6` |
| `determinism` | `seed 20261011`, `iterationOrder stable`, `pinnedVersions { dsh: 23c78fcd... }` |
| `sandbox` | `allowList {}`, `escapeAction abort` |
| `hitl` | `requireOnIrreversible true`, `requireOnExternal true`, `requireAboveCost 500000` |
| `observability` | `traceLevel stage`, `logFormat line` |
| `registry` | `policies []` |

Aturan validasi yang paling sering menabrak operator:

- `compactAt < dropAt < spillAt`, masing-masing 0.1 sampai 0.99.
- Counter budget wajib integer. `maxReplans: 0.5` ditolak, bukan dibulatkan.
- `maxReplans` dan `maxPassRetries` dibatasi 0 sampai 10.
- `maxForkDepth` dibatasi 1 sampai 100; `maxForksPerStage` dan
  `maxMergesPerStage` dibatasi 1 sampai 1000.
- Key asing di level mana pun ditolak dengan pesan yang menyebut path.

## 9. Kontrak hasil tool

Semua tool mengembalikan bentuk yang sama.

```json
{
  "ok": true,
  "spec": "5",
  "output": { "check": "...", "pass": true },
  "verdict": "verified",
  "unverified": [],
  "rerun": false,
  "gates": []
}
```

| Field | Arti |
|---|---|
| `ok` | `false` hanya untuk argumen ditolak atau kegagalan tool. Tidak ada throw ke host. |
| `spec` | id spec yang ditangani tool. |
| `output` | isi spesifik tool, punya schema sendiri. |
| `verdict` | `verified` atau `unverified`. Hanya bisa turun. |
| `unverified` | daftar hal yang belum dibuktikan. Wajib dibaca, bukan diabaikan. |
| `rerun` | `true` bila hasil diambil dari cache, bukan dieksekusi ulang. |
| `gates` | gate yang dideklarasikan tool; dieksekusi tool verifikasi, tidak inline. |

Registry host memvalidasi nilai balik terhadap schema envelope. Registry tidak
memvalidasi argumen input; schema argumen yang salah baru terlihat saat tool
dipanggil.

## 10. State dan batas memori

| State | Kapasitas | Perilaku saat penuh |
|---|---|---|
| `worklog` | 5000 | buang entri tertua |
| `gateLog` | 5000 | buang entri tertua |
| `costLedger` | 5000 | buang entri tertua; total per stage tetap |
| `cache` | 2000 | FIFO |
| `snapshots` | 256 | FIFO |
| `turnDistances` | 64 atau `convergenceTurns`, mana yang lebih besar | buang tertua |

Semua state hidup di satu instance `ctx.fable51` per host. Lihat §13 untuk
konsekuensinya.

## 11. Persyaratan non-fungsional

| ID | Persyaratan | Bukti |
|---|---|---|
| NFR-01 | Tidak ada `dependencies` pada paket inti dsh yang stateful; hanya `peerDependencies` | `package.json` |
| NFR-02 | Semua tool mengembalikan nilai bertipe; tidak ada `void` | `defineTool` |
| NFR-03 | Fault hook tidak boleh membatalkan turn | guard di keempat hook |
| NFR-04 | Semua ledger terbatas | tabel §10 |
| NFR-05 | Build dan test berjalan di Node sesuai `engines` | `pnpm test`, `pnpm typecheck` |
| NFR-06 | Lisensi MIT dan encoding LF/UTF-8 | `LICENSE`, `.editorconfig`, §12 |

## 12. Kriteria penerimaan dan bukti

Diukur pada 2026-10-20 terhadap commit `3b701d6` (working tree bersih saat
pengukuran).

| Kriteria | Perintah | Hasil | Status |
|---|---|---|---|
| Tool terdaftar lengkap | enumerasi `allToolSpecs()` | 90 nama unik | lulus |
| Suite test | `pnpm test` | 227 test, 89 suite, 227 lulus, 0 gagal | lulus |
| Typecheck | `pnpm typecheck` | exit 0 | lulus |
| Config fail-loud | `test/unit/config.spec.ts` | lulus | lulus |
| Envelope dan verdict | suite unit | lulus | lulus |
| Hook menyala | suite unit, integration, e2e yang memanggil dispatcher Cordis | lulus | lulus |
| Encoding | pemeriksaan 79 berkas | 2 pelanggaran | sebagian |
| Boot profile dsh | `dsh --profile <p> --dump-config` | tidak dijalankan ulang | belum |

Suite test terdiri dari 15 berkas unit, 1 integration, dan 1 e2e.

## 13. Batas, risiko, dan salah pakai

1. **State per host, bukan per session.** Worklog, ledger, cache, snapshot,
   lineage, dan counter skalar dipakai bersama oleh semua session di host.
   `turn/start` dari satu session membersihkan budget token yang masih dipakai
   session lain. Isolasi butuh identitas session dialirkan ke `ToolRunContext`;
   itu belum dikerjakan.
2. **Bukan sandbox dan bukan approval mechanism.** Jangan jadikan
   `sandbox-boundaries` atau `human-in-the-loop` sebagai satu-satunya kontrol.
   Keduanya hanya berjalan bila model memanggil tool, dan yang pertama hanya
   membandingkan string path.
3. **Jalur LLM streaming penuh belum dijalankan end-to-end.** API key profile
   scratch tidak valid saat penulisan awal. Semantik hook ditutup oleh suite e2e
   yang memanggil dispatcher asli, bukan oleh satu sesi model nyata.
4. **Tidak ada CI dan tidak ada lockfile.** Artefak yang dijalankan host adalah
   hasil build lokal. `lib/` tidak masuk git.
5. **Registry tidak memvalidasi argumen input.** Kesalahan schema terdeteksi
   saat return, bukan saat registrasi.
6. **Dua spec tidak ada.** Spec 4 dan 55 tidak boleh diklaim aktif.
7. **Drift dokumentasi.** README masih menulis namespace `fable51.*`; kode
   memakai `fable51_`. README juga menyebut 10 spec lain hidup sebagai method
   service, padahal hanya 8 yang punya implementasi dan 2 tidak ada.
8. **Dua berkas belum memenuhi aturan encoding.** Lihat FR-13.

## 14. Pertanyaan terbuka

| # | Pertanyaan | Dampak bila tidak dijawab |
|---|---|---|
| 1 | Apakah state harus diisolasi per session, dan siapa yang menyediakan identitas session? | Angka ledger salah saat dua session berjalan paralel |
| 2 | Apakah spec 4 dan 55 akan diimplementasikan atau dicabut dari klaim 100 spec? | Klaim cakupan terus menyesatkan |
| 3 | Apakah validasi argumen tool dipindah ke waktu registrasi? | Schema rusak baru ketahuan saat dipanggil |
| 4 | Apakah `lib/` akan dipublikasikan atau build dilakukan saat instalasi? | Tidak ada jaminan artefak yang dijalankan sama dengan sumber |
| 5 | Apakah dua pelanggaran encoding diperbaiki di commit terpisah? | Gate encoding tidak bisa dipakai sebagai syarat rilis |

## 15. Peta dokumen

| Berkas | Peran |
|---|---|
| `PRD.md` | Dokumen ini: kondisi as-built, persyaratan, bukti |
| `PRD_REVISI.md` | Spesifikasi pra-kode versi 0.1.1; sumber pemetaan 100 spec |
| `sumber100specs.md` | Inventaris 100 spec (id, aturan inti, trigger) |
| `RECON.md` | Bukti file dan baris untuk setiap surface dsh yang dipakai |
| `PLAYBOOK.md` | Panduan operator: pasang, config, peta tool, batas |
| `README.md` | Ringkasan paket untuk konsumen baru |

## 16. Riwayat revisi

| Revisi | Tanggal | Isi |
|---|---|---|
| 1 | 2026-10-20 | Ditulis ulang sebagai PRD as-built dari commit `3b701d6`: angka terverifikasi, pembagian cakupan 90/8/2, kontrak config dan envelope, bukti penerimaan, serta batas yang diketahui |
