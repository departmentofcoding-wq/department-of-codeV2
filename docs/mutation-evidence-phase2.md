# Phase 2 Mutation Evidence — Stream B (Junior B)

Every PR names the guard it broke and the test that caught it — real mutation evidence.

---

## T26 — Verifier Send-Back Loop Budget Counter Mutation

- **Guard Tested**: `verify_fixes + 1` counter increment in send-back transaction inside `engine/verify/loop.ts`.
- **Target File**: [`engine/verify/loop.ts`](file:///d:/Dept%20of%20code%20v2/engine/verify/loop.ts#L43)
- **Test File**: [`test/integration/t25_exit_sentence_loop.test.ts`](file:///d:/Dept%20of%20code%20v2/test/integration/t25_exit_sentence_loop.test.ts)

### Mutation Applied
```diff
- const newFixes = task.verify_fixes + 1;
+ const newFixes = task.verify_fixes;
```

### Vitest Failure Output
```text
 FAIL  test/integration/t25_exit_sentence_loop.test.ts > T25: Exit Sentence Send-Back Loop & Re-arm Integration Test > demonstrates the full exit sentence: fail -> send-back -> fail -> send-back -> blocked -> human re-arm -> success
AssertionError: expected +0 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 0

 ❯ test/integration/t25_exit_sentence_loop.test.ts:59:40
     57|       let taskAfter1 = db.get<BureauTaskRow>('SELECT * FROM bureau_tasks WHERE id = ?', taskId);
     58|       expect(taskAfter1?.state).toBe('claimed');
     59|       expect(taskAfter1?.verify_fixes).toBe(1);
       |                                        ^
```

### Result & Restoration
- Mutation caught cleanly by `T25` assertion on `verify_fixes`.
- Restored `engine/verify/loop.ts` to `task.verify_fixes + 1`.
- Verified `test/integration/t25_exit_sentence_loop.test.ts` passed 100% green.
