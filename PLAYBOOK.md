# PLAYBOOK — cara pakai `fable-5-1-dsh`

Panduan operator. `README.md` menjelaskan apa paketnya; file ini menjelaskan
**bagaimana memakainya** dan apa yang tidak boleh dipercaya.

Status di host ini (diverifikasi 2026-10-14):

| Item | Nilai |
|---|---|
| Profile aktif | `$DSH_HOME/profiles/web` — ada di `dependencies` (`link:`) **dan** `dsh.profile.bundles` |
| Profile uji | `$DSH_HOME/profiles/fable-test` — `dsh-base` + `dsh-headless` + `dsh-ui-director` + bundle ini |
| Entry id | `fable-5-1` |
| Tool | 90 tool `fable51_*` (dari 100 spec; spec 4 `progress-reporting` dan spec 55 `reasoning-bandwidth` tidak diimplementasikan, 8 spec lain hidup sebagai method service yang dipicu hook) |
| HEAD | `32fb562` — *fix: stop the cache from freezing state, stop the envelope certifying blind* |

---

## 0. Baca ini dulu: host yang sedang jalan memuat `lib/` lama

`lib/` ada di `.gitignore`. Host memuat modulnya **sekali saat boot**. Jadi
`pnpm build` tidak mengubah host yang sedang berjalan — harus restart.

Pada sesi saat playbook ini ditulis, host aktif **tidak** menjalankan artifact
terbaru. Dua bukti, keduanya hasil call nyata ke tool yang hidup:

```
// fable51_sandbox-boundaries { operation: "write", path: "…/README.md" }
// allowList.write kosong → allowed:false, escape:true, action:"abort"
{ "ok": true, "verdict": "verified", "output": { "allowed": false, "escape": true, "action": "abort" } }

// fable51_verification-gates { expected: "PASS", actual: "FAIL: …" }
{ "ok": true, "verdict": "verified", "output": { "pass": false, … } }
```

Kode di disk bilang lain:

- [src/tools/ops.ts:231](src/tools/ops.ts#L231) melempar error saat `!allowed && escapeAction === 'abort'`
- [src/tools/shared.ts:112](src/tools/shared.ts#L112) mengubah throw itu jadi `ok:false, verdict:'unverified'`
- [src/tools/shared.ts:68](src/tools/shared.ts#L68) menurunkan `verdict` ke `'unverified'` kalau output punya `pass === false`

Jadi escape tidak melempar, dan `pass:false` justru dicertifikasi `verified` —
persis bug yang HEAD `32fb562` perbaiki. **Kontrak "tool yang tidak bisa
verifikasi tidak balik sebagai verified" belum berlaku di host ini.**

Abaikan bagian ini kalau host kamu memang sudah di-restart setelah `32fb562`.
Cek ulang dengan dua call di atas; kalau `ok:false` / `verdict:"unverified"`,
artifact-nya sudah benar.

---

## 1. Dua jalur pemakaian

### Jalur ringan (default) — lewat skill

Minta skill **`fable-5-1-discipline`**, atau sebut pemicu: *"Fable"*, *"stage
map"*, *"audit trail"*, *"plan this"*, *"research and report"*. Skill itu yang
mengurutkan pemakaian tool — stage map → fork → verifikasi → merge. Kamu tidak
perlu tahu nama toolnya.

### Jalur manual — panggil tool langsung

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

---

## 2. Kontrak hasil

Semua 90 tool balas envelope yang sama:

```json
{ "ok": true, "spec": "5", "output": { … }, "verdict": "verified",
  "unverified": [], "rerun": false, "gates": [] }
```

| Field | Arti |
|---|---|
| `ok:false` | argumen ditolak atau tool gagal — **bukan** throw ke host |
| `spec` | id spec yang ditangani tool itu |
| `output` | isiinnersional, punya `outputSchema` sendiri |
| `verdict` | hanya tool itu yang boleh menurunkannya ke `unverified`; `pass:false` ikut menurunkan |
| `rerun` | `true` kalau hasil diambil dari cache idempotency, bukan dieksekusi ulang |
| `gates` | daftar gerbang yang dideklarasikan tool; dieksekusi tool verifikasi, bukan inline |

Tool `effectful` (yang mengubah state service) **selalu** eksekusi ulang —
cache idempotency hanya berlaku pada perhitungan murni.

---

## 3. Peta 90 tool

Kelompok di bawah ini partisi eksak dari 90 tool (sudah diverifikasi: tidak ada
tool yang hilang, dobel, atau karangan).

| Kelompok | N | Tool |
|---|---|---|
| **Verifikasi & pembuktian** | 11 | `anti-introspection` `artifact-contracts` `chain-of-verification` `cold-verifier-isolation` `early-exit` `independent-replication` `partial-delivery` `speculative-execution` `speculative-verify` `verification-gates` `verifier-forking` |
| **Anggaran, waktu, retry** | 14 | `abort-criteria` `divergence-control` `escalation-ladder` `interleaved-budget` `pass-checkpoint-strategy` `pass-retry-policy` `pass-sla` `pass-timeout` `reasoning-backpressure` `reasoning-budget-pool` `reasoning-window` `replan-budget` `timeboxing` `token-budget-per-stage` |
| **Fork / merge / scheduling** | 17 | `adaptive-branching` `chain-vs-tree` `confidence-scoring` `contradiction-detection` `cross-pass-consistency` `hypothesis-pruning` `hypothesis-scoring` `merge-conflict-resolution` `merge-strategy` `pass-merge-idempotency` `pass-prioritization` `pass-scheduling` `reasoning-federation` `reasoning-forking` `reasoning-lane` `reasoning-priority` `reasoning-topology` |
| **Lineage, checkpoint, GC** | 13 | `deadlock-detection` `failure-isolation` `pass-cancellation` `pass-dependency-inference` `pass-lineage-prune` `pass-migration` `reasoning-checkpoint` `reasoning-dag` `reasoning-garbage-collection` `reasoning-lineage` `reasoning-replay` `reasoning-rollback` `reasoning-snapshot-diff` |
| **Jejak, audit, determinisme** | 11 | `dependency-pinning` `determinism` `idempotency` `observability` `pass-observability` `postmortem-format` `reasoning-dedup` `reasoning-fingerprint` `reasoning-trace-format` `research-provenance` `worklog-format` |
| **Biaya & kualitas** | 8 | `cost-accuracy-tradeoff` `pass-cost-accounting` `pass-quality-score` `reasoning-ab-test` `reasoning-audit` `reasoning-cost-model` `reasoning-drift-detection` `reasoning-heatmap` |
| **Governance & dispatch** | 16 | `conflict-resolution` `context-management` `diversity-injection` `human-in-the-loop` `parallel-tool-feed` `reasoning-affinity` `reasoning-deadline-propagation` `reasoning-decay` `reasoning-quarantine` `reasoning-quorum` `reasoning-warmup` `sandbox-boundaries` `spec-clarification` `stage-graph-dag` `subagent-contracts` `tool-call-batching` |

---

## 4. Yang menahan vs yang cuma lapor

Paling sering disalahpahami — baca sebelum menjadikannya kontrol.

### Benar-benar menahan (3)

| Spec | Mekanisme |
|---|---|
| `sandbox-boundaries` (26) | Escape dicatat ke worklog dengan `verdict:'discarded'`; kalau `escapeAction:'abort'` tool melempar ([src/tools/ops.ts:231](src/tools/ops.ts#L231)), jadi `ok:false` — bukan hasil yang kelihatan pakai. **Allow-list kosong = read boleh, write ditolak.** Allow-list yang dideklarasikan = pencocokan persis, fail-closed. |
| `human-in-the-loop` (27) | Fail-closed: `irreversible`/`external`/`estimatedCost` yang kosong tetap minta persetujuan. **Tetap hanya jalan kalau model memanggilnya** — tidak ada interception otomatis. |
| Isolasi fault hook | Error di `agent/pre-step` atau `llm/stream` dicatat lalu step/stream lanjut. Plugin tidak bisa lagi membatalkan turn. |

### Hanya mengklasifikasi & melapor

| Spec | Konsekuensi |
|---|---|
| `context-management` (1) | Aksi compact/drop/spill diklasifikasi dan di-log. **Tidak ada message list yang terpotong atau di-spill.** |
| Eskalasi effort (6) | `effortTier` naik dan di-log. **Parameter model tidak berubah.** |
| `reasoning-backpressure` (71) | Dilaporkan dari queue depth yang kamu kasih; tidak diukur sendiri. |
| `idempotency` (19) | Cache berlaku pada tool murni; tool `effectful` selalu re-execute. |

**Kesimpulan:** jangan pakai paket ini sebagai sandbox atau approval mechanism.
Ini ledger + classifier + discipline helper. Pembatasan yang benar-benar
mengikat adalah permission DSH sendiri.

---

## 5. Config

Config opsional dan **partial**: `src/config/defaults.ts` melakukan deep-merge
config kamu di atas default lengkap, lalu validasi fail-loud. Jadi cukup tulis
blok yang mau diubah.

Yang ditolak saat load: `config:` yang ada tapi bukan object (`null`, array,
string) → `ConfigError`; key asing di level mana pun; tipe salah; threshold
context tidak urut. Pesannya menyebut field path persisnya.

Default saat ini:

```yaml
context:       { compactAt: 0.70, dropAt: 0.85, spillAt: 0.90, spillPath: '.dsh/fable-spill' }
effort:        { defaultTier: mid, escalateOn: [search, multihop, ambiguity], costCeiling: 2000000 }
budget:        { maxReplans: 2, maxPassRetries: 2, passTimeoutMs: 120000,
                 stageTimeoutMs: 600000, stageTokenBudget: 400000,
                 maxForkDepth: 4, maxForksPerStage: 8, maxMergesPerStage: 8 }
reasoning:     { maxConcurrentPasses: 4, convergenceDelta: 0.02, convergenceTurns: 3,
                 decayLambda: 0.15, quorumThreshold: 0.6 }
determinism:   { seed: 20261011, iterationOrder: stable,
                 pinnedVersions: { dsh: 23c78fcdd5ee0b497a77ca356608c51093c74bb9 } }
sandbox:       { allowList: {}, escapeAction: abort }
hitl:          { requireOnIrreversible: true, requireOnExternal: true, requireAboveCost: 500000 }
observability: { traceLevel: stage, logFormat: line }
registry:      { policies: [] }
```

Contoh patch — mengaktifkan allow-list write supaya `sandbox-boundaries` tidak
menolak setiap write:

```yaml
- insert:
    - id: fable-5-1
      name: fable-5-1-dsh
      config:
        sandbox:
          allowList:
            write:
              - /home/administrator/agent-workspace/dsh-custom/plugins/fable-5-1-dsh
        budget:
          maxReplans: 3
```

Disuplai lewat `cordis.patch.yml` atau overlay profile.

---

## 6. Pasang & restart

```sh
# 1. daftarkan di profile
#    <profile>/package.json
#    dependencies: { "fable-5-1-dsh": "link:/…/fable-5-1-dsh" }
#    dsh.profile.bundles: [ …, "fable-5-1-dsh" ]

# 2. install + WAJIB build (lib/ gitignored, host menjalankan hasil build lokal)
pnpm install
pnpm --dir /home/administrator/agent-workspace/dsh-custom/plugins/fable-5-1-dsh build

# 3. cek bundle-nya compose
dsh --profile web --dump-config          # entry id harus muncul: fable-5-1

# 4. RESTART host — tanpa ini, build baru tidak terpakai
dsh web                                   # atau profile yang kamu jalankan

# 5. cek log: harus muncul
#    fable-5-1 loaded — N tools registered
```

Aktivasi harus dibuktikan, bukan diasumsikan: kalau service wajib (`tools`,
`llm`, `sessions`) belum ada, plugin menunggu diam.

---

## 7. Batas yang harus kamu tahu

1. **State per-host, bukan per-session.** Satu `ctx.fable51` melayani semua
   session di host: worklog, cost ledger, reason cache, snapshot store, lineage,
   dan counter skalar berbagi. `turn/start` dari satu session menghapus stage
   token budget yang masih ditagih session lain; budget fork/merge per-stage
   reset untuk semua orang sekaligus. Kalau beberapa sesi jalan paralel, angka
   ledger bukan angka per-session. Isolasi ini butuh identitas session di
  plumbed ke `ToolRunContext`; belum dikerjakan di bundle ini.

2. **Jalur LLM streaming penuh belum pernah dieksekusi end-to-end** di
   environment build (API key profile scratch invalid — blocker environment,
   bukan perilaku bundle). Semantik hook-covered e2e suite yang memanggil
   dispatcher asli.

3. **Tidak ada CI dan tidak ada lockfile.** Yang dijalankan host = apa pun yang
   ter-build lokal.

4. Registry memeriksa bahwa tool mendeklarasikan blok `output` dan nilai
   balik cocok dengan output schema — **tidak** memvalidasi argumen input.
   Skema yang salah ketahuan saat return, bukan saat registrasi.

---

## 8. Perintah verifikasi

```sh
pnpm test        # unit + integration + e2e (node:test via tsx)
pnpm typecheck   # tsc -b, lalu project test
pnpm build       # emit lib/
```

---

## Yang sudah diverifikasi, dan yang belum

**Diverifikasi sesi ini:** 90 tool terbaca dari `src/tools/*.ts` dan partisi
kelompok di §3 cocok persis; `src/config/defaults.ts` dibaca langsung;
fungsi `sandbox-boundaries` dipanggil live (read/write); `context-management`,
`determinism`, `verification-gates` dipanggil live; `dsh --help` dipanggil untuk
sintaks boot.

**Belum diverifikasi:** `pnpm test`, `pnpm typecheck`, dan `pnpm build` tidak
dijalankan; 87 tool selain yang disebut di atas tidak dipanggil langsung;
perilaku setelah restart host belum diuji — klaim di §0 masih menunggu
konfirmasi restart.
