# HOWTOUSE: cara pakai `fable-5-1-dsh`

Panduan operator. `README.md` menjelaskan paketnya; file ini menjelaskan cara
memakainya dan apa yang tidak boleh dipercaya.

Status di host ini, diverifikasi 2026-10-20:

| Item | Nilai |
|---|---|
| Profile aktif | `$DSH_HOME/profiles/web` (bundle ada di `dependencies` dan `dsh.profile.bundles`) |
| Profile uji | `$DSH_HOME/profiles/fable-test` (`dsh-base` + `dsh-headless` + `dsh-ui-director` + bundle ini) |
| Entry id | `fable-5-1` |
| Tool | 92 tool `fable51_*` (91 spec id; spec 11 punya dua tool) |
| Hook | 5 (`agent/pre-step`, `tools/execute`, `tools/result`, `llm/stream`, `session/event`) |
| Service | `ctx.fable51` |

---

## 1. Restart dulu, baru percaya

`lib/` ada di `.gitignore` dan host memuat modulnya sekali saat boot. Jadi
`pnpm build` tidak mengubah host yang sedang jalan. Setelah mengubah kode,
restart DSH.

Cek apakah host yang jalan memang sudah memakai artifact terbaru. Panggil tiga
tool ini dari dalam agent.

```
fable51_sandbox-boundaries { operation: "write", path: "…/README.md" }
```

Allow-list `write` yang kosong berarti path itu di luar daftar, jadi tool
**melempar** dan envelope-nya jadi `ok:false` dengan pesan
`sandbox escape: write on … is outside the declared allow-list`. Artifact lama
membalas `allowed:false, escape:true` tanpa melempar, jadi bentuk `ok:true`
dengan `escape:true` artinya host masih jalan di artifact lama.

```
fable51_verification-gates { check: "demo", cmd: "true", expected: "PASS", actual: "FAIL" }
```

Hasil `ok:true` dengan `verdict:"unverified"` juga tanda artifact terbaru.
Artifact lama membalas `verdict:"verified"` untuk gate yang gagal, dan itu
kebocoran yang harus diperbaiki.

```
fable51_inspect { format: "json" }
```

Dua tanda paling tegas bahwa host sudah memuat build terbaru:

- `output.session` ada, dan `output.bandwidth` ada. Keduanya field yang
  hanya ada di build yang punya isolasi per-session dan spec 55.
- `output.policies` dan seterusnya boleh kosong, tapi `output.session` tidak
  boleh kosong.

Kalau `fable51_inspect` tidak dikenal sama sekali, host masih memuat artifact
sebelum visualizer dan budget advisor.

---

## 2. Tiga jalur pemakaian

### Jalur ringan (default): lewat skill

Minta skill **`fable-5-1-discipline`**, atau sebut pemicunya: "Fable", "stage
map", "audit trail", "rencanakan ini". Skill itu yang mengurutkan pemakaian
tool: stage map, fork, verifikasi, merge. Kamu tidak perlu tahu nama toolnya.

### Jalur manual: panggil tool langsung

Untuk satu cek spesifik:

| Tujuan | Tool |
|---|---|
| Gerbang pass/fail yang nyata | `fable51_verification-gates` |
| Topological sort stage (cycle = hard fail) | `fable51_stage-graph-dag` |
| Cek pengeluaran token per stage | `fable51_token-budget-per-stage` |
| Fork atau keep | `fable51_reasoning-forking` |
| Cek path vs allow-list | `fable51_sandbox-boundaries` |
| Merge paralel | `fable51_merge-strategy` |
| Budget replan / retry | `fable51_replan-budget`, `fable51_pass-retry-policy` |
| Baris audit akhir | `fable51_worklog-format` |
| Lihat seluruh state service | `fable51_inspect` |
| Rekomendasi budget per kelas task | `fable51_budget-advisor` |

### Jalur CLI: tanpa agent

```sh
pnpm build                        # emits lib/, termasuk lib/cli.js

fable51 inspect                   # ASCII: policies, lineage, costs, cache, snapshots, config
fable51 inspect --format json     # state yang sama dalam JSON
fable51 inspect --include-worklog --include-gate-log

fable51 advise-budget multihop    # stageTokenBudget, maxForkDepth, effortTier yang disarankan
fable51 advise-budget search --format json
fable51 advise-budget open --history-window 200 --min-samples 5
```

`fable51 inspect` read-only. `fable51 advise-budget` membaca cost ledger
(spec 11, spec 60): kuantil p50/p90 per stage, diskalakan multiplier kelas
task, dengan label confidence dari jumlah sampel. Ledger kosong jatuh ke
default kelas task dengan confidence `low`, jadi rekomendasinya lantai, bukan
pengukuran.

CLI me-boot bundle sendiri, jadi yang kamu lihat adalah bentuk sebuah bundle,
bukan state live host yang sedang jalan. Untuk melihat host yang live, panggil
`fable51_inspect` dari dalam agent.

---

## 3. Kontrak hasil

Semua 92 tool balas envelope yang sama:

```json
{ "ok": true, "spec": "5", "output": { "check": "...", "pass": true },
  "verdict": "verified", "unverified": [], "rerun": false, "gates": [] }
```

| Field | Arti |
|---|---|
| `ok:false` | argumen ditolak atau tool gagal, bukan throw ke host |
| `spec` | id spec yang ditangani tool itu |
| `output` | isi internal, punya `outputSchema` sendiri |
| `verdict` | hanya tool itu yang boleh menurunkannya ke `unverified`; `pass:false` ikut menurunkan |
| `rerun` | `true` kalau hasil diambil dari cache idempotency, bukan dieksekusi ulang |
| `gates` | daftar gerbang yang dideklarasikan tool, dieksekusi tool verifikasi, bukan inline |

Tool `effectful` (yang mengubah state service) selalu eksekusi ulang. Cache
idempotency hanya berlaku pada perhitungan murni.

---

## 4. Peta 92 tool

Partisi eksak menurut file di `src/tools/`, sudah diverifikasi lewat enumerasi
`allToolSpecs()`. Tidak ada tool yang hilang, dobel, atau karangan.

| Kelompok | N | Tool |
|---|---|---|
| `context` | 6 | `context-management` `subagent-contracts` `tool-call-batching` `artifact-contracts` `token-budget-per-stage` `interleaved-budget` |
| `verification` | 9 | `verification-gates` `research-provenance` `anti-introspection` `cold-verifier-isolation` `idempotency` `verifier-forking` `chain-of-verification` `independent-replication` `speculative-verify` |
| `dag` | 4 | `stage-graph-dag` `reasoning-dag` `deadlock-detection` `pass-dependency-inference` |
| `cost` | 4 | `cost-accuracy-tradeoff` `reasoning-cost-model` `pass-cost-accounting` `pass-sla` |
| `escalation` | 7 | `spec-clarification` `replan-budget` `human-in-the-loop` `escalation-ladder` `abort-criteria` `pass-timeout` `pass-retry-policy` |
| `ops` | 7 | `timeboxing` `conflict-resolution` `observability` `determinism` `sandbox-boundaries` `dependency-pinning` `postmortem-format` |
| `reasoning-core` | 13 | `reasoning-forking` `hypothesis-pruning` `chain-vs-tree` `parallel-tool-feed` `reasoning-checkpoint` `contradiction-detection` `confidence-scoring` `speculative-execution` `early-exit` `divergence-control` `merge-strategy` `reasoning-rollback` `reasoning-trace-format` |
| `reasoning-flow` | 16 | `reasoning-priority` `reasoning-dedup` `hypothesis-scoring` `failure-isolation` `reasoning-replay` `reasoning-audit` `reasoning-topology` `adaptive-branching` `reasoning-heatmap` `cross-pass-consistency` `reasoning-fingerprint` `pass-scheduling` `reasoning-window` `merge-conflict-resolution` `reasoning-lineage` `reasoning-backpressure` |
| `reasoning-ops` | 17 | `reasoning-quorum` `diversity-injection` `reasoning-decay` `pass-prioritization` `reasoning-snapshot-diff` `reasoning-federation` `pass-observability` `reasoning-budget-pool` `reasoning-quarantine` `pass-checkpoint-strategy` `reasoning-lane` `pass-cancellation` `reasoning-affinity` `pass-lineage-prune` `reasoning-deadline-propagation` `pass-quality-score` `reasoning-warmup` |
| `governance` | 7 | `worklog-format` `partial-delivery` `pass-merge-idempotency` `reasoning-drift-detection` `reasoning-garbage-collection` `reasoning-ab-test` `pass-migration` |
| `visualize` | 1 | `inspect` |
| `budget-advisor` | 1 | `budget-advisor` |

Nama tool memakai garis bawah, bukan titik, karena provider yang kompatibel
dengan OpenAI menolak nama di luar pola `^[a-zA-Z0-9_-]+$`.

---

## 5. Yang menahan vs yang cuma lapor

Paling sering disalahpahami. Baca sebelum menjadikannya kontrol.

### Benar-benar menahan (4)

| Spec | Mekanisme |
|---|---|
| `sandbox-boundaries` (26) | Escape dicatat ke worklog dengan `verdict:'discarded'`. Kalau `escapeAction:'abort'` tool melempar, jadi `ok:false`, bukan hasil yang kelihatan pakai. Allow-list kosong berarti read boleh, write ditolak. Allow-list yang dideklarasikan dicocokkan persis. |
| `human-in-the-loop` (27) | Fail-closed: `irreversible`/`external`/`estimatedCost` yang kosong tetap minta persetujuan. Tetap hanya jalan kalau model memanggil tool. |
| Bandwidth (55) | Waterfall `tools/execute` memegang satu slot pass paralel per session, di sekitar body tool. Di atas `maxConcurrentPasses`, sisanya **antre**: call menunggu slot, bukan ditolak. Call nested tidak ambil slot, jadi rantai dependensi tidak bisa deadlock di cap. |
| Isolasi fault hook | Error di `agent/pre-step` atau `llm/stream` dicatat lalu step/stream lanjut. Plugin tidak bisa membatalkan turn. |

### Hanya mengklasifikasi & melapor

| Spec | Konsekuensi |
|---|---|
| `context-management` (1) | Aksi compact/drop/spill diklasifikasi dan di-log. Tidak ada message list yang terpotong atau di-spill. |
| Eskalasi effort (6) | `effortTier` naik dan di-log. Parameter model tidak berubah. |
| `reasoning-backpressure` (71) | Dilaporkan dari queue depth yang kamu kasih, tidak diukur sendiri. Spec 55 yang mengukur antrean sungguhan. |
| Progress reporting (4) | Jejak progres run tercatat dan ditampilkan. Menarasi transisi stage dan kegagalan gate. Baris per-step sengaja tidak ada. |
| `idempotency` (19) | Cache berlaku pada tool murni. Tool `effectful` selalu re-execute. |

**Kesimpulan:** jangan pakai paket ini sebagai sandbox atau approval mechanism.
Ini ledger, classifier, dan discipline helper. Pembatasan yang benar-benar
mengikat adalah permission DSH sendiri.

---

## 6. Config

Config opsional dan partial. `resolveConfig` melakukan deep-merge config kamu
di atas default lengkap, lalu validasi fail-loud. Cukup tulis blok yang mau
diubah.

Yang ditolak saat load: `config:` yang ada tapi bukan object, key asing di
level mana pun, tipe salah, threshold context yang tidak urut, dan counter
pecahan. Semuanya jadi `ConfigError` dengan path field yang tepat.

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

Contoh config partial, ditulis di blok `config:` pada `cordis.patch.yml`:

```yaml
- id: fable-5-1
  config:
    budget:
      stageTokenBudget: 250000
    reasoning:
      maxConcurrentPasses: 8
```

---

## 7. Pasang & restart

```sh
# di direktori profile
pnpm install
dsh --profile <nama> --dump-config   # entry id harus muncul: fable-5-1
```

Entry id yang terlihat di log boot: `fable-5-1 loaded, 92 tools registered`.
Kalau baris itu tidak muncul, salah satu service yang di-inject belum ada
(`tools`, `llm`, `sessions`). Plugin lalu menunggu, bukan gagal diam-diam.

Restart DSH setelah build. `lib/` di-cache saat boot, jadi host yang jalan
memakai artifact lama sampai restart.

---

## 8. Batas yang harus kamu tahu

1. **Audit trail per-host, budget per-session.** Satu `ctx.fable51` melayani
   semua session di host: worklog, cost ledger, reason cache, snapshot store,
   dan lineage berbagi. Audit jangka panjang memang di level host, dan
   `fable51 inspect` menampilkan gambaran itu. Yang menegakkan run (stage token
   budget, jatah fork/merge, escalation ladder, replan count, effort tier,
   convergence window) di-key per session. `turn/start` hanya me-reset budget
   session-nya sendiri.

   Identitas session datang dari host: `Agent.session.id` untuk pre-step hook
   dan eksekusi tool, `GenerateOptions.sessionId` untuk stream hook, dan objek
   session untuk event lifecycle. Call yang tidak diatribusikan host masuk ke
   bucket `default` tersendiri, yang tidak di-reset turn session mana pun.

2. **Host dispatch paralel hanya untuk tool yang mendeklarasikan
   `isConcurrencySafe`.** Tool `read` milik host punya, tool `fable51_*` milik
   bundle ini tidak. Jadi beberapa tool `fable51_*` yang dipanggil sekaligus
   berjalan berurutan, sementara tool host yang ditandai berjalan paralel dan
   **tetap terikat cap**: satu sesi headless dengan lima `read` paralel
   melaporkan `peak` 4 pada cap 4. Cap-nya per session, jadi dua session di
   host yang sama masing-masing mendapat jatah penuh; host punya cap sendiri
   (`maxParallelToolCalls`, default 10) dan yang lebih kecil dari dua cap itu
   yang mengikat.

   Jalur agent-loop penuh sudah dieksekusi end-to-end pada 2026-10-20 lewat
   `dsh --profile fable-test headless`.

3. **Tidak ada CI dan tidak ada lockfile.** Yang dijalankan host adalah apa pun
   yang ter-build lokal. `lib/` tidak masuk git.

4. Registry memeriksa bahwa tool mendeklarasikan blok `output` dan nilai
   balik cocok dengan output schema. Registry **tidak** memvalidasi argumen
   input. Skema yang salah ketahuan saat return, bukan saat registrasi.

---

## 9. Perintah verifikasi

```sh
pnpm test        # unit + integration + e2e (node:test via tsx)
pnpm typecheck   # tsc -b, lalu project test
pnpm build       # emit lib/, termasuk lib/cli.js
```

---

## Yang sudah diverifikasi, dan yang belum

**Diverifikasi sesi ini:** 92 tool terbaca dari `src/tools/*.ts` dan partisi
kelompok di §4 cocok persis; `src/config/defaults.ts` dibaca langsung;
fungsi `sandbox-boundaries` dipanggil live (read/write); `context-management`,
`determinism`, `verification-gates` dipanggil live; `dsh --help` dipanggil
untuk sintaks boot.

**Diverifikasi saat menambah visualizer + budget advisor:** `pnpm test`
menjalankan seluruh suite (sekarang 283 test di 96 suite) dan semuanya lulus (unit + integration + e2e);
`pnpm typecheck` exit 0; `pnpm build` memancarkan `lib/` termasuk `lib/cli.js`;
`node bin/fable51.js inspect` dan `node bin/fable51.js advise-budget <taskClass>`
dijalankan live keluar ASCII dan JSON.

**Diverifikasi saat menambah isolasi per-session:** reproduksi bug
cross-session (session A `turn/start` menghapus stage budget session B)
dijalankan live sebelum perbaikan dan menunjukkan angka session B terhapus;
setelah perbaikan `test/unit/session-isolation.spec.ts` mengunci lima
perilaku: reset satu session tidak menyentuh session lain, tiap session punya
budget dan jatah fork sendiri, dan bucket tanpa atribusi session bukan
wildcard.

**Diverifikasi saat mengisi spec 4 dan 55:** `test/unit/progress-bandwidth.spec.ts`
mengunci sepuluh perilaku: tiga step dalam satu turn menghasilkan satu baris
progress, turn baru menghasilkan baris baru, gate gagal dinarasi sekali dan
hanya di session-nya, gate lolos tidak masuk jejak, call paralel di atas
`maxConcurrentPasses` **antre** (bukan ditolak) dan semuanya tetap jalan,
slot dilepas saat call selesai, dan call nested tidak pernah menunggu slot.

**Diverifikasi lewat agent loop sungguhan (2026-10-20), `dsh --profile
fable-test headless`:** model memanggil `fable51_chain-vs-tree` dan menerima
envelope asli `{ok:true, spec:"35", output:{topology:"tree", branchFactor:2},
verdict:"verified", unverified:[], rerun:false, gates:[]}` dari log sesi
(seq 20 `tool/call`, seq 21 `tool/result`). Run kedua memanggil
`fable51_verification-gates` dengan hasil FAIL lalu `fable51_inspect`, dan
`progress` berisi tepat satu `stage-transition` ("turn 1 started") dan satu
`gate-fail` ("1 verification gate(s) failed"): dua hal yang memang harus
dinarasi, dan tidak ada baris per-step. Run ketiga memaksa dua tool call
dalam satu pesan assistant. Log sesi menunjukkan keduanya didispatch berurutan,
jadi cap bandwidth tidak aktif pada jalur model.

**Diverifikasi saat menambah validasi `--format` di CLI (2026-10-20):**
`pnpm test` menjalankan 283 test di 96 suite, semuanya lulus; `pnpm typecheck`
exit 0; `pnpm build` exit 0; `node bin/fable51.js inspect --format asdf` keluar
1 dengan pesan `--format must be json or ascii`; `--format=json` diterima;
`--format` tanpa nilai keluar 1 dengan pesan `--format requires a value: json
or ascii`.

**Diverifikasi saat menutup gap peer dependensi (2026-10-21):**
`dsh-system-prompt` dideklarasikan sebagai peer optional dengan range
`>=0.2.0-rc.2`, sama dengan `dsh-llm` dan `dsh-session` yang juga hanya
dipakai entry CLI. `schemastery` dideklarasikan sebagai peer wajib dengan range
`^3.18.4`, karena jalur plugin memakainya untuk schema `Config`. `test/unit/package-deps.spec.ts` mengunci aturan itu: setiap
import runtime harus terdeklarasi di `dependencies` atau `peerDependencies`,
dan test itu gagal di manifest lama dengan pesan `runtime imports missing from
dependencies and peerDependencies:` diikuti nama paketnya, `dsh-system-prompt`
untuk gap pertama dan `@deepseek-ai/schemastery` untuk gap kedua.

**Diverifikasi setelah restart host (2026-10-21):** host web yang berjalan
waktu itu adalah PID 267169, start 01:08:27. Artifact `lib/` terakhir dibangun
00:15:26, jadi 53 menit lebih tua dari host, dan symlink
`$DSH_HOME/profiles/web/node_modules/fable-5-1-dsh` menunjuk repo yang sama.
Impor langsung `lib/tools/index.js` menghitung 92 tool terdaftar, termasuk
`inspect` dan `budget-advisor`. Dua call diagnostik §1 dijalankan dari dalam
agent dan keduanya menjawab bentuk yang benar: `sandbox-boundaries` melempar
menjadi `ok:false` dengan pesan sandbox escape, dan `verification-gates`
membalas `verdict:"unverified"` untuk gate yang gagal.

**Diverifikasi dengan cost ledger terisi (2026-10-21):** satu sesi headless
memanggil `fable51_chain-vs-tree` dua kali, `fable51_verification-gates` dengan
hasil FAIL, lalu `fable51_inspect` dan `fable51_budget-advisor`. Advisor
membaca ledger sungguhan: `sampleSize` 4, tiga stage dengan kuantil nyata
(`tool:fable51_inspect` p90 415 token, `tool:fable51_verification-gates` p90 82,
`tool:fable51_chain-vs-tree` p90 44 dengan count 2), dan stage dominan disebut
di rationale. `test/unit/budget-advisor.spec.ts` mengunci perhitungannya:
sepuluh booking 200.000 token menghasilkan `stageTokenBudget` 1.000.000 untuk
kelas `open` (200.000 dikali 5.0), bukan default ledger kosong.

**Diverifikasi bahwa antrean bandwidth benar-benar mengikat di host nyata
(2026-10-21):** satu sesi headless mengirim lima panggilan `read` dalam satu
pesan assistant. Host dispatch-nya paralel, karena `read` mendeklarasikan
`isConcurrencySafe`. `fable51 inspect` melaporkan `peak` 4 dengan cap 4, jadi
cap itu mengikat jalur tersebut: yang kelima menunggu slot, bukan ditolak. Log
sesi menunjukkan kelima `read` itu keluar dalam satu pesan, dan
`step` yang sama.

**Defect yang ditemukan dan diperbaiki saat itu (2026-10-21):** versi pertama
mengambil slot di waterfall `tools/pre-execute` dan melepaskannya saat
`tools/result`. Itu membuat host **macet**: host menunggu prepare setiap call
sebelum memulai call berikutnya, sementara hasil call baru dinotifikasi saat
commit, dan commit terjadi di belakang await itu. Call yang sudah jalan
selesai, tapi hasil-nya tidak pernah di-commit, jadi slot tidak pernah lepas.
Sesi headless dengan lima `read` paralel menggantung lebih dari 220 detik.
Slot sekarang diambil dan dilepas di dalam waterfall `tools/execute`, yang
membingkai body tool, jadi pelepasannya dijamin terjadi saat dispatch.
`test/unit/progress-bandwidth.spec.ts` mengunci itu: dengan desain lama, test
tersebut menggantung dan dibunuh runner.

**Belum diverifikasi:** tool selain yang disebut di atas tidak dipanggil
langsung.
