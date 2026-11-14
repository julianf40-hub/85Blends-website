// The ONE check that decides whether anything may talk to a hosted Supabase project: the admin UI's
// hosted-test mode (server.mjs --backend=hosted-test) and the hosted test harness (tests/hosted/).
// It refuses unless the target is explicitly configured, is not a production project, and the
// caller re-typed its ref. Production refs are supplied by the operator's environment and are never
// committed. Nothing here contacts the network.
//
//   GEAR_HOSTED_TEST_PROJECT_REF     the non-production project ref (20 lowercase letters)
//   GEAR_HOSTED_TEST_URL             exactly https://<ref>.supabase.co
//   GEAR_HOSTED_TEST_CONFIRM         the same ref again, typed by the operator
//   GEAR_PRODUCTION_PROJECT_REFS     comma-separated refs that must NEVER be targeted (required, non-empty)
//   GEAR_HOSTED_TEST_PUBLISHABLE_KEY that project's publishable key (sb_publishable_…); never a secret key

const REF = /^[a-z]{20}$/;

export class HostedTargetRefused extends Error {}

export function hostedTestTarget(env = process.env) {
  const refuse = (why) => { throw new HostedTargetRefused(`hosted test target refused: ${why}`); };
  const ref = String(env.GEAR_HOSTED_TEST_PROJECT_REF ?? '').trim();
  const url = String(env.GEAR_HOSTED_TEST_URL ?? '').trim();
  const confirm = String(env.GEAR_HOSTED_TEST_CONFIRM ?? '').trim();
  const production = String(env.GEAR_PRODUCTION_PROJECT_REFS ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  const key = String(env.GEAR_HOSTED_TEST_PUBLISHABLE_KEY ?? '').trim();

  if (!REF.test(ref)) refuse('GEAR_HOSTED_TEST_PROJECT_REF must be a project ref (20 lowercase letters)');
  if (!production.length) refuse('GEAR_PRODUCTION_PROJECT_REFS must list the production project ref(s), so they can be refused');
  for (const p of production) if (!REF.test(p)) refuse(`GEAR_PRODUCTION_PROJECT_REFS entry "${p}" is not a project ref`);
  if (production.includes(ref)) refuse(`${ref} is a production project`);
  if (url !== `https://${ref}.supabase.co`) refuse(`GEAR_HOSTED_TEST_URL must be exactly https://${ref}.supabase.co`);
  if (confirm !== ref) refuse('GEAR_HOSTED_TEST_CONFIRM must repeat the project ref');
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) refuse('GEAR_HOSTED_TEST_PUBLISHABLE_KEY must be a publishable key (sb_publishable_…); secret keys are never used here');
  for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'GEAR_PUBLISHER_SECRET_KEY']) {
    if (env[name]) refuse(`${name} is set in this environment; hosted tests and the admin UI run without privileged keys`);
  }
  return Object.freeze({ ref, url, publishableKey: key });
}
