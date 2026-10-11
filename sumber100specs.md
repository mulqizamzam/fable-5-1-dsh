1. fable-5-1-context-management
   Kelola window context: kapan compact, kapan drop, kapan spill ke file.
   Trigger: "context window", "compaction", "context overflow", "long session".

2. fable-5-1-subagent-contracts
   Kontrak antar sub-agent: input schema, output schema, no spawn chain.
   Trigger: "subagent", "worker contract", "delegation schema".

3. fable-5-1-tool-call-batching
   Enforce parallel tool-call batching. Batch independent calls, sequence dependent ones.
   Trigger: "batch tool calls", "parallel calls", "tool loop", "agent latency".

4. fable-5-1-progress-reporting
   Format opening line, interim update, closing recap. Sesuai default Fable 5.1 yg minim update.
   Trigger: "progress update", "status report", "recap".

5. fable-5-1-verification-gates
   Desain gate yg bisa FAIL: file exist, test pass, source fetched, diff vs spec.
   Trigger: "verification", "gate", "cold check", "audit trail".

6. fable-5-1-effort-escalation
   Auto-escalate effort saat task search-dependent atau multi-hop. Cegah under-search di low effort.
   Trigger: "escalate", "effort switch", "adaptive effort".

7. fable-5-1-research-provenance
   Track sumber: mana dari fetch, mana dari memori. Wajib tandai.
   Trigger: "provenance", "source tracking", "citation", "no memory".

8. fable-5-1-spec-clarification
   Kapan stop dan tanya user: replan ketiga, spec ambigu, requirement konflik.
   Trigger: "ambiguous spec", "clarify", "ask user", "blocked".

9. fable-5-1-artifact-contracts
   Definisi artifact per stage: path, shape, schema, checksum.
   Trigger: "artifact", "output contract", "stage output".

10. fable-5-1-session-handoff
    Handoff antar sesi: stage map disimpan, state file, resume protocol.
    Trigger: "handoff", "resume", "multi-session", "state file".

11. fable-5-1-cost-accuracy-tradeoff
    Mapping task class → effort tier → expected cost vs accuracy curve.
    Trigger: "cost", "accuracy", "budget", "tradeoff".

12. fable-5-1-anti-introspection
    Klaim "sudah diverifikasi" tidak dihitung. Harus ada artifact + command.
    Trigger: "introspection", "false verify", "self-report".

13. fable-5-1-worklog-format
    Format worklog final: stage, output, check, verdict, unverified list.
    Trigger: "worklog", "delivery summary", "final report".

14. fable-5-1-replan-budget
    Batas replan: 2 max. Eskalasi ke user saat replan ketiga.
    Trigger: "replan", "replan budget", "spec broken".

15. fable-5-1-parallel-vs-sequential-reasoning
    Bedakan reasoning paralel vs sekuensial. Interleaved thinking bukan parallel reasoning.
    Trigger: "parallel reasoning", "sequential reasoning", "interleaved thinking".

16. fable-5-1-cold-verifier-isolation
    Isolasi verifier: no access ke producer reasoning, spec-only input.
    Trigger: "cold verifier", "isolation", "verifier access".

17. fable-5-1-stage-graph-dag
    Representasi stage sebagai DAG, bukan list linear. Deteksi cycle.
    Trigger: "dag", "stage graph", "dependency graph".

18. fable-5-1-rollback-protocol
    Rollback ke stage sebelumnya saat downstream gagal.
    Trigger: "rollback", "revert stage", "undo".

19. fable-5-1-idempotency
    Pastikan stage bisa diulang tanpa efek samping.
    Trigger: "idempotent", "repeatable", "safe retry".

20. fable-5-1-partial-delivery
    Deliver hasil sebagian saat stage terakhir UNVERIFIED.
    Trigger: "partial delivery", "incomplete", "unverified delivery".

21. fable-5-1-timeboxing
    Batas waktu per stage. Aksi saat timebox habis.
    Trigger: "timebox", "deadline", "time budget".

22. fable-5-1-token-budget-per-stage
    Alokasi token per stage, alert saat overshoot.
    Trigger: "token budget", "per-stage tokens", "overshoot".

23. fable-5-1-conflict-resolution
    Resolusi konflik antar requirement atau antar sub-agent output.
    Trigger: "conflict", "requirement clash", "disagreement".

24. fable-5-1-observability
    Logging, tracing, metrics per stage. Format trace minimal.
    Trigger: "observability", "tracing", "logging", "metrics".

25. fable-5-1-determinism
    Reproducibility: seed, fixed order, pinned versions.
    Trigger: "deterministic", "reproducible", "seed".

26. fable-5-1-sandbox-boundaries
    Batas sandbox: apa boleh, apa tidak, escape detection.
    Trigger: "sandbox", "boundaries", "isolation".

27. fable-5-1-human-in-the-loop
    Kapan minta approval manusia sebelum stage berbahaya.
    Trigger: "human approval", "hitl", "confirm before".

28. fable-5-1-escalation-ladder
    Urutan eskalasi: retry → replan → downgrade → ask user.
    Trigger: "escalation", "ladder", "escalate to user".

29. fable-5-1-dependency-pinning
    Pin versi tool, library, API. Deteksi drift.
    Trigger: "pin version", "drift", "dependency".

30. fable-5-1-postmortem-format
    Format postmortem setelah run: what went wrong, what to change.
    Trigger: "postmortem", "retrospective", "what went wrong".

31. fable-5-1-reasoning-forking
    Fork reasoning pass independen: kapan fork, kapan merge, kapan buang.
    Trigger: "fork reasoning", "reasoning branch", "merge reasoning".

32. fable-5-1-hypothesis-pruning
    Pruning hipotesis setelah eksplorasi paralel tanpa kehilangan kandidat valid.
    Trigger: "hypothesis pruning", "candidate pruning", "explore then prune".

33. fable-5-1-interleaved-budget
    Alokasi token untuk interleaved thinking per tool call. Cegah overthinking.
    Trigger: "interleaved budget", "thinking per call", "overthinking".

34. fable-5-1-reasoning-dag
    Representasi reasoning pass sebagai DAG. Deteksi dependency implisit.
    Trigger: "reasoning dag", "reasoning graph", "dependency reasoning".

35. fable-5-1-chain-vs-tree
    Kapan pakai chain-of-thought linear, kapan tree-of-thought bercabang.
    Trigger: "chain of thought", "tree of thought", "linear vs branching".

36. fable-5-1-verifier-forking
    Fork verifier terisolasi dari producer reasoning. Aturan input spec-only.
    Trigger: "verifier fork", "isolated verifier", "spec-only input".

37. fable-5-1-parallel-tool-feed
    Batch tool call agar interleaved reasoning punya lebih banyak material per turn.
    Trigger: "tool feed", "batch feed", "interleaved material".

38. fable-5-1-reasoning-checkpoint
    Simpan snapshot reasoning pass untuk resume atau audit.
    Trigger: "reasoning checkpoint", "snapshot", "audit reasoning".

39. fable-5-1-contradiction-detection
    Deteksi kontradiksi antar reasoning pass paralel sebelum merge.
    Trigger: "contradiction", "conflict reasoning", "merge conflict".

40. fable-5-1-confidence-scoring
    Skor confidence per reasoning pass. Merge pakai skor, bukan mayoritas.
    Trigger: "confidence", "score reasoning", "weighted merge".

41. fable-5-1-speculative-execution
    Eksekusi spekulatif reasoning pass yang belum pasti dibutuhkan. Buang kalau tak terpakai.
    Trigger: "speculative", "prefetch reasoning", "wasted work".

42. fable-5-1-early-exit
    Kapan hentikan reasoning pass lebih awal saat jawaban sudah konvergen.
    Trigger: "early exit", "convergence", "stop reasoning".

43. fable-5-1-reasoning-cache
    Cache reasoning pass identik antar turn. Hindari recompute.
    Trigger: "reasoning cache", "reuse reasoning", "avoid recompute".

44. fable-5-1-divergence-control
    Batasi divergensi reasoning paralel agar tidak meledak jumlah branch.
    Trigger: "divergence", "branch explosion", "limit branches".

45. fable-5-1-merge-strategy
    Strategi merge hasil reasoning paralel: union, intersection, weighted vote.
    Trigger: "merge strategy", "combine reasoning", "vote merge".

46. fable-5-1-reasoning-rollback
    Rollback reasoning ke checkpoint saat merge gagal.
    Trigger: "reasoning rollback", "revert reasoning", "checkpoint revert".

47. fable-5-1-chain-of-verification
    Rantai verifikasi berlapis: pass 1 hasil, pass 2 cek pass 1, pass 3 cek pass 2.
    Trigger: "verification chain", "layered verify", "check the checker".

48. fable-5-1-independent-replication
    Replikasi reasoning pass independen untuk cek konsistensi. Redundancy, bukan parallelism.
    Trigger: "replication", "redundant reasoning", "consistency check".

49. fable-5-1-reasoning-trace-format
    Format trace reasoning pass: input hash, output hash, dependency ids, verdict.
    Trigger: "reasoning trace", "trace format", "pass metadata".

50. fable-5-1-deadlock-detection
    Deteksi deadlock saat dua reasoning pass saling menunggu output.
    Trigger: "deadlock", "circular dependency", "mutual wait".

51. fable-5-1-reasoning-priority
    Prioritas reasoning pass: mana duluan saat resource terbatas.
    Trigger: "reasoning priority", "scheduling", "resource limited".

52. fable-5-1-abort-criteria
    Kriteria abort reasoning pass yang tidak konvergen dalam budget.
    Trigger: "abort", "non-convergent", "budget exceeded".

53. fable-5-1-reasoning-dedup
    Deduplikasi reasoning pass yang isinya mirip. Hindari kerja ganda.
    Trigger: "dedup reasoning", "similar passes", "redundant work".

54. fable-5-1-hypothesis-scoring
    Skor hipotesis sebelum pruning: evidence count, contradiction count, coverage.
    Trigger: "hypothesis score", "rank hypotheses", "prune by score".

55. fable-5-1-reasoning-bandwidth
    Batas jumlah reasoning pass paralel. Cegah saturasi.
    Trigger: "reasoning bandwidth", "concurrency limit", "saturation".

56. fable-5-1-failure-isolation
    Isolasi reasoning pass gagal agar tidak menular ke pass lain.
    Trigger: "failure isolation", "pass failure", "contain failure".

57. fable-5-1-reasoning-replay
    Replay reasoning pass dari trace untuk debug.
    Trigger: "replay", "debug reasoning", "trace replay".

58. fable-5-1-convergence-criteria
    Definisi formal kapan reasoning paralel dianggap konvergen.
    Trigger: "convergence criteria", "when to stop", "converged".

59. fable-5-1-reasoning-audit
    Audit reasoning pass: mana yg berkontribusi, mana yg dibuang.
    Trigger: "reasoning audit", "contribution", "discarded passes".

60. fable-5-1-reasoning-cost-model
    Model biaya per reasoning pass: token, latency, risk. Untuk scheduling.
    Trigger: "reasoning cost", "pass cost", "scheduling model".

61. fable-5-1-reasoning-topology
    Topologi reasoning: star, chain, mesh, ring. Pilih sesuai task shape.
    Trigger: "reasoning topology", "star", "mesh reasoning".

62. fable-5-1-adaptive-branching
    Branching reasoning adaptif: tambah branch saat ambiguity tinggi, kurangi saat rendah.
    Trigger: "adaptive branching", "dynamic branches", "ambiguity-driven".

63. fable-5-1-reasoning-heatmap
    Heatmap reasoning pass: mana paling banyak makan token, mana paling kontributif.
    Trigger: "reasoning heatmap", "token heatmap", "contribution map".

64. fable-5-1-cross-pass-consistency
    Cek konsistensi antar pass paralel sebelum merge. Deteksi drift.
    Trigger: "cross-pass", "consistency", "drift detection".

65. fable-5-1-reasoning-fingerprint
    Fingerprint reasoning pass untuk deteksi duplikat dan cache hit.
    Trigger: "fingerprint", "reasoning hash", "duplicate detect".

66. fable-5-1-pass-scheduling
    Scheduling reasoning pass: FIFO, priority, shortest-job-first.
    Trigger: "pass scheduling", "scheduler", "job order".

67. fable-5-1-reasoning-window
    Window per pass: berapa turn, berapa token, berapa tool call.
    Trigger: "reasoning window", "per-pass window", "bounded pass".

68. fable-5-1-merge-conflict-resolution
    Resolusi konflik saat merge reasoning paralel: vote, weight, escalate.
    Trigger: "merge conflict", "resolve conflict", "escalate merge".

69. fable-5-1-reasoning-lineage
    Lineage reasoning pass: pass mana turunan pass mana.
    Trigger: "lineage", "reasoning ancestry", "pass tree".

70. fable-5-1-speculative-verify
    Verifikasi spekulatif: verifier jalan sebelum producer selesai.
    Trigger: "speculative verify", "early verify", "prefetch verify".

71. fable-5-1-reasoning-backpressure
    Backpressure saat reasoning pass terlalu banyak antri.
    Trigger: "backpressure", "queue full", "throttle reasoning".

72. fable-5-1-pass-timeout
    Timeout per reasoning pass. Aksi saat lewat batas.
    Trigger: "pass timeout", "reasoning deadline", "timeout action".

73. fable-5-1-reasoning-quorum
    Quorum reasoning: butuh N pass setuju sebelum commit keputusan.
    Trigger: "quorum", "agreement threshold", "vote threshold".

74. fable-5-1-diversity-injection
    Suntik diversitas ke reasoning paralel agar tidak echo chamber.
    Trigger: "diversity", "avoid echo", "diverse passes".

75. fable-5-1-reasoning-decay
    Decay reasoning pass lama: turunkan bobot saat merge kalau sudah stale.
    Trigger: "decay", "stale reasoning", "weight decay".

76. fable-5-1-pass-prioritization
    Prioritas pass: risk-first, uncertainty-first, cost-first.
    Trigger: "pass priority", "risk first", "uncertainty first".

77. fable-5-1-reasoning-snapshot-diff
    Diff antar snapshot reasoning untuk deteksi perubahan.
    Trigger: "snapshot diff", "reasoning diff", "change detect".

78. fable-5-1-reasoning-federation
    Federasi reasoning: pass dijalankan di worker berbeda, hasil digabung.
    Trigger: "federation", "distributed reasoning", "worker merge".

79. fable-5-1-pass-observability
    Observability per pass: log, metric, trace id.
    Trigger: "pass observability", "pass trace", "pass metric".

80. fable-5-1-reasoning-budget-pool
    Pool budget reasoning dibagi antar pass. Cegah satu pass monopoli.
    Trigger: "budget pool", "shared budget", "monopoly prevention".

81. fable-5-1-pass-retry-policy
    Kebijakan retry per pass: max retry, backoff, abort.
    Trigger: "pass retry", "retry policy", "backoff".

82. fable-5-1-reasoning-quarantine
    Karantina pass yang hasilnya mencurigakan sebelum masuk merge.
    Trigger: "quarantine", "suspect pass", "isolate suspect".

83. fable-5-1-pass-checkpoint-strategy
    Strategi checkpoint per pass: tiap turn, tiap N token, tiap milestone.
    Trigger: "checkpoint strategy", "pass checkpoint", "milestone".

84. fable-5-1-reasoning-lane
    Lane reasoning: fast lane, slow lane, verify lane.
    Trigger: "lane", "fast lane", "slow lane".

85. fable-5-1-pass-cancellation
    Cancellation pass yang sudah tidak relevan saat keputusan berubah.
    Trigger: "cancellation", "cancel pass", "abort pass".

86. fable-5-1-reasoning-affinity
    Affinity pass ke worker: pass serupa di worker sama untuk cache hit.
    Trigger: "affinity", "worker affinity", "cache locality".

87. fable-5-1-pass-lineage-prune
    Prune lineage pass yang tidak lagi berkontribusi ke hasil akhir.
    Trigger: "prune lineage", "drop ancestry", "trim tree".

88. fable-5-1-reasoning-deadline-propagation
    Propagasi deadline dari parent pass ke child pass.
    Trigger: "deadline propagation", "parent deadline", "child deadline".

89. fable-5-1-pass-quality-score
    Skor kualitas pass: evidence, coherence, coverage, contradiction.
    Trigger: "quality score", "pass quality", "score pass".

90. fable-5-1-reasoning-warmup
    Warmup pass: pass pendek untuk kalibrasi sebelum pass besar.
    Trigger: "warmup", "calibration pass", "pre-pass".

91. fable-5-1-pass-merge-idempotency
    Merge harus idempotent: merge ulang hasil sama.
    Trigger: "merge idempotency", "repeatable merge", "same result".

92. fable-5-1-reasoning-drift-detection
    Deteksi drift reasoning dari spec seiring pass bertambah.
    Trigger: "drift detection", "spec drift", "goal drift".

93. fable-5-1-pass-dependency-inference
    Infer dependency antar pass dari konten, bukan deklarasi.
    Trigger: "dependency inference", "implicit dependency", "content infer".

94. fable-5-1-reasoning-garbage-collection
    GC pass reasoning yang tidak lagi direferensikan.
    Trigger: "gc", "garbage collect", "orphan pass".

95. fable-5-1-pass-cost-accounting
    Accounting biaya per pass: token, latency, retry, verifier cost.
    Trigger: "cost accounting", "pass cost", "billing pass".

96. fable-5-1-reasoning-fork-merge-budget
    Budget untuk fork-merge: berapa fork, berapa merge, berapa depth.
    Trigger: "fork merge budget", "fork depth", "merge count".

97. fable-5-1-pass-sla
    SLA per pass: latency target, token target, accuracy target.
    Trigger: "pass sla", "latency target", "accuracy target".

98. fable-5-1-reasoning-ab-test
    A/B test reasoning policy: fork-heavy vs chain-heavy.
    Trigger: "ab test", "policy test", "fork vs chain".

99. fable-5-1-pass-migration
    Migrasi pass antar model: reasoning pass pindah dari model A ke model B.
    Trigger: "pass migration", "model migration", "move pass".

100. fable-5-1-reasoning-policy-registry
     Registry policy reasoning: policy mana aktif, versi, owner.
     Trigger: "policy registry", "policy version", "policy owner".
