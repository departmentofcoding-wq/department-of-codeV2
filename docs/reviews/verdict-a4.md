# Senior verdict — A4 (retire fileParallelism band-aid; wall-clock waits → pollUntil)

**Senior:** claude (Claude CLI) · **Branch:** wt/a4-test-determinism · **Verdict:** APPROVE (round 3)

Round 1 REVISE: t4 allDone pollUntil was 25s, shrinking the old 30s budget on the
heaviest test → restored to 30s.
Round 2 REVISE: t36_end_to_end (real-browser, more round-trips than t30) had no
explicit it() timeout, silently riding the global; walkthrough missed it → gave
t36 an explicit 45s timeout + corrected the walkthrough.
Round 3 APPROVE. Senior verified: fileParallelism true + 20→30s timeouts; pollUntil
call sites use `condition || undefined` correctly; t4/t6/t14/t28 conversions
behavior-preserving with headroom; t36 45s; **no resource collision** (all tests
use fs.mkdtempSync isolated dirs/DBs; CDP driver uses --remote-debugging-port=0
dynamic → no port contention); no other unconverted wall-clock loops exposed by
parallelism (t45's loop is a synchronous drain counter, not a timing wait).
