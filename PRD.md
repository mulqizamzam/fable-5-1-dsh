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
Bentuknya satu service (`ctx.fable51`), lima hook event, dan 92 tool
berprefiks `fable51_`.

Dari 100 spec di `sumber100specs.md`:

| Kelas | Jumlah | Bentuk |
|---|---|---|
| Punya tool sendiri | 91 | tool `fable51_<nama>` (92 tool; spec 11 punya tool kedua) |
| Hidup sebagai method service yang dipicu hook | 6 | spec 4, 6, 10, 15, 55, 58 |
| Hidup sebagai method service yang dipanggil tool | 3 | spec 18, 43, 96 |
| Tidak diimplementasikan | 0 | tidak ada |

Angka 92 berasal dari enumerasi `allToolSpecs()` di `src/tools/index.ts`.
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
| `visualize` | 1 |
| `budget-advisor` | 1 |
| Total | 92 |

Nama tool memakai garis bawah, bukan titik. Alasannya ada di
`src/tools/shared.ts`: provider yang kompatibel dengan OpenAI menolak nama tool
di luar pola `^[a-zA-Z0-9_-]+$`, sehingga namespace `fable51.` berubah menjadi
`fable51_` di commit `1255017`. README sudah memakai
`fable51_`.

## 2. Masalah yang diselesaikan

Agent loop jangka panjang punya tiga titik gagal yang tidak tertutup oleh
disiplin model saja.

1. **Klaim tanpa bukti.** Model bisa menulis "sudah diverifikasi" tanpa
   artefak, perintah, atau output. Tidak ada tempat yang mencatat klaim itu
   dengan bukti yang bisa diperiksa ulang.
3. **Struktur reasoning tidak terlihat.** Fork, merge, retry, replan, dan
   eskalasi berjalan tanpa ledger. Setelah sesi selesai, tidak ada cara
   mengetahui berapa pass yang dibuat, mana yang dibuang, dan berapa biayanya.
4. **Konfigurasi plugin gagal diam.** Typo satu key membuat plugin berjalan
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
paling sering dipakai ada di `HOWTOUSE.md`.

## 4. Lingkup

**Termasuk:**

- Satu policy service yang menyimpan registry, lineage, cache, snapshot,
  gate log, worklog, dan cost ledger.
- Lima hook event: `agent/pre-step`, `tools/execute`, `tools/result`,
  `llm/stream`, `session/event` (ditambah `session/created` dan
  `session/disposed`).
- 92 tool dengan envelope hasil seragam.
- Config sembilan blok dengan validasi fail-loud.
- Suite unit, integration, dan e2e yang memuat bundle ke host Cordis nyata.

**Tidak termasuk:**

- Sandbox tingkat OS. `sandbox-boundaries` adalah pencocokan path terhadap
  allow-list, bukan pembatas filesystem.
- Penegakan approval otomatis. `human-in-the-loop` hanya menjawab bila model
  memanggil tool itu.
- Isolasi state per session untuk counter run. Counter ditegakkan per
  session, tapi jejak audit dibagi satu host (lihat §13).
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
│   ├── agent/pre-step      waterfall, observasional + progress
│   ├── tools/execute        waterfall around-dispatch, gerbang bandwidth
│   ├── tools/result        emit, mencatat bukti dan biaya
│   ├── llm/stream          waterfall generator, penghitung token
│   └── session/*           lifecycle + durable event
└── tools fable51_*         92 tool, 12 kelompok
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

92 tool harus terdaftar dengan nama `fable51_<nama>`, satu tool per spec yang
dikelompokkan, dan tidak ada nama dobel.

- Terima: `allToolSpecs()` mengembalikan 92 nama unik dengan prefiks benar.
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
- Status: terpenuhi. Enumerasi mencatat 26 tool effectful, 66 tool murni.

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

Hook harus mencatat satu baris observability **per stage**, bukan per step,
mengklasifikasi rasio context (ok, compact, drop, spill), dan menaikkan effort
tier satu kali per task saat pesan memuat sinyal `search`, `multihop`, atau
`ambiguity`. Stage bergeser saat run pindah turn; step di dalam turn yang sama
bukan stage, dan menarasinya setiap step adalah spam yang harus dibunuh. Hook
tidak boleh menolak step. Fault di dalam hook dicatat lalu step tetap
diizinkan lewat `next()`.

- Terima: tiga step dalam satu turn menghasilkan satu baris progress; turn baru
  menghasilkan baris baru; gate gagal dinarasi sekali.
- Status: terpenuhi. Klasifikasi context hanya mencatat; tidak memotong atau
  memindahkan message list.

### FR-08 Hook `tools/execute`

Hook harus memegang satu slot pass paralel per session, di sekitar body tool:
slot diambil sebelum body berjalan dan dilepas setelah body selesai, di dalam
waterfall yang sama. Di atas `maxConcurrentPasses`, excess **antre**: call
menunggu slot, bukan ditolak. Call nested (yang punya `parent`) tidak mengambil
slot dan tidak pernah menunggu, karena rantai dependensi tidak boleh deadlock di
cap. Hook tidak boleh menolak call.

Slot tidak boleh diambil di waterfall pre-execute. Host menunggu prepare setiap
call sebelum memulai call berikutnya, dan hasil call baru dinotifikasi saat
commit, yang terjadi di belakang await itu. Menahan slot di sana membuat host
macet: call yang sudah jalan selesai, tapi hasil-nya tidak pernah di-commit,
jadi slot tidak pernah lepas. Waterfall `tools/execute` membingkai body, jadi
pelepasannya dijamin terjadi saat dispatch, bukan saat commit.

- Terima: tiga call paralel dengan cap dua → satu antre, ketiganya jalan;
  slot kembali nol setelah call selesai; call nested tidak pernah menunggu;
  grup paralel yang melampaui cap tidak membuat host macet.
- Status: terpenuhi (`src/hooks/tools-execute.ts`,
  `test/unit/progress-bandwidth.spec.ts`).

### FR-09 Hook `tools/result`

Hook harus mencatat hasil tool ke worklog, menandai bukti baru untuk
perhitungan konvergensi, dan membukukan biaya kasar per panggilan. Hook tidak
boleh mengubah hasil tool.

- Terima: hasil tool tercatat; `isError` membuat baris worklog masuk sebagai
  `neutral` dengan daftar `unverified` terisi.
- Status: terpenuhi.

### FR-10 Hook `llm/stream`

Hook harus menghitung token per stream, memberi alert pada 80 persen budget dan
sinyal stop pada 100 persen, mem-fingerprint chunk untuk deteksi duplikat
(stream tetap diteruskan), melabeli reasoning antar tool call sebagai
`interleaved`, dan mencatat jarak konvergensi per turn.

- Terima: stream tidak berubah; angka budget dan convergence tercatat.
- Status: terpenuhi di level hook. Jalur streaming LLM penuh belum pernah
  dieksekusi end-to-end (lihat §13).

### FR-11 Hook lifecycle session

`session/created` harus mereset state episode (rung, replan, fork/merge,
effort, label pass, jendela konvergensi). `turn/start` harus mereset budget
token stage dan counter fork/merge. `turn/end` harus membuat snapshot.
`session/disposed` harus menyimpan handoff dan menulis baris postmortem.

- Terima: reset teramati; snapshot dan handoff punya id unik.
- Status: terpenuhi (`src/hooks/session-event.ts`).

### FR-12 State terbatas

Semua ledger harus punya batas dan membuang entri tertua lebih dulu. Total
biaya per stage tidak boleh ikut turun saat cincin ledger membuang entri lama.

- Terima: cap ditegakkan; `stageCost` tetap akumulatif.
- Status: terpenuhi (`pushCapped`, `recordCost` di `src/policy-service.ts`).

### FR-13 Determinisme

Seed, urutan iterasi, dan versi pin harus berasal dari config. Fingerprint
konten harus stabil untuk input yang sama sehingga replay menghasilkan hash
yang sama.

- Terima: tool `determinism` mengembalikan urutan sesuai mode; replay
  membandingkan hash.
- Status: terpenuhi di level unit. Replay lintas proses belum diuji.

### FR-14 Kebersihan encoding

Semua berkas teks: LF, UTF-8 tanpa BOM, newline di akhir berkas.

- Terima: skrip pemeriksaan melaporkan nol pelanggaran.
- Status: sebagian. Pada 79 berkas yang diperiksa, dua berkas tidak berakhir
  newline: `HOWTOUSE.md` dan `test/unit/audit-defects.spec.ts`.

### FR-16 Isolasi penyewa

Satu host melayani banyak sesi. Worklog, gate log, cost ledger, lineage pass,
snapshot, dan cache idempotency sebelumnya bersifat host-wide: satu penyewa
bisa membaca belanja dan riwayat penyewa lain, dan budget advisor menghitung
rekomendasi dari booking yang tidak pernah dibuat pemanggilnya.

Setiap state bersama itu harus hidup di bawah satu penyewa. Penyewa diambil
dari direktori kerja sesi, karena itu batas yang sudah digambar host saat
membuat sesi. Sesi tanpa direktori masuk ke penyewa default, yang adalah
bucket sungguhan, bukan wildcard. Kunci scope menggabungkan penyewa dengan
sesi, jadi episode, anggaran, dan ledger milik satu sesi dari satu penyewa.

Blok `tenants` memilih batasnya: `cwd` memakai direktori kerja (default),
`session` menjadikan tiap sesi penyewa sendiri, `none` mengembalikan satu
penyewa bersama untuk seluruh host.

- Terima: dua penyewa tidak melihat cost ledger, worklog, gate log, atau
  lineage satu sama lain; budget advisor hanya menghitung booking penyawanya;
  `fable51 inspect` menyebut nama penyawanya; registry penyewa tidak tumbuh
  tanpa batas; dua sesi satu penyewa berbagi state tenant tetapi tidak
  episode.
- Status: terpenuhi (`src/state/tenant.ts`, `test/unit/tenant-isolation.spec.ts`).

### FR-15 Paket bisa dipasang

`package.json` harus memuat `dsh.bundle.patch`, menaruh paket dsh di
`peerDependencies`, dan menyertakan `lib/`, `cordis.patch.yml`, README, serta
LICENSE di daftar `files`.

- Terima: `dsh --profile <p> --dump-config` menampilkan entry `fable-5-1`.
- Status: manifest terpenuhi. Komposisi profile belum dijalankan ulang pada
  sesi ini.

## 7. Cakupan 100 spec

### 7.1 Yang benar-benar menahan

Hanya empat hal di bundle ini yang bisa menghentikan sesuatu.

| Mekanisme | Perilaku |
|---|---|
| `sandbox-boundaries` (26) | Escape dicatat dengan verdict `discarded`. Bila `escapeAction: 'abort'`, tool melempar sehingga envelope menjadi `ok:false`, bukan hasil yang terlihat sah. Allow-list kosong berarti read diizinkan dan write ditolak. Allow-list yang dideklarasikan dicocokkan persis. |
| `human-in-the-loop` (27) | Fail-closed. `irreversible`, `external`, atau `estimatedCost` yang tidak dikirim tetap meminta approval. Tetap hanya berjalan bila model memanggil tool. |
| Bandwidth (55) | Waterfall `tools/execute` memegang satu slot pass paralel per session, di sekitar body tool. Di atas `maxConcurrentPasses`, excess **antre**: call menunggu slot, bukan ditolak. Call nested (punya `parent`) tidak ambil slot, jadi rantai dependensi tidak bisa deadlock di cap. Tool yang cuma menghitung ditandai `isConcurrencySafe`, jadi host dispatch-nya paralel; tool yang menyentuh state tidak. |
| Isolasi fault hook | Error di `agent/pre-step` atau `llm/stream` dicatat, lalu step atau stream lanjut. Plugin tidak bisa membatalkan turn. |

### 7.2 Yang mengklasifikasi dan melapor

| Spec | Konsekuensi |
|---|---|
| `context-management` (1) | Aksi compact, drop, spill diklasifikasi dan dicatat. Tidak ada message list yang dipotong. |
| `effort-escalation` (6) | `effortTier` naik dan dicatat. Parameter model tidak berubah. |
| `progress-reporting` (4) | Jejak progres run dicatat dan ditampilkan. Menarasi transisi stage dan kegagalan gate; baris per-step sengaja tidak ada. |
| `reasoning-backpressure` (71) | Dilaporkan dari queue depth yang dikirim pemanggil. Spec 55 yang mengukur antrean sungguhan. |
| `idempotency` (19) | Cache hanya untuk tool murni. |
| `research-provenance` (7) | Tag `[fetch:url]`, `[mem:era]`, `[inf]` ditempel pada string; tidak diverifikasi. |

### 7.3 Sembilan spec yang hidup di service atau hook

| Spec | Nama | Mekanisme |
|---|---|---|
| 4 | progress-reporting | `recordProgress()` dari hook pre-step, hanya saat transisi stage atau gate gagal |
| 6 | effort-escalation | `escalateEffort()` dipanggil hook pre-step, sekali per task |
| 10 | session-handoff | `handoffSnapshot()` dipanggil saat session disposed |
| 15 | parallel-vs-sequential | `labelPass()` dari hook stream, nilai `interleaved` |
| 18 | rollback-protocol | `lastVerifiedSnapshot()` sebagai target rollback |
| 43 | reasoning-cache | cache dipakai `defineTool` untuk semua tool murni |
| 55 | reasoning-bandwidth | `acquireSlot()`/`releaseSlot()` dari hook tools/execute, excess diantre |
| 58 | convergence-criteria | `converged()` dari jarak per turn dan bukti baru |
| 96 | fork-merge-budget | `canFork()`, `canMerge()`, `recordFork()`, `recordMerge()` |

### 7.4 Cakupan spec yang tersisa

Nol. Seluruh 100 spec di `sumber100specs.md` punya bentuk: 91 punya tool sendiri,
9 hidup sebagai method service: 6 dipicu hook, 3 dipanggil tool.

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
| `tenants` | isolasi penyewa | `mode cwd`, `defaultKey default`, `maxTenants 64` |

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

Semua state hidup di satu instance `ctx.fable51` per host, tapi dibagi per
penyewa: ring di atas berlaku per penyewa, dan jumlah penyewanya sendiri
dibatasi `tenants.maxTenants` (default 64). Lihat §13 untuk konsekuensinya.

## 11. Persyaratan non-fungsional

| ID | Persyaratan | Bukti |
|---|---|---|
| NFR-01 | Tidak ada `dependencies` pada paket inti dsh yang stateful; hanya `peerDependencies` | `package.json` |
| NFR-02 | Semua tool mengembalikan nilai bertipe; tidak ada `void` | `defineTool` |
| NFR-03 | Fault hook tidak boleh membatalkan turn | guard di kelima hook |
| NFR-04 | Semua ledger terbatas | tabel §10 |
| NFR-05 | Build dan test berjalan di Node sesuai `engines` | `pnpm test`, `pnpm typecheck` |
| NFR-06 | Lisensi MIT dan encoding LF/UTF-8 | `LICENSE`, `.editorconfig`, §12 |

## 12. Kriteria penerimaan dan bukti

Diukur pada 2026-10-20. Angka pertama diambil pada commit `3b701d6` (working
tree bersih saat pengukuran), lalu diperbarui setelah penambahan visualizer,
budget advisor, CLI, episode per-session, serta spec 4 dan 55.

| Kriteria | Perintah | Hasil | Status |
|---|---|---|---|
| Tool terdaftar lengkap | enumerasi `allToolSpecs()` | 92 tool, 91 spec id | lulus |
| Suite test | `pnpm test` | 306 test, 100 suite, 306 lulus, 0 gagal | lulus |
| Typecheck | `pnpm typecheck` | exit 0 | lulus |
| Config fail-loud | `test/unit/config.spec.ts` | lulus | lulus |
| Envelope dan verdict | suite unit | lulus | lulus |
| Hook menyala | suite unit, integration, e2e yang memanggil dispatcher Cordis | 5 hook | lulus |
| Encoding | pemeriksaan seluruh berkas tracked | 0 pelanggaran | lulus |
| Boot profile dsh | `dsh --profile fable-test --dump-config` | 92 tool terdaftar | lulus |
| Jalur agent loop | `dsh --profile fable-test headless "<task>"` | envelope asli diterima | lulus |
| CLI | `node bin/fable51.js inspect` dan `advise-budget` | ASCII dan JSON | lulus |
| Host pasca-restart | `ps` untuk waktu start host, impor `lib/tools/index.js` | 92 tool, host start 53 menit setelah build | lulus |
| Advisor dengan ledger terisi | `test/unit/budget-advisor.spec.ts` + sesi headless | 200.000 token x 5.0 = 1.000.000, sampleSize 4 di host | lulus |
| Antrean bandwidth mengikat di host nyata | sesi headless: 2 lalu 5 tool `fable51_*` murni paralel | peak 2 lalu peak 4 pada cap 4 | lulus |
| Tool murni boleh paralel | `test/unit/concurrency.spec.ts` | 64 tool paralel, 28 eksklusif | lulus |
| Sweep semua tool di host nyata | `test/unit/sweep.spec.ts` | 92 dari 92 tool menerima argumen schema-nya, 0 error host | lulus |
| Isolasi penyewa | `test/unit/tenant-isolation.spec.ts` | ledger, worklog, gate log, dan lineage terpisah per penyewa; 13 tes | lulus |
| Sweep dua arah | `test/unit/idempotency.spec.ts` | tiap tool dipanggil dua kali: tool murni jawab sama, tool effectful tak menyajikan cache, mutasi terjadi dua kali | lulus |
| Grup paralel tidak membuat host macet | `test/unit/progress-bandwidth.spec.ts` | desain lama hang >220 detik, desain baru 38 detik | lulus |

Suite test terdiri dari 25 berkas unit, 1 integration, dan 1 e2e.

## 13. Batas, risiko, dan salah pakai

1. **Jejak audit per penyewa, counter run per session.** Worklog, ledger,
   cache, snapshot, dan lineage di-key per penyewa, jadi satu project tidak
   membaca milik project lain. Counter yang menegakkan run (budget token,
   jatah fork/merge, escalation ladder, replan count, effort tier,
   convergence window) di-key per session: `turn/start` dari satu session
   hanya me-reset budget session itu sendiri. Identitas session dialirkan dari
   host lewat `Agent.session.id`, `ToolExecution.agent`,
   `GenerateOptions.sessionId`, dan objek session lifecycle; penyewa diambil
   dari `session.header.cwd`, dan tampilan session yang hanya membawa id
   mencari penyawanya lewat registry yang diisi lifecycle sesi.
2. **Penyewa yang keluar dari ridi kehilangan history-nya.** Registry
   penyewa dibatasi `maxTenants` (default 64) dan evict yang tertua.
   Project yang kembali setelah di-evict mulai dari nol, bukan melanjutkan
   riwayat setengah jadi. Naikkan `maxTenants` kalau satu host melayani
   lebih dari 64 project aktif.
3. **Bukan sandbox dan bukan approval mechanism.** Jangan jadikan
   `sandbox-boundaries` atau `human-in-the-loop` sebagai satu-satunya kontrol.
   Keduanya hanya berjalan bila model memanggil tool, dan yang pertama hanya
   membandingkan string path.
4. **Cap bandwidth itu per session, bukan cap host.** Satu session maksimal
   menjalankan `maxConcurrentPasses` pass paralel, tapi dua session di host
   yang sama masing-masing mendapat jatah penuh. Host punya cap sendiri
   (`maxParallelToolCalls`, default 10); yang lebih kecil dari dua cap itu
   yang mengikat. Bundle ini menurunkan penanda `isConcurrencySafe` dari
   `effectful`: 64 tool yang cuma menghitung boleh jalan bareng, 28 tool
   yang menyentuh state jalan satu per satu. Terverifikasi di host nyata:
   satu sesi headless dengan dua tool `fable51_*` murni dipanggil sekaligus
   melaporkan `peak` 2, dan sesi dengan lima tool seperti itu melaporkan
   `peak` 4 pada cap 4, jadi cap ini mengikat jalur model, bukan cuma jalur
   tool host. Jalur agent-loop penuh sendiri sudah dijalankan end-to-end pada
   2026-10-20 lewat `dsh --profile fable-test headless`: envelope asli
   `fable51_chain-vs-tree` diterima, dan spec 4 serta 55 terverifikasi lewat
   jalur yang sama.
5. **Tidak ada CI dan tidak ada lockfile.** Artefak yang dijalankan host adalah
   hasil build lokal. `lib/` tidak masuk git.
6. **Registry tidak memvalidasi argumen input.** Kesalahan schema terdeteksi
   saat return, bukan saat registrasi.
7. **Jejak audit per penyewa, bukan per host.** Sudah tertutup: worklog,
   cost ledger, cache, snapshot store, dan lineage di-key per penyewa
   (FR-16), jadi satu project di satu host tidak membaca milik project lain.
   Yang tersisa: registry penyewa dibatasi, jadi project yang keluar dari ridi
   kehilangan history-nya. Lihat §7.3 dan README "Batas penyewa".
8. **Drift dokumentasi.** Sudah tertutup: README memakai namespace `fable51_`
   dan menyebut 9 spec hidup sebagai method service (6 dipicu hook, 3 dipanggil
   tool), sesuai §7.3.
9. **Aturan encoding.** Terpenuhi sekarang: 0 pelanggaran pada seluruh berkas
   tracked. Lihat FR-14.

## 14. Pertanyaan terbuka

| # | Pertanyaan | Dampak bila tidak dijawab |
|---|---|---|
| 1 | ~~Apakah state harus diisolasi per session, dan siapa yang menyediakan identitas session?~~ **Terjawab**: diisolasi per session; identitas datang dari host (`Agent.session.id`, `ToolExecution.agent`, `GenerateOptions.sessionId`, objek session lifecycle). | tidak ada |
| 2 | ~~Apakah spec 4 dan 55 akan diimplementasikan atau dicabut dari klaim 100 spec?~~ **Terjawab**: keduanya diimplementasikan (FR-07 dan FR-08). | tidak ada |
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
| `HOWTOUSE.md` | Panduan operator: pasang, config, peta tool, batas |
| `README.md` | Ringkasan paket untuk konsumen baru |

## 16. Riwayat revisi

| Revisi | Tanggal | Isi |
|---|---|---|
| 1 | 2026-10-20 | Ditulis ulang sebagai PRD as-built dari commit `3b701d6`: angka terverifikasi, pembagian cakupan 90/8/2, kontrak config dan envelope, bukti penerimaan, serta batas yang diketahui |
| 2 | 2026-10-20 | Cakupan spec 100/100 (spec 4 dan 55 diisi), 92 tool, 5 hook, episode per session, CLI `fable51 inspect` dan `advise-budget`, jalur agent loop terverifikasi end-to-end, panduan operator dipindah ke `HOWTOUSE.md` |
| 3 | 2026-10-21 | Advisor diverifikasi dengan cost ledger terisi, dan jalur antrean bandwidth dikarakterisasi sebagai tidak terjangkau host dsh 0.2.0-rc.2 |
| 4 | 2026-10-21 | Isolasi penyewa: worklog, gate log, cost ledger, lineage, snapshot, dan cache dipisah per penyewa (FR-16) |
| 5 | 2026-10-21 | Sweep dua arah: tiap tool dipanggil dua kali, dan jejak audit menandai jawaban yang dilayani dari cache |
