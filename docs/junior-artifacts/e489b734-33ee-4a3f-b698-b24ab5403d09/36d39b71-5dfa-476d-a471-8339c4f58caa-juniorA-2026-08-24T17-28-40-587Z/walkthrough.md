Walkthrough Artifact: Documented in
walkthrough.md
and tracked on branch at
docs/reviews/walkthrough-ntfy.md
.
Exact Measured Citations:
Feature commit 1bbee8d: 15 files changed, 844 insertions(+), 11 deletions(-)
Full stack tip (f349a13 vs base main): 22 files changed, 1032 insertions(+), 19 deletions(-)
Key Specifications Verified:
Settings Schema & UI: NtfySettingsDTO / SaveNtfySettingsRequest in
contract.ts
, GET/POST /api/settings/ntfy in
server.ts
, Settings card in
render.js
and
app.js
. Default: https://ntfy.sh, 400 INVALID_URL on invalid schemes.
NtfyClient:
ntfy.ts
POSTs to <server>/<topic> behind test seam
ntfy-seam.ts
with zero live network calls in the test suite.
Transition Hook: Hooked in
machine.ts
post-commit on blocked and done transitions without affecting the done-gate invariant.
Payload Contents: Formats Task ID: <id>, Title: <title>, Status: <state>, Reason: <reason> with priority/tag headers.
Persistence: Persisted transactionally in bureau_meta.
Credential Hygiene: Topics are treated as credential-class addresses;
notifyTaskStateChange
journals topicConfigured: true without exposing raw topic strings.
Verification Results:
Feature Tests (12/12 passing): tc_ntfy_client.test.ts (4), tc_ntfy_settings_api.test.ts (4), tc_ntfy_task_notifications.test.ts (4).
Full Suite: 355/355 tests passing across 84 files, npm run build (tsc --noEmit) clean.
Mutation Proofs: M-NTFY-1 (payload formatting), M-NTFY-2 (blocked dispatch), and M-NTFY-3 (persistence) recorded in
docs/mutation-evidence-phase7.md
.
0 Files With Changes
Review Changes
