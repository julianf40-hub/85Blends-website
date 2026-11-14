#!/usr/bin/env node
// TEST-ONLY self-test of the browser run's failure diagnostics (tools/ui-local-supabase.mjs). Never part
// of the deployment package (deploy/package is an exact allowlist; tests/deploy_package.test.mjs).
//
// Runs the browser script once per deliberate failure mode (GEAR_UI_INJECT_FAILURE) at the FIRST draft
// save, and checks the failure snapshot classifies it from evidence, not from the injected mode:
//   toast-suppressed  the save is persisted; the script waits for a toast that never appears
//   save-blocked      the save request is aborted; the unsaved edit stays in the editor
//   edit-lost         the save request is aborted and the page reloads; the edit is gone
// Each run fails on purpose. This does NOT explain the two unresolved browser timeouts.
//   node tools/ui-diagnostics-selftest.mjs        (local stack running: tools/start-local.sh)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ui-local-supabase.mjs', import.meta.url));
const SEED_TAGLINE = 'Fictional ethanol content sensors';
const expected = {
  'toast-suppressed': (s) => s.classification.startsWith('save PERSISTED') && s.persisted.tagline === s.lastEdit.value && s.page.status === 'Saved',
  'save-blocked': (s) => s.classification === 'save NOT persisted; unsaved edit retained in the editor'
    && s.persisted.tagline === SEED_TAGLINE && s.page.status === 'Unsaved changes' && s.page.editorValue === s.lastEdit.value,
  'edit-lost': (s) => s.classification === 'save NOT persisted; edit not visible in the editor'
    && s.persisted.tagline === SEED_TAGLINE && s.page.editorValue !== s.lastEdit.value,
};
let failures = 0;
for (const [mode, check] of Object.entries(expected)) {
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, GEAR_UI_INJECT_FAILURE: mode }, timeout: 600_000 });
  const out = run.stdout + run.stderr;
  const phase = /phase: (.*)/.exec(out)?.[1] ?? '';
  const line = /snapshot: (\{.*\})/.exec(out)?.[1];
  const snapshot = line ? JSON.parse(line) : null;
  const ok = run.status !== 0 && !!snapshot && check(snapshot) && phase.includes(`[INJECTED: ${mode}]`) && !phase.startsWith(' ›');
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode}: ${snapshot?.classification ?? 'no snapshot'}`);
  console.log(`     phase: ${phase}`);
  console.log(`     evidence: ${JSON.stringify({ persisted: snapshot?.persisted, page: snapshot?.page && { status: snapshot.page.status, editorValue: snapshot.page.editorValue }, typed: snapshot?.lastEdit?.value })}`);
}
console.log(`\n${3 - failures}/3 diagnostic classifications correct`);
process.exitCode = failures ? 1 : 0;
