# fable-5-1-dsh

Disiplin reasoning Fable 5.1 untuk DSH (DeepSeek Harness). Satu bundle: satu
policy service (`ctx.fable51`), lima hook event, dan 92 tool berprefiks
`fable51_`.

Yang dikerjakan bundle ini, secara konkret:

- **Menghitung budget per stage dan per session.** Token yang terpakai
  tercatat per stage, alert di 80 persen, sinyal stop di 100 persen. Budget
  milik satu run tidak bisa di-reset run lain.
- **Mencatat verdict verifikasi yang tidak bisa mengarang.** Envelope hanya
  berstatus `verified` kalau ada artifact, perintah, dan output. Gate yang
  gagal berbalik `unverified`, bukan hijau.
- **Menulis jejak audit yang bisa dibaca ulang.** Worklog, cost ledger, cache
  hit, snapshot, dan pass lineage tersimpan, lalu bisa dibaca dengan satu
  tool.

Status di host ini, diverifikasi 2026-10-20:

| Item | Nilai |
|---|---|
| Target dsh | developer preview `0.2.0-rc.2`, commit `23c78fcdd5ee0b497a77ca356608c51093c74bb9` |
| Runtime | Cordis, TypeScript, ESM only |
| Tool | 92, mencakup 91 spec id |
| Hook | 5 (`agent/pre-step`, `tools/execute`, `tools/result`, `llm/stream`, `session/event`) |
| Service | `ctx.fable51` |
| CLI | `fable51 inspect`, `fable51 advise-budget` |
| Test | 282 di 96 suite, semuanya lulus |
| Lisensi | MIT |

Cakupan 100 spec di `sumber100specs.md`:

| Kelas | Jumlah | Bentuk |
|---|---|---|
| Punya tool sendiri | 91 | tool `fable51_<nama>` (92 tool; spec 11 punya tool kedua) |
| Method service yang dipicu hook | 6 | spec 4, 6, 10, 15, 55, 58 |
| Method service yang dipanggil tool | 3 | spec 18, 43, 96 |
| Tidak diimplementasikan | 0 | tidak ada |

---

## Pasang

Development install ke profile (pola yang dipakai plugin lokal lain di sini:
dependensi `link:` plus entri `dsh.profile.bundles`):

```jsonc
// <profile>/package.json
{
  "dependencies": { "fable-5-1-dsh": "link:/path/to/fable-5-1-dsh" },
  "dsh": { "profile": { "bundles": ["...", "fable-5-1-dsh"] } }
}
```

```sh
pnpm install                       # di direktori profile
dsh --profile <nama> --dump-config # entry id harus muncul: fable-5-1
```

Untuk install ke host eksternal, peer dependency resolve dari tree host.
Registry publish opsional; `file:` dan `link:` jalur dev yang didukung.

## Aktif

Bundle ini plugin class. `lib/index.js` default-export `Fable51Policy`, yang
register sebagai `ctx.fable51` dan menyambungkan hook dan tool di
constructor-nya. Aktivasi bisa diamati: service mencatat baris berisi
`fable-5-1 loaded` dan jumlah tool yang terdaftar, dan tool-nya muncul di
`ctx.tools.schemas()`.

Kalau salah satu service yang di-inject (`tools`, `llm`, `sessions`) belum
ada, plugin menunggu, bukan gagal diam-diam. Verifikasi aktivasi, jangan
berhenti pada install yang sukses.

## Pakai

| Jalur | Yang kamu lakukan |
|---|---|
| Skill | Minta `fable-5-1-discipline`. Dia yang mengurutkan stage map, fork, verifikasi, merge, jadi kamu tidak perlu tahu nama tool. |
| Tool | Panggil satu tool untuk satu cek. Yang sering dipakai: `fable51_verification-gates`, `fable51_stage-graph-dag`, `fable51_sandbox-boundaries`, `fable51_worklog-format`, `fable51_inspect`. |
| CLI | `fable51 inspect` menampilkan state bundle tanpa agent. `fable51 advise-budget <taskClass>` merekomendasikan config budget. |

```sh
pnpm build                        # emits lib/, termasuk lib/cli.js

fable51 inspect
fable51 inspect --format json
fable51 advise-budget multihop
```

`HOWTOUSE.md` punya peta 92 tool, prosedur operator, dan perintah verifikasi.

## Kontrak hasil

Semua tool balas envelope yang sama:

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

`ok` jadi `false` untuk argumen yang ditolak atau tool yang gagal, tidak pernah
throw ke host. `verdict` hanya bisa turun ke `unverified`: tool yang melaporkan
`pass:false`, `missing[]`, atau `unverified[]` tidak kembali sebagai
`verified`. `rerun` jadi `true` kalau jawabannya datang dari cache
idempotency. Tool effectful selalu eksekusi ulang, cache hanya untuk
perhitungan murni.

Registry host memvalidasi envelope yang dikembalikan terhadap schema yang
dideklarasikan. Registry tidak memvalidasi argumen input, jadi skema yang
salah baru kelihatan saat pemanggilan, bukan saat registrasi.

## Config

Config opsional dan partial: `resolveConfig` melakukan deep-merge objek kamu
di atas default lengkap, lalu validasi. Default bukan fallback diam-diam. Key
asing, tipe salah, nilai di luar rentang, atau threshold context yang tidak
urut melempar `ConfigError` dengan path field yang tepat, dan nilai `config:`
yang bukan objek ditolak, bukan dibaca sebagai kosong. salah ketik tidak bisa
merge jadi tidak ada lalu terbaca aktif.

| Blok | Spec | Key dan default |
|---|---|---|
| `context` | 1 | `compactAt 0.70`, `dropAt 0.85`, `spillAt 0.90`, `spillPath .dsh/fable-spill` |
| `effort` | 6, 11 | `defaultTier mid`, `escalateOn [search, multihop, ambiguity]`, `costCeiling 2000000` |
| `budget` | 14, 21, 22, 52, 72, 81, 96 | `maxReplans 2`, `maxPassRetries 2`, `passTimeoutMs 120000`, `stageTimeoutMs 600000`, `stageTokenBudget 400000`, `maxForkDepth 4`, `maxForksPerStage 8`, `maxMergesPerStage 8` |
| `reasoning` | 55, 58, 73, 75 | `maxConcurrentPasses 4`, `convergenceDelta 0.02`, `convergenceTurns 3`, `decayLambda 0.15`, `quorumThreshold 0.6` |
| `determinism` | 25 | `seed 20261011`, `iterationOrder stable`, `pinnedVersions { dsh: 23c78fcd... }` |
| `sandbox` | 26 | `allowList {}`, `escapeAction abort` |
| `hitl` | 27 | `requireOnIrreversible true`, `requireOnExternal true`, `requireAboveCost 500000` |
| `observability` | 24, 79 | `traceLevel stage`, `logFormat line` |
| `registry` | 100 | `policies []` |

## Yang menahan vs yang cuma lapor

Kebanyakan spec mengklasifikasi dan melaporkan, tidak memblokir. Tahu mana yang
mana sebelum memakainya sebagai kontrol.

| Menahan | Bagaimana |
|---|---|
| `sandbox-boundaries` (26) | Escape dicatat dengan verdict `discarded`. Kalau `escapeAction: 'abort'`, tool melempar dan envelope jadi `ok:false`, bukan hasil yang kelihatan pakai. Allow-list kosong mengizinkan read dan menolak write. Allow-list yang dideklarasikan dicocokkan persis. |
| `human-in-the-loop` (27) | Fail-closed: `irreversible`, `external`, atau `estimatedCost` yang tidak dikirim tetap minta persetujuan. Hanya jalan kalau model memanggil tool. |
| Bandwidth (55) | Waterfall `tools/execute` memegang satu slot pass paralel per session, di sekitar body tool. Di atas `maxConcurrentPasses`, sisanya **antre**: call menunggu slot, bukan ditolak. Call nested tidak ambil slot, jadi rantai dependensi tidak bisa deadlock di cap. |
| Isolasi fault hook | Fault di `agent/pre-step` atau `llm/stream` dicatat, lalu step atau stream lanjut. Plugin tidak bisa membatalkan turn. |

| Cuma lapor | Konsekuensi |
|---|---|
| `context-management` (1) | Aksi compact, drop, atau spill diklasifikasi dan dicatat. Tidak ada message list yang dipotong atau di-spill. |
| Eskalasi effort (6) | `effortTier` naik dan dicatat. Parameter model tidak berubah. |
| `reasoning-backpressure` (71) | Dilaporkan dari queue depth yang dikirim pemanggil, tidak diukur sendiri. Spec 55 yang mengukur antrean sungguhan. |
| Progress reporting (4) | Jejak progres run dicatat dan ditampilkan. Menarasi transisi stage dan kegagalan gate. Baris per-step sengaja tidak ada. |
| Tool cache | Replay idempotent menutup perhitungan murni. Tool `effectful` selalu eksekusi ulang. |

Singkatnya: jangan pakai bundle ini sebagai sandbox atau approval mechanism.
Ini ledger, classifier, dan discipline helper. Kontrol yang benar-benar
mengikat adalah permission DSH sendiri.

## Jaminan

- **Integrasi terverifikasi di permukaan.** Setiap hook dan API yang dipakai
  bundle ini dicek terhadap source commit dsh yang dipin: `agent/pre-step`
  (waterfall, `PreStepDecision`), `tools/execute` (around-dispatch waterfall,
  `PreToolDecision`), `tools/result` (emit), `llm/stream` (waterfall),
  `session/event` plus `session/created` dan `session/disposed` (emit),
  `ctx.tools.register(definition)` yang mengembalikan disposer. Bukti file dan
  baris ada di `RECON.md`.
- **Envelope seragam.** Semua tool mengembalikan
  `{ok, spec, output, verdict, unverified, rerun, gates}`. Argumen yang
  ditolak datang sebagai `ok:false`, bukan exception.
- **Config fail-loud** dengan error berpath. Policy registry immutable:
  perubahan berarti versi baru, dan id plus versi yang sama adalah error.
- **Pass lineage append-only** dengan prune, GC, dan audit protection. Pass
  yang menyebut parent yang tidak dikenal ditolak.
- **State terbatas.** Worklog, gate log, cost ledger, reason cache, dan
  snapshot store meng-evict yang tertua lebih dulu. Total biaya per stage
  bertahan melewati eviction. Budget token per stage me-reset pada
  `turn/start`, untuk session itu saja. Episode tiap run juga terbatas:
  maksimal 64 session hidup, 200 progress record per run.
- **Kebersihan encoding:** LF, UTF-8 tanpa BOM, final newline di setiap file
  teks.
- **Terverifikasi lewat agent loop.** Selain suite, bundle ini dijalankan di
  dalam sesi headless sungguhan: model memanggil `fable51_chain-vs-tree` dan
  menerima envelope asli, lalu spec 4 dan 55 dibaca balik lewat
  `fable51_inspect` di run yang sama. Buktinya log sesi, bukan klaim.

## Test

```sh
pnpm test        # unit + integration + e2e, node:test via tsx
pnpm typecheck   # tsc -b, lalu project test
pnpm build       # emit lib/, termasuk lib/cli.js
```

Pada commit `3b701d6`: 227 test di 89 suite lulus, dan `pnpm typecheck` exit
0. Dengan visualizer, budget advisor, CLI, episode per-session, spec 4 dan 55,
validasi `--format` di CLI, advisor dengan ledger terisi, dan kontrak peer
dependensi: **283 test di 96 suite lulus**.

Suite integration dan e2e memuat bundle ke host Cordis sungguhan dengan
service dsh sungguhan (`dsh-tools`, `dsh-llm`, `dsh-session`,
`dsh-system-prompt`) dan memanggil dispatcher event asli.

## Batas yang harus kamu tahu

- **Audit trail per-host, budget per-session.** Satu `ctx.fable51` melayani
  semua session di host, jadi worklog, cost ledger, reason cache, snapshot
  index, dan pass lineage dibagi. Audit jangka panjang memang di level host,
  dan `fable51 inspect` menampilkan gambaran itu. Yang menegakkan run (stage
  token budget, jatah fork/merge, escalation ladder, replan count, effort
  tier, convergence window) di-key per session. `turn/start` hanya me-reset
  budget session-nya sendiri, jadi satu session tidak bisa menghapus budget
  session lain.

  Identitas session datang dari host: `Agent.session.id` untuk pre-step hook
  dan eksekusi tool, `GenerateOptions.sessionId` untuk stream hook, dan objek
  session untuk event lifecycle. Call yang tidak diatribusikan host masuk ke
  bucket `default` tersendiri, yang tidak di-reset turn session mana pun.
- **Cap bandwidth itu per session, jadi bukan cap host.** Satu session
  maksimal menjalankan `maxConcurrentPasses` pass paralel, tapi dua session
  di host yang sama masing-masing mendapat jatah penuh, jadi konkurensi
  host bisa jadi beberapa kali lipat cap itu. Host punya cap sendiri
  (`maxParallelToolCalls`, default 10); yang lebih kecil dari dua cap itu
  yang mengikat.
- **Tool yang tidak mendeklarasikan `isConcurrencySafe` berjalan eksklusif.**
  Host dispatch paralel hanya untuk tool yang menandainya, misalnya `read`.
  Tool `fable51_*` sendiri tidak menandainya, jadi beberapa tool yang dipanggil
  sekaligus berjalan berurutan dan tidak pernah menyentuh cap.
- **Tidak ada CI dan tidak ada lockfile.** `lib/` ada di `.gitignore`, jadi
  artifact yang dijalankan host adalah apa pun yang ter-build lokal. Berlaku
  juga untuk CLI: `bin/fable51.js` adalah shim ke `lib/cli.js`, jadi butuh
  `pnpm build` lebih dulu.
- **Registry tidak memvalidasi argumen input.** Skema yang rusak baru
  ketahuan saat tool dipanggil, bukan saat registrasi.
- **Definisi spec 21 dan 23 sampai 26** adalah tambahan operator.
  `PRD_REVISI.md` bagian 11 mencatat cross-check terhadap `sumber100specs.md`:
  100 id dan nama cocok. Kolom "Kills" di dokumen spec lama adalah anotasi
  operator di atas aturan sumber.
- **Import runtime** pada jalur plugin (`src/index.ts`) adalah
  `@deepseek-ai/cordis` (service dan context), `@deepseek-ai/schemastery`
  (schema `Config`), dan `node:crypto`. Import `dsh-llm`, `dsh-agent`, dan
  `dsh-session` di sana hanya untuk tipe. Entry CLI (`src/cli.ts`) berbeda:
  ia meng-import `dsh-tools`, `dsh-llm`, `dsh-session`, dan
  `dsh-system-prompt` sebagai runtime dependency. Semuanya dideklarasikan di
  `peerDependencies` paket ini; `dsh-llm`, `dsh-session`, dan
  `dsh-system-prompt` ditandai optional karena hanya dibutuhkan oleh entry
  CLI, bukan oleh jalur plugin. `schemastery` resolve lewat dependensi
  `dsh-tools` host dan tidak dideklarasikan langsung di `peerDependencies`
  paket ini.

## Dokumen

| File | Isi |
|---|---|
| `HOWTOUSE.md` | Panduan operator: pasang, pakai, peta 92 tool, config, verifikasi |
| `PRD.md` | Requirements as-built, bukti, dan pertanyaan terbuka |
| `PRD_REVISI.md` | Spesifikasi pra-kode v0.1.1 dan pemetaan 100 spec |
| `sumber100specs.md` | Inventaris 100 spec: id, aturan inti, pemicu |
| `RECON.md` | Bukti file dan baris untuk tiap permukaan dsh |
| `cordis.patch.yml` | Entri patch bundle |

## Lisensi

MIT. Lihat `LICENSE`.
