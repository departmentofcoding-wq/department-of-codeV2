# Mutation Evidence Log — Phase 1 Stream B (Tool Replay Requirement T12)

## Overview
This document records the empirical mutation testing evidence for deliverable **B3 / T12: Tool Replay Requirement**.

---

## 1. Mutation Target
- **Target Function**: `parseMessageContent` and `buildLlmHistory`
- **File**: `engine/officers/task_intake_officer.ts`
- **Target Logic**: `msg.role === 'tool'` message parsing into `{ role: 'tool', toolCallId, content }` entries for LLM message history.

---

## 2. Applied Code Mutation

```diff
--- a/engine/officers/task_intake_officer.ts
+++ b/engine/officers/task_intake_officer.ts
@@ -52,11 +52,13 @@ export function parseMessageContent(msg: BureauIntakeMessageRow): LlmMessage | n
         toolCalls: raw.toolCalls ?? []
       };
     }
-    if (msg.role === 'tool') {
-      return {
-        role: 'tool',
-        toolCallId: raw.toolCallId ?? msg.id,
-        content: typeof raw.result === 'string' ? raw.result : JSON.stringify(raw.result ?? raw)
-      };
-    }
+    // MUTATION TEST: omit tool message replay
+    /*
+    if (msg.role === 'tool') {
+      return {
+        role: 'tool',
+        toolCallId: raw.toolCallId ?? msg.id,
+        content: typeof raw.result === 'string' ? raw.result : JSON.stringify(raw.result ?? raw)
+      };
+    }
+    */
```

---

## 3. Observed Mutation Failure Log

Running `npx vitest run test/integration/t12_tool_replay.test.ts` on the mutated codebase produced **4 failed tests out of 4**:

```
 RUN  v3.2.7 D:/Dept of code v2

 ❯ test/integration/t12_tool_replay.test.ts (4 tests | 4 failed) 164ms
   × T12: Tool Replay Requirement ('Fake DB') > replays prior tool_use and tool_result blocks on subsequent turns 33ms
     → expected 0 to be greater than 0
   × T12: Tool Replay Requirement ('Fake DB') > buildLlmHistory includes tool_result entries matching officer tool_use calls 3ms
     → expected undefined to be defined
   × T12: Tool Replay Requirement ('Real node:sqlite') > replays prior tool_use and tool_result blocks on subsequent turns 61ms
     → expected 0 to be greater than 0
   × T12: Tool Replay Requirement ('Real node:sqlite') > buildLlmHistory includes tool_result entries matching officer tool_use calls 65ms
     → expected undefined to be defined

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/integration/t12_tool_replay.test.ts > T12: Tool Replay Requirement ('Fake DB') > replays prior tool_use and tool_result blocks on subsequent turns
 FAIL  test/integration/t12_tool_replay.test.ts > T12: Tool Replay Requirement ('Real node:sqlite') > replays prior tool_use and tool_result blocks on subsequent turns
AssertionError: expected 0 to be greater than 0
 ❯ test/integration/t12_tool_replay.test.ts:94:29
     92| 
     93|     expect(assistantMsgs.length).toBeGreaterThan(0);
     94|     expect(toolMsgs.length).toBeGreaterThan(0);
       |                             ^

 FAIL  test/integration/t12_tool_replay.test.ts > T12: Tool Replay Requirement ('Fake DB') > buildLlmHistory includes tool_result entries matching officer tool_use calls
 FAIL  test/integration/t12_tool_replay.test.ts > T12: Tool Replay Requirement ('Real node:sqlite') > buildLlmHistory includes tool_result entries matching officer tool_use calls
AssertionError: expected undefined to be defined
 ❯ test/integration/t12_tool_replay.test.ts:143:21
    141|     const toolMsg = history.find((m) => m.role === 'tool');
    142| 
    143|     expect(toolMsg).toBeDefined();
       |                     ^

 Test Files  1 failed (1)
      Tests  4 failed (4)
```

---

## 4. Code Restoration & Verification

After reverting the mutation to restore `msg.role === 'tool'` handling, running `npx vitest run test/integration/t12_tool_replay.test.ts` yields **4 passing tests**:

```
 ✓ test/integration/t12_tool_replay.test.ts (4 tests)
 Test Files  1 passed (1)
      Tests  4 passed (4)
```
